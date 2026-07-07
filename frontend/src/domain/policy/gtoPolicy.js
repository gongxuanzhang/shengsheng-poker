/**
 * GtoPolicy —— 策略服务层的统一接口(单一事实源)。
 *
 * 主循环只调 `policy.query(node)`,**不按街 if/else**。翻前/翻后的差异被两个
 * 实现藏起来:翻前查固定范围表(毫秒级、无算力问题),翻后走引擎会话(solve 一次、
 * 树内导航)。理论边界:两人翻后有精确 GTO;多人翻后无 GTO(全行业边界);翻前多人
 * 有近似标准范围(查表够用)。详见 docs/ARCHITECTURE.md。
 *
 * 类型契约见 ../types.js:DecisionNode / NodeStrategy / RangeAssignment /
 * OpenSpotRequest / NodeResult,以及会话 API(open_spot/query_node/close_spot)语义。
 *
 * 本文件是 **P0 地基的接口占位**:方法签名 + JSDoc 已定死,实现留给 Phase2 填充
 * (当前抛 NotImplemented)。Phase2 各 agent 以此为对齐基准。
 *
 * @typedef {import('../types.js').DecisionNode} DecisionNode
 * @typedef {import('../types.js').NodeStrategy} NodeStrategy
 * @typedef {import('../types.js').RangeAssignment} RangeAssignment
 * @typedef {import('../types.js').NodeResult} NodeResult
 * @typedef {import('../types.js').OpenSpotRequest} OpenSpotRequest
 * @typedef {import('../types.js').LegalAction} LegalAction
 * @typedef {import('../types.js').ActionStrategy} ActionStrategy
 */

import {
  canonicalHand,
  lookupHandFreqs,
  deriveRangeAssignment,
} from './preflopRanges.js';

const NOT_IMPLEMENTED = 'NotImplemented: 待 Phase2 填充实现';

/**
 * 统一策略接口。所有实现必须满足:输入一个 DecisionNode,输出该节点的 GTO NodeStrategy。
 * @interface
 */
export class GtoPolicy {
  /**
   * 查询某决策节点的 GTO 策略。
   * @param {DecisionNode} node
   * @returns {Promise<NodeStrategy>}  actions 与 node.legalActions 对齐,标 approximate 表明是否降级
   */
  // eslint-disable-next-line no-unused-vars
  async query(node) {
    throw new Error(NOT_IMPLEMENTED);
  }
}

/**
 * 翻前策略:查固定范围表(静态数据,毫秒级,无算力问题)。
 *
 * 职责:
 *   - 按 (位置 × 翻前动作线 × 有效筹码) 查内置范围表,给出 open/call/raise/fold 频率。
 *   - 结果 approximate=true(近似标准范围,非精确 GTO),UI 须标注「翻前对照(标准范围)」。
 *   - **续牌范围**:当一手收敛为两人进入翻后时,输出双方 RangeAssignment 作为翻后 solve 入参。
 *
 * 数据来源:P0 先用一份内置的简化/占位范围(结构正确即可),完善来源作为 TODO。
 */
export class PreflopChartPolicy extends GtoPolicy {
  /**
   * @param {{ lookup?: (position:string, line:string, handKey:string) =>
   *           {raise:number,call:number,check:number,fold:number} }} [chartData]
   *   可选:注入自定义查表函数(缺省用 preflopRanges.js 的内置占位表)。签名与 lookupHandFreqs 一致。
   */
  constructor(chartData) {
    super();
    /** @type {Object|undefined} */
    this.chartData = chartData;
    /** 查表函数:位置×动作线×手牌键 → 动作桶频率。默认内置表,可注入替换。 */
    this.lookup = chartData?.lookup ?? lookupHandFreqs;
  }

  /**
   * 查翻前范围表,返回与 node.legalActions 对齐的 NodeStrategy。approximate=true(近似标准范围)。
   * 需要行动方的**位置**与**底牌**;动作线('rfi'/'bbOption'/'vsRfi'/'vs3bet')优先取
   * node.preflopLine,否则由 node.state 启发式推断(见 _resolveLine)。字段解析见各 _resolve*。
   * @param {DecisionNode} node  预期 node.street === 'preflop'
   * @returns {Promise<NodeStrategy>}
   */
  async query(node) {
    const position = this._resolvePosition(node);
    const holeCards = this._resolveHoleCards(node);
    if (!holeCards) {
      throw new Error(
        'PreflopChartPolicy.query: 缺少行动方底牌(需 node.holeCards 或 node.state.players[].holeCards);' +
        'reducer/deriveDecisionNode 需把行动方 setup.holeCards 透传到节点上',
      );
    }
    const line = this._resolveLine(node, position);
    const villain = this._resolveVillain(node);
    const handKey = canonicalHand(holeCards[0], holeCards[1]);
    // 双维索引:vs-open/vs-3bet 用 hero×villain 查表(A7s SB 对 BTN=3bet、对 UTG=fold);rfi 忽略 villain。
    const bucketFreqs = this.lookup(position, line, handKey, villain);
    const actions = this._mapToLegalActions(node.legalActions || [], bucketFreqs);
    return {
      street: 'preflop',
      actions,
      source: 'preflop-chart',
      approximate: true,
      raw: { position, line, villain, handKey, bucketFreqs },
    };
  }

