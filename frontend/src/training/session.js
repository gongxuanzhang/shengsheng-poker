/**
 * TrainingSession —— 训练对局编排引擎(P1)。把 P0 地基(reducer / decisionNode / policy /
 * evaluator / spot)串成一手可玩流程:标准 6-max 翻前(bot 按范围表采样)+ 翻后收敛两人才进 GTO。
 *
 * 设计要点:
 *   · 事实源 Hand = { setup, actionLog, boardLog }。GameState 恒为 reduce 结果,不双持久化。
 *   · 盲注由 reducer 从 setup 内部计入(不进 actionLog);故 actionLog 起始为空(见 integrationNotes)。
 *   · advance():自动跑 bot,直到轮到 hero 或本手结束;街结束揭示下一街公共牌。
 *   · 翻前→翻后接缝:进翻牌前按存活人数分流——恰两人且双方有筹码 → 翻后 GTO(注入续牌范围,
 *     PostflopSolverPolicy 首查即 solve 一次并持有 handle);3+ 人 → 标注 multiway 无 GTO,跑完
 *     board 直接摊牌,不训练翻后。
 *   · heroAct(action):先 GtoPolicy.query + DeviationEvaluator 生成反馈并记账 → 再落动作 → advance()。
 *   · 结算:7 张牌力评估 + 边池分配(settlement.js)。
 *
 * 依赖注入(便于确定性测试用 mock 策略,不真 solve):
 *   deps = { preflopPolicy, postflopPolicy, evaluator, rng }
 *     preflopPolicy : { query(node), sampleAction(node,rng), deriveRanges(node) }
 *     postflopPolicy: { query(node), dispose() }  仅 HU 翻后训练时用到
 *     evaluator     : { evaluate(chosen, gto, node) }
 *     rng           : () => number(洗牌 + bot 采样共用)
 */

import {
  reduceGameState,
  deriveDecisionNode,
  streetStartingPot,
  effectiveStack,
  rolesForHeadsUp,
} from '../domain/index.js'
import { dealHand } from './deck.js'
import { settle } from './settlement.js'
import { computePreflopLine, deriveContinuation, preflopVillain } from './preflopLine.js'

const STREET_IDX = { preflop: 0, flop: 1, turn: 2, river: 3 }
const BOARD_COUNT = [0, 3, 4, 5]

/** 标准 6-max 位置环(翻前行动序);buttonPosition 固定为 'BTN'。 */
const SIX_MAX_POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB']

