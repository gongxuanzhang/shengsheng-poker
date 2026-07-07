/**
 * PostflopSolverPolicy(Phase2 具体实现)—— 翻后策略 = 两人 GTO 引擎会话。
 *
 * 本文件把 gtoPolicy.js 里 `PostflopSolverPolicy` 的接口契约落地为可运行实现:封装 Worker 的
 * open/query/close 会话 API,实现 `GtoPolicy.query(node)` 对翻后节点的「求解 + 树内导航」。
 *
 * 关键杠杆(见 docs/ARCHITECTURE.md §5):一手翻后的所有决策点 = **1 次 solve + N 次近乎免费的
 * query**。首次遇到某 spot 时 `openSpot` 求解一次并缓存 handle;后续每个决策点只 `queryNode`
 * 沿 node.path 导航读值;会话结束 `dispose()` 统一 `closeSpot` 释放。
 *
 * spot 身份(缓存键)= (oopRange, ipRange, board, 该街起始底池, 有效筹码, betSizes)。
 * 同一 spot 的不同 NodePath 复用同一 handle。approximate=false(精确两人 GTO)。
 *
 * 契约见 ../types.js:DecisionNode / NodeResult / NodeStrategy / OpenSpotRequest / RangeAssignment,
 * 以及 solver-wasm 会话 API 语义;接口基类见 ./gtoPolicy.js 的 GtoPolicy。
 *
 * @typedef {import('../types.js').DecisionNode} DecisionNode
 * @typedef {import('../types.js').NodeStrategy} NodeStrategy
 * @typedef {import('../types.js').ActionStrategy} ActionStrategy
 * @typedef {import('../types.js').NodeResult} NodeResult
 * @typedef {import('../types.js').OpenSpotRequest} OpenSpotRequest
 * @typedef {import('../types.js').ActionType} ActionType
 */

import { GtoPolicy } from './gtoPolicy.js'

/** 支撑集阈值:整体频率高于此值才视为「在 GTO 支撑集内」,避免误伤合法低频混合。 */
const SUPPORT_EPS = 0.005

/**
 * 会话客户端契约:{ openSpot, queryNode, closeSpot }。PostflopSolverPolicy 只依赖这三个方法,
 * 与传输层(Comlink Worker / 直接调用 / 测试桩)解耦。
 * @typedef {Object} SolverSession
 * @property {(req: OpenSpotRequest) => Promise<number>}                 openSpot
 * @property {(handle: number, path: number[]) => Promise<NodeResult>}   queryNode
 * @property {(handle: number) => Promise<void>}                         closeSpot
 */

/**
 * 把 Comlink 包装的 solver.worker 远程对象适配成 SolverSession。
 * worker 已 expose { openSpot, queryNode, closeSpot }(见 frontend/src/solver.worker.js),
 * 此处仅做一层显式绑定,固定会话 API 的形状。
 * @param {{ openSpot: Function, queryNode: Function, closeSpot: Function }} worker
 * @returns {SolverSession}
 */
export function createSolverSession(worker) {
  return {
    openSpot: (req) => worker.openSpot(req),
    queryNode: (handle, path) => worker.queryNode(handle, path),
    closeSpot: (handle) => worker.closeSpot(handle),
  }
}

/**
 * 把引擎动作标签(Rust `Action` 的 Debug 形态,如 "Check" / "Bet(28)" / "AllIn(100)")
 * 解析成领域 ActionType + 额度。
 * @param {string} label
 * @returns {{ type: ActionType, amount: (number|undefined) }}
 */
function parseActionLabel(label) {
  const m = /^([A-Za-z]+)(?:\((\d+)\))?$/.exec(label ?? '')
  const kind = (m?.[1] ?? '').toLowerCase()
  const amount = m?.[2] != null ? Number(m[2]) : undefined
  /** @type {Record<string, ActionType>} */
  const typeMap = {
    fold: 'fold',
    check: 'check',
    call: 'call',
    bet: 'bet',
    raise: 'raise',
    allin: 'allin',
  }
  return { type: typeMap[kind] ?? /** @type {ActionType} */ (kind), amount }
}

/**
 * NodeResult(引擎读数)-> NodeStrategy(评估层/UI 统一消费的形状)。
 * frequency 取 overallFreq、ev 取 actionEv(按权重加权的范围值),inSupport 由 frequency 判定。
 * @param {DecisionNode} node
 * @param {NodeResult} raw
 * @returns {NodeStrategy}
 */
function toNodeStrategy(node, raw) {
  const labels = raw.actions ?? []
  /** @type {ActionStrategy[]} */
  const actions = labels.map((label, a) => {
    const { type, amount } = parseActionLabel(label)
    const frequency = raw.overallFreq?.[a] ?? 0
    return {
      label,
      type,
      amount,
      frequency,
      ev: raw.actionEv?.[a] ?? 0,
      inSupport: frequency > SUPPORT_EPS,
    }
  })
  return {
    street: node.street,
    actions,
    source: 'postflop-solver',
    approximate: false, // 精确两人 GTO
    raw,
  }
}

