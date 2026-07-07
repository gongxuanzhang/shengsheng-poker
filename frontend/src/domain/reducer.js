/**
 * 领域模型 reducer(单一事实源的派生入口)。
 *
 *   GameState = reduce(setup, actionLog[..cursor], boardLog)   —— 纯函数,不双持久化派生态。
 *
 * 本文件把「事实源 Hand」演算为某个 cursor 处的 GameState:底池 / 各家投入 / 剩余筹码 /
 * 当前最高下注 / 轮到谁行动 / 是否收敛两人。训练(追加日志 cursor 自增)与复盘(在预填日志
 * 上任意跳点)复用同一实现。类型契约见 ./types.js。
 *
 * ── 下注引擎要点 ────────────────────────────────────────────────────────────
 *   · 每街维护 `pending`(仍需行动的「未盖牌且未全下」玩家集合)。集合空 => 该街结束、发牌进
 *     下一街。任何加注把 pending 重置为「其余在手非全下玩家」(action 重新打开)。
 *   · 单街结束后若仅剩 1 名未盖牌玩家 => 弃牌成局(handOver),无后续决策。
 *   · 一次「短额全下」未达完整加注时,严格德州规则不为已行动者重开再加注权;此处按日志回放
 *     场景做了简化:任何抬高 currentBet 的动作都重开 pending(已行动者仍须补齐跟注)。因由日志
 *     驱动、不会含非法再加注,该简化对金额与结束判定安全。详见 docs/ARCHITECTURE.md 讨论。
 *
 * ── 返回对象上的附加字段(契约外的引擎记账,供 legalActions/UI 消费) ─────────────
 *   GameState 契约字段之外,本 reducer 额外挂:
 *     · `bb`            大盲额(最小下注基准)
 *     · `lastRaiseSize` 当前街最小加注增量(min-raise 依据,无法只从快照还原,故随态携带)
 *   这两者是 legalActions 计算最小下注/加注所必需。建议后续在 types.js 正式登记。
 */

import { preflopOrderIds, postflopOrderIds } from './positions.js';

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const BOARD_COUNT = [0, 3, 4, 5];

/**
 * @param {import('./types.js').HandSetup} setup
 * @param {import('./types.js').DomainAction[]} actionLog
 * @param {number} [cursor] 消费到的 actionLog 下标(默认全量);会被夹在 [0, actionLog.length]
 * @param {import('./types.js').Card[]} [boardLog] 已发公共牌(顺序 flop×3,turn,river)
 * @returns {import('./types.js').GameState} 附加 bb / lastRaiseSize 见文件头
 */
