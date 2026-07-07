/**
 * legalActions(gameState) —— 从 GameState 派生轮到行动方的合法动作集。
 *
 * UI 据此渲染动作栏,DeviationEvaluator 据此把实选动作对齐 GTO 动作。类型契约见 ./types.js
 * 的 LegalAction。金额语义与 DomainAction 一致:bet/raise 的 min/max 是「加注到」的总额
 * (streetCommitted 相对的本街总投入),call/allin 的 amount 是该动作实付/全下总额。
 *
 * 依赖 GameState 上的附加字段 `bb`(最小下注基准)与 `lastRaiseSize`(最小加注增量),
 * 由 reducer 携带(见 reducer.js 文件头);缺失时退化为保守默认。
 */

/**
 * @param {import('./types.js').GameState} state
 * @returns {import('./types.js').LegalAction[]} 空数组表示无人需行动(toActId 为 null)
 */
export function legalActions(state) {
  if (!state.toActId) return [];
  const p = state.players.find((x) => x.id === state.toActId);
  if (!p || p.folded || p.allin || p.stack <= 0) return [];

  const bb = state.bb ?? 1;
  const currentBet = state.currentBet;
  const toCall = Math.max(0, currentBet - p.streetCommitted);
  const allInTo = p.streetCommitted + p.stack; // 全下「到」的总额
  const canExceedCall = p.stack > toCall; // 还能投入超过一次跟注(即能加注/下注)

  /** @type {import('./types.js').LegalAction[]} */
  const actions = [];

  if (toCall > 0) {
    actions.push({ type: 'fold' });
    // 跟注:不足以补齐则全下跟注(amount 即实付)。
    actions.push({ type: 'call', amount: Math.min(toCall, p.stack) });
  } else {
    actions.push({ type: 'check' });
  }

  if (currentBet === 0) {
    // 本街尚无下注 => 可下注(streetCommitted 恒为 0)。
    actions.push({ type: 'bet', min: Math.min(bb, p.stack), max: p.stack });
  } else if (canExceedCall) {
    // 已有下注且能超出跟注 => 可加注。最小加注到 = 当前下注 + 最小加注增量,受全下上限夹取。
    const lastRaiseSize = state.lastRaiseSize ?? bb;
    const minRaiseTo = Math.min(currentBet + lastRaiseSize, allInTo);
    actions.push({ type: 'raise', min: minRaiseTo, max: allInTo });
  }

  // 全下便捷项:仅当全下是「进攻性」(下注/加注)时给出;其额度 = allInTo,与 bet/raise 的 max 一致。
  // (纯跟注型全下已由上面的 call(amount=stack) 覆盖,不重复。)
  if (p.stack > 0 && (currentBet === 0 || canExceedCall)) {
    actions.push({ type: 'allin', amount: allInTo });
  }

  return actions;
}