/**
 * 翻后策略实现。构造时注入 SolverSession(通常由 createSolverSession 包装 Worker 得到),
 * 与一份 solve 默认参数(betSizes / maxIter / targetExpl,以及缺省 startingPot / effectiveStack)。
 */
export class PostflopSolverPolicy extends GtoPolicy {
  /**
   * @param {SolverSession} session
   * @param {{ betSizes?: string, maxIter?: number, targetExpl?: number,
   *           startingPot?: number, effectiveStack?: number }} [options]
   */
  constructor(session, options = {}) {
    super()
    this.session = session
    this.options = {
      betSizes: '50%',
      maxIter: 1000,
      targetExpl: 0.5,
      ...options,
    }
    /**
     * spotKey -> Promise<handle>。存 Promise 而非裸 handle,天然去重「同一 spot 的并发 open」,
     * 避免同一局面被求解两次。
     * @type {Map<string, Promise<number>>}
     */
    this.handles = new Map()
  }

  /**
   * 由 DecisionNode 组装 open_spot 入参。范围来自 node.ranges(RangeAssignment,翻前续牌范围填充);
   * 牌面来自 node.state.board;solve 参数优先取 node.spot(领域层可显式附带),否则回退到 options。
   * @param {DecisionNode} node
   * @returns {OpenSpotRequest}
   */
  _requestFromNode(node) {
    const board = node.state?.board ?? []
    if (board.length < 3) {
      throw new Error('PostflopSolverPolicy: 翻后节点缺少 flop(board 少于 3 张)')
    }
    const ranges = node.ranges
    if (!ranges?.oopRange || !ranges?.ipRange) {
      throw new Error('PostflopSolverPolicy: node.ranges 缺失 oopRange/ipRange(需翻前续牌范围)')
    }
    // 领域层可在 node.spot 上显式给出该街 solve 参数;缺省回退到构造 options。
    const spot = node.spot ?? {}
    const startingPot = spot.startingPot ?? node.state?.pot ?? this.options.startingPot
    const effectiveStack = spot.effectiveStack ?? this.options.effectiveStack
    if (startingPot == null || effectiveStack == null) {
      throw new Error('PostflopSolverPolicy: 缺少 startingPot / effectiveStack(node.spot 或 options 提供)')
    }
    return {
      oopRange: ranges.oopRange,
      ipRange: ranges.ipRange,
      flop: board.slice(0, 3).join(''),
      turn: board[3] ?? '',
      river: board[4] ?? '',
      startingPot,
      effectiveStack,
      betSizes: spot.betSizes ?? this.options.betSizes,
      maxIter: spot.maxIter ?? this.options.maxIter,
      targetExpl: spot.targetExpl ?? this.options.targetExpl,
    }
  }

  /**
   * spot 缓存键 —— 唯一决定一次 solve 身份的字段(见 ARCHITECTURE §5)。
   * @param {OpenSpotRequest} req
   * @returns {string}
   */
  _spotKey(req) {
    return [
      req.oopRange,
      req.ipRange,
      req.flop,
      req.turn,
      req.river,
      req.startingPot,
      req.effectiveStack,
      req.betSizes,
    ].join('|')
  }

  /**
   * 取(或首次求解)该 spot 的常驻 handle。并发去重:同一 key 只 open 一次。
   * @param {OpenSpotRequest} req
   * @returns {Promise<number>}
   */
  _ensureHandle(req) {
    const key = this._spotKey(req)
    let pending = this.handles.get(key)
    if (!pending) {
      pending = this.session.openSpot(req)
      this.handles.set(key, pending)
      // open 失败则移除缓存,允许下次重试(否则坏 Promise 永久占位)
      pending.catch(() => {
        if (this.handles.get(key) === pending) this.handles.delete(key)
      })
    }
    return pending
  }

  /**
   * 查询翻后决策点的 GTO 策略:solve 一次(命中缓存则跳过)后沿 node.path 导航读值。
   * @param {DecisionNode} node  预期 node.street ∈ {flop,turn,river} 且 node.state.isHeadsUp
   * @returns {Promise<NodeStrategy>}
   */
  async query(node) {
    const req = this._requestFromNode(node)
    const handle = await this._ensureHandle(req)
    const path = node.path ?? []
    const raw = await this.session.queryNode(handle, path)
    return toNodeStrategy(node, raw)
  }

  /**
   * 释放全部常驻会话(切手/退出训练时调用)。逐个 closeSpot,吞掉个别失败以确保全部尝试释放。
   * @returns {Promise<void>}
   */
  async dispose() {
    const pendings = [...this.handles.values()]
    this.handles.clear()
    await Promise.all(
      pendings.map(async (p) => {
        try {
          const handle = await p
          await this.session.closeSpot(handle)
        } catch {
          /* open 本身失败或已释放,忽略 */
        }
      }),
    )
  }
}