export function reduceGameState(setup, actionLog, cursor = actionLog.length, boardLog = []) {
  const n = Math.max(0, Math.min(cursor, actionLog.length));
  const bb = setup.blinds.bb;

  const players = setup.players.map((p) => ({
    id: p.id,
    position: p.position,
    stack: p.stack,
    committed: 0,
    streetCommitted: 0,
    folded: false,
    allin: false,
  }));
  const byId = new Map(players.map((p) => [p.id, p]));
  const byPosition = new Map(players.map((p) => [p.position, p]));

  const ctx = {
    players,
    byId,
    pot: 0,
    currentBet: 0,
    lastRaiseSize: bb,
    streetIdx: 0,
    order: preflopOrderIds(setup),
    pending: new Set(),
    lastActorIdx: -1,
    handOver: false,
    setup,
  };

  const payIn = (p, amt) => {
    const a = Math.max(0, Math.min(amt, p.stack));
    p.stack -= a;
    p.streetCommitted += a;
    p.committed += a;
    ctx.pot += a;
    if (p.stack <= 0) {
      p.stack = 0;
      p.allin = true;
      ctx.pending.delete(p.id);
    }
  };

  // ── 前注(死钱,不计入 streetCommitted) ──
  const ante = setup.blinds.ante;
  if (ante && ante > 0) {
    for (const p of players) {
      const a = Math.min(ante, p.stack);
      p.stack -= a;
      p.committed += a;
      ctx.pot += a;
      if (p.stack <= 0) { p.stack = 0; p.allin = true; }
    }
  }

  // ── 盲注 ──
  const sb = byPosition.get('SB');
  const bbP = byPosition.get('BB');
  if (sb) payIn(sb, setup.blinds.sb);
  if (bbP) payIn(bbP, bb);
  ctx.currentBet = Math.max(0, ...players.map((p) => p.streetCommitted));

  // 翻前初始 pending:在手且非全下者(盲注短码可能已全下)。
  ctx.pending = new Set(ctx.order.filter((id) => {
    const p = byId.get(id);
    return p && !p.folded && !p.allin;
  }));

  const activeCount = () => players.reduce((s, p) => (p.folded ? s : s + 1), 0);
  const activeNonAllin = (exclId) => ctx.order.filter((id) => {
    if (id === exclId) return false;
    const p = byId.get(id);
    return p && !p.folded && !p.allin;
  });

  const advanceStreet = () => {
    while (ctx.streetIdx < 3) {
      ctx.streetIdx += 1;
      for (const p of players) p.streetCommitted = 0;
      ctx.currentBet = 0;
      ctx.lastRaiseSize = bb;
      ctx.order = postflopOrderIds(setup);
      ctx.lastActorIdx = -1;
      const canAct = activeNonAllin(null);
      if (canAct.length >= 2) {
        ctx.pending = new Set(canAct);
        return; // 该街有决策,等待后续动作
      }
      ctx.pending = new Set(); // 不足两人可行动 => 无下注,继续发牌跑马
    }
    ctx.pending = new Set();
  };

  const applyAction = (action) => {
    const p = byId.get(action.playerId);
    if (!p || p.folded || p.allin) return;
    const idx = ctx.order.indexOf(action.playerId);

    switch (action.type) {
      case 'fold':
        p.folded = true;
        ctx.pending.delete(p.id);
        break;
      case 'check':
        ctx.pending.delete(p.id);
        break;
      case 'call': {
        payIn(p, ctx.currentBet - p.streetCommitted);
        ctx.pending.delete(p.id);
        break;
      }
      case 'bet':
      case 'raise':
      case 'allin': {
        const maxTo = p.streetCommitted + p.stack;
        let toTotal = action.type === 'allin'
          ? maxTo
          : Math.min(action.amount ?? maxTo, maxTo);
        const pay = toTotal - p.streetCommitted;
        if (pay <= 0) {
          // 不构成抬注(如 allin 额 <= currentBet)=> 按跟注处理
          payIn(p, ctx.currentBet - p.streetCommitted);
          ctx.pending.delete(p.id);
          break;
        }
        payIn(p, pay);
        if (p.streetCommitted > ctx.currentBet) {
          const inc = p.streetCommitted - ctx.currentBet;
          ctx.currentBet = p.streetCommitted;
          if (inc >= ctx.lastRaiseSize) ctx.lastRaiseSize = inc;
          ctx.pending = new Set(activeNonAllin(p.id)); // 重开行动
        } else {
          ctx.pending.delete(p.id);
        }
        break;
      }
      default:
        break;
    }
    if (idx >= 0) ctx.lastActorIdx = idx;
  };

  // ── 逐动作消费到 cursor ──
  for (let k = 0; k < n; k += 1) {
    applyAction(actionLog[k]);
    if (activeCount() <= 1) { ctx.handOver = true; break; }
    if (ctx.pending.size === 0) advanceStreet();
  }

  // ── 计算 toActId ──
  let toActId = null;
  if (!ctx.handOver && ctx.pending.size > 0) {
    const len = ctx.order.length;
    for (let k = 1; k <= len; k += 1) {
      const id = ctx.order[(ctx.lastActorIdx + k + len) % len];
      if (ctx.pending.has(id)) { toActId = id; break; }
    }
  }

  const activePlayers = players.filter((p) => !p.folded).map((p) => p.id);

  return {
    street: STREETS[ctx.streetIdx],
    board: boardLog.slice(0, BOARD_COUNT[ctx.streetIdx]),
    pot: ctx.pot,
    currentBet: ctx.currentBet,
    toActId,
    players: players.map((p) => ({
      id: p.id,
      stack: p.stack,
      committed: p.committed,
      streetCommitted: p.streetCommitted,
      folded: p.folded,
      allin: p.allin,
    })),
    activePlayers,
    cursor: n,
    isHeadsUp: activePlayers.length === 2,
    // 附加记账(契约外,见文件头):
    bb,
    lastRaiseSize: ctx.lastRaiseSize,
  };
}