  /**
   * bot 采样:按频率随机挑一个合法动作(bot 已锁定底牌,故底牌总在)。返回选中的 LegalAction。
   * @param {DecisionNode} node
   * @param {() => number} [rng]  注入随机源(测试用确定性),默认 Math.random
   * @returns {Promise<LegalAction|null>}
   */
  async sampleAction(node, rng = Math.random) {
    const las = node.legalActions || [];
    if (las.length === 0) return null;
    const { actions } = await this.query(node); // 频率与 las 同序等长
    const r = rng();
    let acc = 0;
    for (let i = 0; i < actions.length; i++) {
      acc += actions[i].frequency;
      if (r < acc) return las[i];
    }
    return las[las.length - 1]; // 浮点残差兜底
  }

  /**
   * 收敛到两人翻后时,推导双方续牌范围(RangeAssignment),喂给 PostflopSolverPolicy。
   * 已有 node.ranges 则原样返回(尊重预指派/用户覆盖);否则需 node.continuation =
   * { oop:{position,line,action}, ip:{position,line,action} }(reducer 落地后可自动推导)。
   * @param {DecisionNode} node
   * @returns {RangeAssignment}
   */
  deriveRanges(node) {
    if (node.ranges) return node.ranges;
    const c = node.continuation;
    if (!c || !c.oop || !c.ip) {
      throw new Error(
        'PreflopChartPolicy.deriveRanges: 需要 node.continuation={oop,ip}(各含 position/line/action),' +
        '或已挂 node.ranges;reducer 落地后由翻前动作历史自动推导双方续牌范围',
      );
    }
    return deriveRangeAssignment(c.oop, c.ip);
  }

  // ── 私有:节点字段解析(reducer 落地前的防御性读取,期望字段见抛错信息)──

  /** 行动方位置:node.position → 其 PlayerState.position。 */
  _resolvePosition(node) {
    if (node.position) return node.position;
    const ps = node.state?.players?.find((p) => p.id === node.playerId);
    if (ps?.position) return ps.position;
    throw new Error(
      'PreflopChartPolicy: 无法确定行动方位置(需 node.position 或 node.state.players[].position)',
    );
  }

  /** 行动方底牌:node.holeCards → 其 PlayerState.holeCards。缺失返回 null。 */
  _resolveHoleCards(node) {
    if (Array.isArray(node.holeCards)) return node.holeCards;
    const ps = node.state?.players?.find((p) => p.id === node.playerId);
    if (Array.isArray(ps?.holeCards)) return ps.holeCards;
    return null;
  }

  /**
   * 翻前动作线:优先 node.preflopLine;否则用 currentBet/bb 比值启发式推断加注轮数。
   * 启发式为占位兜底(reducer 未落地),主循环建议显式传 node.preflopLine 以确保准确。
   */
  _resolveLine(node, position) {
    if (node.preflopLine) return node.preflopLine;
    const st = node.state || {};
    const bb = node.blinds?.bb ?? st.blinds?.bb ?? 1;
    const currentBet = st.currentBet ?? bb;
    const ratio = currentBet / bb;
    let raises;
    if (ratio <= 1.0001) raises = 0;
    else if (ratio <= 4.5) raises = 1;
    else raises = 2;
    if (raises === 0) return position === 'BB' ? 'bbOption' : 'rfi';
    if (raises === 1) return 'vsRfi';
    return 'vs3bet';
  }

  /**
   * 对手位(vs-open/vs-3bet 的开池者/3bet 者位置),驱动 hero×villain 双维查表。
   * 优先取训练编排预推导的 node.villain(见 preflopLine.preflopVillain);缺失时回退:
   * 从 node.state 里唯一在手的非行动方推断(HU 场景常见),再不行返回 undefined,由查表层取代表对位。
   */
  _resolveVillain(node) {
    if (node.villain) return node.villain;
    const st = node.state;
    if (st?.players && st.activePlayers) {
      const others = st.activePlayers.filter((id) => id !== node.playerId);
      if (others.length === 1) {
        const ps = st.players.find((p) => p.id === others[0]);
        if (ps?.position) return ps.position;
      }
    }
    return undefined;
  }