export class TrainingSession {
  /**
   * @param {{
   *   preflopPolicy: { query:Function, sampleAction:Function, deriveRanges:Function },
   *   postflopPolicy?: { query:Function, dispose?:Function },
   *   evaluator: { evaluate:Function },
   *   rng?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.preflopPolicy = deps.preflopPolicy
    this.postflopPolicy = deps.postflopPolicy
    this.evaluator = deps.evaluator
    this.rng = deps.rng ?? Math.random
    /** 翻后 solve 默认参数(供 node.spot 透传给 PostflopSolverPolicy)。 */
    this.betSizes = deps.betSizes ?? '50%'
    this._resetHand()
  }

  // ═══════════════════════════ newHand ═══════════════════════════

  /**
   * 起一手新对局:建 6 座、盲注、发底牌与预留公共牌、初始化事实源。不自动推进(调用方随后 advance)。
   * @param {Object} [opts]
   * @param {string} [opts.heroPosition] hero 座位位置(缺省随机 6 选 1)
   * @param {{sb:number,bb:number}} [opts.blinds] 缺省 {sb:1,bb:2}
   * @param {number} [opts.stack] 每座开局筹码,缺省 100bb(=100*bb)
   * @param {Record<string,[string,string]>} [opts.forcedHoles] 位置->底牌(测试造牌;键为位置)
   * @param {string[]} [opts.forcedBoard] 指定公共牌(≤5)
   * @returns {import('../domain/types.js').HandSetup}
   */
  newHand(opts = {}) {
    this._resetHand()
    const blinds = opts.blinds ?? { sb: 1, bb: 2 }
    const stack = opts.stack ?? blinds.bb * 100 // 翻前深度固定 100bb
    const heroPosition = opts.heroPosition
      ?? SIX_MAX_POSITIONS[Math.floor(this.rng() * SIX_MAX_POSITIONS.length)]

    // 座位:位置即 id(单桌唯一),便于 forced/调试可读。
    const players = SIX_MAX_POSITIONS.map((pos) => ({
      id: pos,
      position: pos,
      stack,
      isHero: pos === heroPosition,
      isBot: pos !== heroPosition,
    }))

    // 发牌(forcedHoles 键为位置=座位 id)。
    const { holes, board } = dealHand(
      players.map((p) => p.id),
      { rng: this.rng, forcedHoles: opts.forcedHoles, forcedBoard: opts.forcedBoard },
    )
    for (const p of players) p.holeCards = holes[p.id]

    /** @type {import('../domain/types.js').HandSetup} */
    const setup = {
      players,
      blinds,
      buttonPosition: 'BTN',
      heroId: heroPosition,
      effectiveStack: stack,
    }
    this.setup = setup
    this._fullBoard = board // 预留 5 张,按街揭示
    this.actionLog = []
    this.boardLog = []
    this._state = this._reduce()
    return setup
  }

  // ═══════════════════════════ advance ═══════════════════════════

  /**
   * 自动推进:bot 采样落子、街结束揭示公共牌、接缝分流;直到轮到 hero(挂起等 heroAct)或本手结束。
   * 翻后 query 走 Worker(async),故整体 async。
   * @returns {Promise<void>}
   */
  async advance() {
    if (this.handOver) return
    // 防御性无限循环护栏(一手动作/发牌步数远小于此)。
    for (let guard = 0; guard < 5000; guard++) {
      const state = this._reduce()
      this._state = state

      // 1) 弃牌成局:仅剩一人在手。
      if (state.activePlayers.length <= 1) {
        await this._endHand('fold')
        return
      }

      // 2) 新街需揭示公共牌(reducer 依下注推断街,board 由本层按街补齐)。
      const need = BOARD_COUNT[STREET_IDX[state.street]]
      if (this.boardLog.length < need) {
        const prevLen = this.boardLog.length
        this._revealBoardTo(need)
        if (prevLen === 0 && need >= 3) this._handleFlopSeam(state) // 翻前→翻后接缝
        this._postflopPath = [] // 每街引擎导航路径独立(每街单独 solve)
        continue
      }

      // 3) multiway 无 GTO:翻后不训练,跑完 board 直接摊牌。
      if (this._runoutOnly && state.street !== 'preflop') {
        this._revealBoardTo(5)
        await this._endHand('multiway-no-gto')
        return
      }

      // 4) 无人可行动(全下跑马 / 街末摊牌):揭满 board 后摊牌。
      if (state.toActId == null) {
        this._revealBoardTo(5)
        await this._endHand('showdown')
        return
      }

      // 5) 有人行动:构造决策节点。
      const node = this._enrich(deriveDecisionNode(state, this.setup))
      if (node.isHero) {
        this._pendingNode = node
        return // 挂起,等 heroAct
      }

      // 6) bot 落子。
      const action = await this._botAct(node)
      this.actionLog.push(action)
    }
    throw new Error('TrainingSession.advance: 超出推进步数护栏(疑似死循环)')
  }

  // ═══════════════════════════ heroAct ═══════════════════════════

  /**
   * hero 提交动作:先对照 GTO 生成反馈并记账,再落动作,推进。
   * @param {import('../domain/types.js').LegalAction|import('../domain/types.js').DomainAction} inputAction
   * @returns {Promise<Object>} 本次决策的反馈结果(见 feedbackHistory 元素)
   */
  async heroAct(inputAction) {
    const node = this._pendingNode
    if (!node) throw new Error('heroAct: 当前非 hero 回合(无挂起决策节点)')
    if (this.handOver) throw new Error('heroAct: 本手已结束')

    const action = this._normalizeHeroAction(node, inputAction)

    // 1) GTO 反馈(preflop 查表 / postflop 引擎)。
    let feedback = null
    try {
      const gto = node.street === 'preflop'
        ? await this.preflopPolicy.query(node)
        : await this.postflopPolicy.query(node)
      // 翻后:求解树只含有限档下注尺寸(betSizes + allin)。hero 若下非引擎档位的额度,
      // 先把 amount 就近吸附到匹配档位的引擎额度,再评估/落子/记路径——保证 reducer 实际
      // 下注、评估依据、solver 树内导航三者沿同一条线(否则同街后续节点会沿错误线导航)。
      // 翻前(查表)无此约束,保持自由。
      if (node.street !== 'preflop') {
        const idx = this._matchIndex(action, gto.actions)
        if (idx >= 0) {
          this._snapHeroSizeToTree(action, gto.actions[idx])
          this._postflopPath.push(idx)
        }
      }
      feedback = this.evaluator.evaluate(action, gto, node)
    } catch (err) {
      feedback = { skipped: true, reason: String(err?.message ?? err) }
    }

    const record = {
      street: node.street,
      playerId: node.playerId,
      position: node.position,
      action,
      feedback,
      pot: node.state.pot,
    }
    this.feedbackHistory.push(record)

    // 2) 落动作,清挂起,推进。
    this._pendingNode = null
    this.actionLog.push(this._toHeroDomainAction(node, action))
    await this.advance()
    return record
  }

  // ═══════════════════════════ 对 UI 暴露的读接口 ═══════════════════════════

  /**
   * 当前视图态:GameState 快照 + board + 各家状态 + 谁 toAct + 是否 hero 回合。
   * bot 底牌默认隐藏,本手结束(摊牌)后揭示。
   */
  getViewState() {
    const state = this._state ?? this._reduce()
    const heroId = this.setup?.heroId
    const reveal = this.handOver && this.settlement?.showdownReached
    const seatById = new Map((this.setup?.players ?? []).map((p) => [p.id, p]))
    const players = state.players.map((p) => {
      const seat = seatById.get(p.id)
      const isHero = p.id === heroId
      const showCards = isHero || reveal
      return {
        id: p.id,
        position: seat?.position,
        stack: p.stack,
        committed: p.committed,
        streetCommitted: p.streetCommitted,
        folded: p.folded,
        allin: p.allin,
        isHero,
        holeCards: showCards ? seat?.holeCards : undefined,
      }
    })
    return {
      street: state.street,
      // 揭示到的公共牌:训练层逐街揭示,正常与 state.board 同步;multiway 跑马时 reducer 因
      // 跳过翻后下注仍停在 flop,而 boardLog 已揭满,故以 boardLog 为准(真实已发公共牌)。
      board: this.boardLog.slice(),
      pot: state.pot,
      currentBet: state.currentBet,
      toActId: state.toActId,
      isHeroTurn: Boolean(this._pendingNode),
      isHeadsUp: state.isHeadsUp,
      players,
      handOver: this.handOver,
      handOverReason: this.handOverReason,
      multiway: this._multiway,
      postflopTrained: this._postflopTrained,
      heroId,
    }
  }

  /**
   * 当前 hero 决策(挂起节点 + 合法动作);非 hero 回合返回 null。
   * @returns {import('../domain/types.js').DecisionNode|null}
   */
  getDecision() {
    return this._pendingNode ?? null
  }

  /** 反馈历史(每个 hero 决策一条)。 */
  getFeedbackHistory() {
    return this.feedbackHistory
  }

  isHandOver() {
    return this.handOver
  }

  /** 结算结果(本手结束后可用),否则 null。 */
  getSettlement() {
    return this.settlement
  }

  // ═══════════════════════════ 内部:接缝 / 落子 / 结算 ═══════════════════════════

  /** 翻前→翻后接缝:进翻牌前按存活人数分流。state 为进翻牌那一刻的 GameState。 */
  _handleFlopSeam(state) {
    const alive = state.activePlayers
    if (alive.length === 2) {
      const nonAllin = state.players.filter((p) => !p.folded && !p.allin)
      if (nonAllin.length === 2) {
        // 恰两人且都有筹码 → 翻后 GTO 训练:注入续牌范围。
        this._multiway = false
        this._postflopTrained = true
        const { oopId, ipId } = rolesForHeadsUp(state, this.setup)
        const continuation = deriveContinuation(this.setup, this.actionLog, oopId, ipId)
        this.ranges = this.preflopPolicy.deriveRanges({ continuation })
      } else {
        // 两人但至少一方已全下 → 无翻后决策,直接跑马摊牌。
        this._postflopTrained = false
      }
    } else {
      // 3+ 人 → multiway 无 GTO,标注并跑完 board 摊牌。
      this._multiway = true
      this._runoutOnly = true
      this._postflopTrained = false
    }
  }

  /** 给决策节点补齐策略/引擎所需字段(position/holeCards 已由 deriveDecisionNode 透传)。 */
  _enrich(node) {
    if (!node) return null
    if (node.street === 'preflop') {
      node.preflopLine = computePreflopLine(this.actionLog, node.position)
      // 对手位(开池者/3bet 者位置):驱动 PreflopChartPolicy 的 hero×villain 双维查表。
      node.villain = preflopVillain(this.setup, this.actionLog)
    } else {
      node.ranges = this.ranges
      node.spot = {
        startingPot: streetStartingPot(node.state),
        effectiveStack: effectiveStack(node.state),
        betSizes: this.betSizes,
      }
      node.path = this._postflopPath.slice()
    }
    return node
  }

  /** bot 采样落子:preflop 走范围表,postflop 走引擎策略加权采样。 */
  async _botAct(node) {
    if (node.street === 'preflop') {
      const la = await this.preflopPolicy.sampleAction(node, this.rng)
      return this._toDomainActionFromLegal(node, la)
    }
    const gto = await this.postflopPolicy.query(node)
    const { action, index } = this._sampleStrategy(gto)
    this._postflopPath.push(index)
    return {
      type: action.type,
      playerId: node.playerId,
      street: node.street,
      ...(action.amount != null ? { amount: action.amount } : {}),
    }
  }

  /** 按频率加权在策略动作中采样,返回 {action, index}(index 即引擎动作下标)。 */
  _sampleStrategy(gto) {
    const acts = gto.actions ?? []
    if (acts.length === 0) throw new Error('_sampleStrategy: 策略动作集为空')
    const r = this.rng()
    let acc = 0
    for (let i = 0; i < acts.length; i++) {
      acc += acts[i].frequency ?? 0
      if (r < acc) return { action: acts[i], index: i }
    }
    return { action: acts[acts.length - 1], index: acts.length - 1 }
  }

  /** 结束本手:定局、结算、释放翻后会话。 */
  async _endHand(reason) {
    this.handOver = true
    this.handOverReason = reason
    this._pendingNode = null
    const state = this._reduce()
    this._state = state
    this.settlement = settle(this.setup, state, this.boardLog)
    if (this.postflopPolicy?.dispose) {
      try {
        await this.postflopPolicy.dispose()
      } catch {
        /* 释放失败不影响结算 */
      }
    }
  }

  // ═══════════════════════════ 内部小工具 ═══════════════════════════

  _reduce() {
    return reduceGameState(this.setup, this.actionLog, this.actionLog.length, this.boardLog)
  }

  _revealBoardTo(n) {
    while (this.boardLog.length < n && this.boardLog.length < 5) {
      this.boardLog.push(this._fullBoard[this.boardLog.length])
    }
  }

  /** 把 bot 选中的 LegalAction 转成 DomainAction(raise/bet 用 min 尺寸,call/allin 用其额度)。 */
  _toDomainActionFromLegal(node, la) {
    const base = { type: la.type, playerId: node.playerId, street: node.street }
    if (la.type === 'call' || la.type === 'allin') {
      if (la.amount != null) base.amount = la.amount
    } else if (la.type === 'bet' || la.type === 'raise') {
      base.amount = la.amount ?? la.min // MVP:bot 用最小合法尺寸
    }
    return base
  }

  /** hero 输入动作补全金额(bet/raise 缺省用合法 min),便于 reducer 与 evaluator 对齐。 */
  _normalizeHeroAction(node, input) {
    const la = (node.legalActions ?? []).find((x) => x.type === input.type)
    const action = { type: input.type }
    if (input.amount != null) {
      action.amount = input.amount
    } else if (la) {
      if (la.type === 'call' || la.type === 'allin') action.amount = la.amount
      else if (la.type === 'bet' || la.type === 'raise') action.amount = la.min
    }
    return action
  }

  _toHeroDomainAction(node, action) {
    const base = { type: action.type, playerId: node.playerId, street: node.street }
    if (action.amount != null) base.amount = action.amount
    return base
  }

  /**
   * 翻后:把 hero 的下注/加注尺寸吸附到匹配的引擎档位额度,使 reducer 落子与 solver 导航同线。
   * 仅对带额度的 bet/raise/allin 生效;引擎档位缺额度时保持原样。原地改写 action.amount。
   */
  _snapHeroSizeToTree(action, engineAction) {
    if (!engineAction) return
    const t = action.type
    if (t !== 'bet' && t !== 'raise' && t !== 'allin') return
    const eng = Number(engineAction.amount)
    if (Number.isFinite(eng)) action.amount = eng
  }

  /** 把动作对齐到策略动作数组,返回下标(类型匹配,多档同类型取额度最近)。 */
  _matchIndex(chosen, actions) {
    const amt = Number(chosen?.amount)
    const hasAmt = Number.isFinite(amt)
    let candidates = []
    for (let i = 0; i < actions.length; i++) {
      if (actions[i].type === chosen.type) candidates.push(i)
    }
    if (candidates.length === 0) {
      // all-in 跨类型回退。
      for (let i = 0; i < actions.length; i++) {
        const t = actions[i].type
        if (chosen.type === 'allin' && (t === 'bet' || t === 'raise' || t === 'allin')) candidates.push(i)
        else if ((chosen.type === 'bet' || chosen.type === 'raise') && t === 'allin') candidates.push(i)
      }
    }
    if (candidates.length === 0) return -1
    if (candidates.length === 1 || !hasAmt) return candidates[0]
    let best = candidates[0]
    let bestDiff = Infinity
    for (const i of candidates) {
      const a = Number(actions[i].amount)
      const diff = Number.isFinite(a) ? Math.abs(a - amt) : Infinity
      if (diff < bestDiff) {
        bestDiff = diff
        best = i
      }
    }
    return best
  }

  /** 重置每手可变态。 */
  _resetHand() {
    this.setup = null
    this.actionLog = []
    this.boardLog = []
    this._fullBoard = []
    this._state = null
    this._pendingNode = null
    this.feedbackHistory = []
    this.handOver = false
    this.handOverReason = null
    this.settlement = null
    this.ranges = null
    this._postflopPath = []
    this._multiway = false
    this._runoutOnly = false
    this._postflopTrained = false
  }
}