  /**
   * 把动作桶频率 {raise,call,check,fold} 映射到具体 legalActions,并按可用动作重归一化。
   * raise/bet/allin 归入 raise 桶(只把 raise 频率给第一个 raise 族动作,其余为 0);
   * 若 raise 桶无对应合法动作(频率流失),归一化把其重量按现有动作重摊,保证分布合法(和为 1)。
   * @param {LegalAction[]} legalActions
   * @param {{raise:number,call:number,check:number,fold:number}} f
   * @returns {ActionStrategy[]}
   */
  _mapToLegalActions(legalActions, f) {
    let raiseTaken = false;
    const rows = legalActions.map((la) => {
      let freq = 0;
      switch (la.type) {
        case 'fold': freq = f.fold; break;
        case 'check': freq = f.check; break;
        case 'call': freq = f.call; break;
        case 'bet':
        case 'raise':
        case 'allin':
          if (!raiseTaken) { freq = f.raise; raiseTaken = true; }
          break;
        default: freq = 0;
      }
      return { la, freq };
    });
    const sum = rows.reduce((s, r) => s + r.freq, 0);
    return rows.map(({ la, freq }) => {
      const frequency = sum > 0 ? freq / sum : (la.type === 'fold' ? 1 : 0);
      return {
        label: this._label(la),
        type: la.type,
        amount: la.amount ?? la.min,
        frequency,
        ev: 0, // 翻前查表无 EV;评估以频率偏差为准(EV 损失恒 0)
        inSupport: frequency > 0,
      };
    });
  }

  /** 动作标签,带额度(若有)。 */
  _label(la) {
    const amt = la.amount ?? la.min;
    switch (la.type) {
      case 'fold': return 'Fold';
      case 'check': return 'Check';
      case 'call': return amt != null ? `Call(${amt})` : 'Call';
      case 'bet': return amt != null ? `Bet(${amt})` : 'Bet';
      case 'raise': return amt != null ? `Raise(${amt})` : 'Raise';
      case 'allin': return amt != null ? `AllIn(${amt})` : 'AllIn';
      default: return String(la.type);
    }
  }
}

/**
 * 翻后策略:引擎会话(两人 GTO)。
 *
 * 职责(关键杠杆 —— 一次 solve 覆盖整条街所有决策节点):
 *   - 首次遇到某翻后 spot 时 `open_spot(req)` 求解一次并缓存 handle(重活,只做一次)。
 *   - 后续每个决策点用 `query_node(handle, node.path)` 沿路径导航读值(微秒~毫秒,近乎免费)。
 *   - 会话生命周期结束(换手/换 spot)时 `close_spot(handle)` 释放常驻 game。
 *
 * spot 身份(缓存键)= (oopRange, ipRange, board, 该街起始底池, 有效筹码, betTree);
 * 同一 spot 的不同 NodePath 共用同一 handle。approximate=false(精确两人 GTO)。
 *
 * @param {Object} session  会话客户端,封装 Worker 的 open_spot/query_node/close_spot
 *                          (通常是 Comlink 包装的 solver.worker),形状对齐会话 API 契约。
 */
export class PostflopSolverPolicy extends GtoPolicy {
  /**
   * @param {{ openSpot: (req: OpenSpotRequest) => Promise<number>,
   *           queryNode: (handle: number, path: number[]) => Promise<NodeResult>,
   *           closeSpot: (handle: number) => Promise<void> }} session
   */
  constructor(session) {
    super();
    this.session = session;
    /** @type {Map<string, number>} spotKey -> handle,复用 solved game */
    this.handles = new Map();
  }

  /**
   * @param {DecisionNode} node  预期 node.street ∈ {flop,turn,river} 且 node.state.isHeadsUp
   * @returns {Promise<NodeStrategy>}
   */
  // eslint-disable-next-line no-unused-vars
  async query(node) {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * 释放全部常驻会话(切手/退出训练时调用)。
   * @returns {Promise<void>}
   */
  async dispose() {
    throw new Error(NOT_IMPLEMENTED);
  }
}

/**
 * 组合策略:按 node.street 分派到翻前表 / 翻后会话。这是主循环实际持有的对象,
 * 让主循环只认 `policy.query(node)` 一个接口。
 */
export class CompositeGtoPolicy extends GtoPolicy {
  /**
   * @param {PreflopChartPolicy}   preflop
   * @param {PostflopSolverPolicy} postflop
   */
  constructor(preflop, postflop) {
    super();
    this.preflop = preflop;
    this.postflop = postflop;
  }

  /**
   * preflop -> 查表;flop/turn/river -> 引擎会话。多人翻后自然被过滤(不进入此路径)。
   * @param {DecisionNode} node
   * @returns {Promise<NodeStrategy>}
   */
  async query(node) {
    return node.street === 'preflop'
      ? this.preflop.query(node)
      : this.postflop.query(node);
  }
}
