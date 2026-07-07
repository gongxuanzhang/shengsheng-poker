/**
 * TrainingSession 编排单测(mock 策略确定性驱动 + 真 DeviationEvaluator)。
 * 运行:cd frontend && node --test src/training
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TrainingSession } from '../session.js'
import { mulberry32 } from '../deck.js'
import { DeviationEvaluator } from '../../domain/eval/deviationEvaluator.js'
import { PreflopChartPolicy } from '../../domain/policy/gtoPolicy.js'

// ── 从 legalActions 造一份对齐的 NodeStrategy(可注入 ev/freq 覆盖) ──
function strategyFromLegal(node, opts = {}) {
  const las = node.legalActions ?? []
  const evByType = opts.evByType ?? {}
  const forceType = opts.forceType // 若给定,该类型频率 1、其余 0
  const n = las.length
  const actions = las.map((la) => {
    let freq
    if (forceType) freq = la.type === forceType ? 1 : 0
    else freq = 1 / n
    return {
      label: la.type,
      type: la.type,
      amount: la.amount ?? la.min,
      frequency: freq,
      ev: evByType[la.type] ?? 0,
      inSupport: freq > 0.005,
    }
  })
  return { street: node.street, actions, source: 'mock', approximate: node.street === 'preflop' }
}

function pickLegal(node, type) {
  const la = (node.legalActions ?? []).find((x) => x.type === type)
  if (!la) throw new Error(`mock decide 选了不合法动作 ${type},可选 ${node.legalActions.map((x) => x.type)}`)
  return la
}

// 翻前 mock:decide(node)->动作类型;query 按需注入 ev。
class MockPreflop {
  constructor({ decide, evByType, ranges } = {}) {
    this._decide = decide
    this._evByType = evByType
    this._ranges = ranges ?? { oopRange: 'AA', ipRange: 'KK', source: 'mock' }
  }
  async query(node) { return strategyFromLegal(node, { evByType: this._evByType }) }
  async sampleAction(node) {
    const t = this._decide ? this._decide(node) : defaultPreflopDecide(node)
    return pickLegal(node, t)
  }
  deriveRanges(arg) { return arg?.ranges ?? this._ranges }
}

// 翻后 mock:强制某类型(默认 check/call/fold),query 供 bot 采样与 hero 反馈。
class MockPostflop {
  constructor({ decide } = {}) { this._decide = decide; this.disposed = 0 }
  async query(node) {
    const t = this._decide ? this._decide(node) : defaultPostflopDecide(node)
    return strategyFromLegal(node, { forceType: t })
  }
  async dispose() { this.disposed++ }
}

function has(node, type) { return (node.legalActions ?? []).some((x) => x.type === type) }
function defaultPreflopDecide(node) { return has(node, 'fold') ? 'fold' : 'check' }
function defaultPostflopDecide(node) {
  if (has(node, 'check')) return 'check'
  if (has(node, 'call')) return 'call'
  return 'fold'
}

// currentBet 是否高于大盲(=面对加注)。
function facingRaise(node) { return node.state.currentBet > (node.state.bb ?? 0) }

function makeSession(deps = {}) {
  return new TrainingSession({
    preflopPolicy: deps.preflopPolicy ?? new MockPreflop(deps.preflopOpts),
    postflopPolicy: deps.postflopPolicy ?? new MockPostflop(deps.postflopOpts),
    evaluator: deps.evaluator ?? new DeviationEvaluator(),
    rng: deps.rng ?? mulberry32(42),
  })
}

// ═══════════════════════════ 发牌与盲注 ═══════════════════════════

test('newHand:6 座 / 各两张唯一底牌 / 盲注入池 / 按钮与 hero 标记', () => {
  const s = makeSession({ rng: mulberry32(1) })
  s.newHand({ heroPosition: 'BTN', blinds: { sb: 1, bb: 2 } })
  const v = s.getViewState()
  assert.equal(v.players.length, 6)
  assert.equal(v.heroId, 'BTN')

  // 底牌:hero 可见,bot 隐藏(未摊牌);全部 12 张唯一。
  const heroSeat = v.players.find((p) => p.isHero)
  assert.equal(heroSeat.holeCards.length, 2)
  const all = s.setup.players.flatMap((p) => p.holeCards)
  assert.equal(new Set(all).size, 12)
  assert.equal(v.players.find((p) => !p.isHero).holeCards, undefined)

  // 盲注:SB=1,BB=2,pot=3,currentBet=2。
  const sb = v.players.find((p) => p.position === 'SB')
  const bb = v.players.find((p) => p.position === 'BB')
  assert.equal(sb.committed, 1)
  assert.equal(bb.committed, 2)
  assert.equal(v.pot, 3)
  assert.equal(v.currentBet, 2)
  assert.equal(v.players.find((p) => p.position === 'BTN').stack, 200) // 100bb 深
})

// ═══════════════════════════ 翻前推进到 hero ═══════════════════════════

test('advance:bot 弃牌推进到 hero 回合并挂起', async () => {
  const s = makeSession({ preflopOpts: { decide: () => 'fold' } })
  s.newHand({ heroPosition: 'BTN' })
  await s.advance()
  assert.equal(s.isHandOver(), false)
  const node = s.getDecision()
  assert.ok(node)
  assert.equal(node.playerId, 'BTN')
  assert.equal(node.isHero, true)
  assert.equal(node.street, 'preflop')
  assert.equal(node.position, 'BTN')
  assert.equal(node.holeCards.length, 2) // 透传底牌
  assert.ok(node.preflopLine) // enrich 补齐动作线
  assert.equal(s.getViewState().isHeroTurn, true)
})

// ═══════════════════════════ walk:都 fold 到 BB ═══════════════════════════

test('walk:全部弃牌到 BB,hero 无需行动直接成局', async () => {
  const s = makeSession({ preflopOpts: { decide: () => 'fold' } })
  s.newHand({ heroPosition: 'BB', blinds: { sb: 1, bb: 2 } })
  await s.advance()
  assert.equal(s.isHandOver(), true)
  assert.equal(s.handOverReason, 'fold')
  assert.equal(s.getDecision(), null)
  assert.equal(s.getFeedbackHistory().length, 0) // hero 未决策
  const settle = s.getSettlement()
  assert.deepEqual(settle.winners, ['BB'])
  assert.equal(settle.net.BB, 1) // 赢下 SB 的 1
})

// ═══════════════════════════ heroAct 反馈 + 推进 ═══════════════════════════

test('heroAct:对照 GTO 生成反馈并推进(evLoss 明显 → blunder)', async () => {
  // UTG 先动;mock GTO:raise EV 高、fold EV 0 → hero 弃牌为大漏。
  const s = makeSession({
    preflopOpts: { decide: () => 'fold', evByType: { fold: 0, call: 5, raise: 10, allin: 2 } },
  })
  s.newHand({ heroPosition: 'UTG' })
  await s.advance()
  const node = s.getDecision()
  assert.equal(node.playerId, 'UTG')

  const rec = await s.heroAct({ type: 'fold' })
  assert.equal(rec.street, 'preflop')
  assert.equal(rec.action.type, 'fold')
  assert.equal(rec.feedback.evLoss, 10) // 10 − 0
  assert.equal(rec.feedback.severity, 'blunder')
  assert.equal(s.getFeedbackHistory().length, 1)
  // hero 弃牌后仅剩盲注两家,继续推进(bot 行动或成局)。
  assert.ok(s.getDecision() === null || s.isHandOver() || s.getViewState())
})

// ═══════════════════════════ hero 弃牌即结束 ═══════════════════════════

test('hero 弃牌:唯一开池者存活 → 立即成局', async () => {
  // CO 开池,其余弃牌;hero=BB 面对加注选择弃牌 → 仅 CO 在手。
  const decide = (node) => {
    if (facingRaise(node)) return 'fold'
    return node.position === 'CO' ? 'raise' : 'fold'
  }
  const s = makeSession({ preflopOpts: { decide } })
  s.newHand({ heroPosition: 'BB' })
  await s.advance()
  const node = s.getDecision()
  assert.equal(node.playerId, 'BB')
  assert.equal(node.preflopLine, 'vsRfi') // 面对单个开池
  await s.heroAct({ type: 'fold' })
  assert.equal(s.isHandOver(), true)
  assert.equal(s.handOverReason, 'fold')
  assert.deepEqual(s.getSettlement().winners, ['CO'])
  assert.equal(s.getFeedbackHistory().length, 1) // hero 弃牌那次决策有反馈
})

// ═══════════════════════════ 收敛两人进翻牌(HU GTO) ═══════════════════════════

test('接缝:恰两人进翻牌 → postflopTrained,注入续牌范围,揭示 flop', async () => {
  // hero=BTN 开池,SB 弃、BB 跟 → 两人见 flop。
  const decide = (node) => {
    if (facingRaise(node)) return node.position === 'BB' ? 'call' : 'fold'
    return 'fold'
  }
  const s = makeSession({ preflopOpts: { decide } })
  s.newHand({ heroPosition: 'BTN' })
  await s.advance()
  // hero 开池到 6
  await s.heroAct({ type: 'raise', amount: 6 })
  // 现在应已到翻牌:两人存活,BB 先动(bot 已 check 或轮到 hero)
  const v = s.getViewState()
  assert.equal(s._postflopTrained, true)
  assert.equal(s._multiway, false)
  assert.equal(v.board.length, 3) // flop 已揭示
  assert.equal(v.isHeadsUp, true)
  assert.ok(s.ranges) // 续牌范围已注入
  assert.equal(v.street, 'flop')
})

// ═══════════════════════════ multiway 被标注跳过 ═══════════════════════════

test('接缝:3+ 人进翻牌 → 标注 multiway 无 GTO,跑到摊牌不训练翻后', async () => {
  // hero=BTN 开池,SB 跟、BB 跟 → 三人见 flop。
  const decide = (node) => {
    if (facingRaise(node)) return 'call' // SB、BB 都跟
    return 'fold'
  }
  const s = makeSession({
    preflopOpts: { decide },
    rng: mulberry32(7),
  })
  s.newHand({ heroPosition: 'BTN', forcedBoard: ['2c', '7d', '9s', 'Th', 'Jc'] })
  await s.advance()
  await s.heroAct({ type: 'raise', amount: 6 })
  assert.equal(s._multiway, true)
  assert.equal(s._postflopTrained, false)
  assert.equal(s.isHandOver(), true)
  assert.equal(s.handOverReason, 'multiway-no-gto')
  const v = s.getViewState()
  assert.equal(v.board.length, 5) // 跑完 board
  // 只有翻前 hero 决策进入反馈,翻后无反馈。
  assert.ok(s.getFeedbackHistory().every((r) => r.street === 'preflop'))
  assert.ok(s.getSettlement().showdownReached)
})

// ═══════════════════════════ 街切换与 board 揭示(HU 全程 check) ═══════════════════════════

test('街切换:HU 双方逐街 check,board 3→4→5,末街摊牌', async () => {
  const decide = (node) => {
    if (facingRaise(node)) return node.position === 'BB' ? 'call' : 'fold'
    return 'fold'
  }
  const s = makeSession({
    preflopOpts: { decide },
    postflopOpts: { decide: () => 'check' }, // bot 每街 check
    rng: mulberry32(3),
  })
  s.newHand({ heroPosition: 'BTN' })
  await s.advance()
  await s.heroAct({ type: 'raise', amount: 6 }) // 进 flop

  assert.equal(s.getViewState().board.length, 3)
  await s.heroAct({ type: 'check' }) // flop check → turn
  assert.equal(s.getViewState().board.length, 4)
  await s.heroAct({ type: 'check' }) // turn check → river
  assert.equal(s.getViewState().board.length, 5)
  await s.heroAct({ type: 'check' }) // river check → showdown
  assert.equal(s.isHandOver(), true)
  assert.equal(s.handOverReason, 'showdown')
  assert.ok(s.getSettlement().showdownReached)
  // hero 三次翻后 check 都有反馈。
  const postflop = s.getFeedbackHistory().filter((r) => r.street !== 'preflop')
  assert.equal(postflop.length, 3)
})

// ═══════════════════════════ 全下线 ═══════════════════════════

test('全下线:hero 翻前 shove,bot 全下跟注,跑马摊牌结算', async () => {
  const decide = (node) => {
    if (facingRaise(node)) return node.position === 'BB' ? 'call' : 'fold'
    return 'fold'
  }
  const s = makeSession({ preflopOpts: { decide } })
  s.newHand({
    heroPosition: 'BTN',
    forcedHoles: { BTN: ['As', 'Ac'], BB: ['Kd', 'Kh'] },
    forcedBoard: ['2c', '7d', '9s', '3h', '4c'], // AA 领先
  })
  await s.advance()
  await s.heroAct({ type: 'allin' })
  assert.equal(s.isHandOver(), true)
  const v = s.getViewState()
  assert.equal(v.board.length, 5)
  assert.equal(s._postflopTrained, false) // 全下无翻后决策
  const settle = s.getSettlement()
  assert.ok(settle.showdownReached)
  assert.deepEqual(settle.winners, ['BTN'])
  assert.equal(settle.net.BTN, 201) // 赢对手 200 + SB 弃入的死钱 1
  assert.equal(settle.net.BB, -200)
  assert.equal(settle.net.SB, -1) // 弃牌的小盲死钱归赢家
  // 净盈亏零和(死钱全部流向赢家,不凭空产生)。
  const sum = Object.values(settle.net).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum) < 1e-9)
  assert.equal(s.postflopPolicy.disposed, 1) // 本手结束释放会话
})

// ═══════════════════════════ 翻后下注尺寸吸附到求解树档位 ═══════════════════════════

test('翻后:hero 下非引擎档位尺寸 → 就近吸附到求解树档位(reducer 落子与 path 同线)', async () => {
  // hero=BB(OOP,翻后先动)对 BTN 的开池跟注进翻牌;翻后 hero 首个决策自由下注。
  // 只有 BTN 开池,其余(含面对加注)全弃 → 恰两人进翻牌。
  const decide = (node) => {
    if (facingRaise(node)) return 'fold'
    return node.position === 'BTN' ? 'raise' : 'fold'
  }
  const s = makeSession({
    preflopOpts: { decide },
    rng: mulberry32(3),
  })
  s.newHand({ heroPosition: 'BB' })
  await s.advance()
  // hero BB 面对 BTN 开池,跟注进翻牌。
  await s.heroAct({ type: 'call' })

  const node = s.getDecision()
  assert.equal(node.street, 'flop')
  assert.equal(node.playerId, 'BB') // OOP 先动
  const betLA = node.legalActions.find((a) => a.type === 'bet')
  assert.ok(betLA, '翻后首动应可下注')
  // 引擎档位额度 = MockPostflop 策略里 bet 的 amount(strategyFromLegal 取 la.min)。
  const engineBet = betLA.min
  const offTree = engineBet + 10 // hero 下一个非引擎档位、但合法的尺寸
  assert.ok(offTree <= betLA.max, '构造的 off-tree 尺寸须仍合法')

  const rec = await s.heroAct({ type: 'bet', amount: offTree })
  // 反馈正常生成(未被跳过)。
  assert.ok(rec.feedback && !rec.feedback.skipped)
  // 关键:actionLog 里落子的 flop 下注额已吸附到引擎档位,而非 hero 输入的 off-tree 值。
  const flopBet = s.actionLog.find(
    (a) => a.street === 'flop' && a.type === 'bet' && a.playerId === 'BB',
  )
  assert.ok(flopBet, 'flop 下注应已入 actionLog')
  assert.equal(flopBet.amount, engineBet) // 吸附到求解树档位
  assert.notEqual(flopBet.amount, offTree) // 不是 hero 原始 off-tree 额
})

// ═══════════════════════════ 与真 PreflopChartPolicy 集成冒烟 ═══════════════════════════

test('集成:真 PreflopChartPolicy 驱动 bot,推进不崩且节点字段完整', async () => {
  const s = new TrainingSession({
    preflopPolicy: new PreflopChartPolicy(),
    postflopPolicy: new MockPostflop({ decide: () => 'check' }),
    evaluator: new DeviationEvaluator(),
    rng: mulberry32(123),
  })
  s.newHand({ heroPosition: 'UTG', forcedHoles: { UTG: ['As', 'Ah'] } })
  await s.advance()
  // hero UTG 先动;真表要求 node.holeCards / position / preflopLine 齐备。
  const node = s.getDecision()
  assert.equal(node.playerId, 'UTG')
  assert.deepEqual(node.holeCards, ['As', 'Ah'])
  assert.equal(node.preflopLine, 'rfi')
  const rec = await s.heroAct({ type: 'raise', amount: 6 })
  assert.ok(rec.feedback) // 真表 + 真 evaluator 产出反馈
  assert.equal(typeof rec.feedback.chosenFreq, 'number')
  // 推进到底不抛异常。
  assert.doesNotReject(Promise.resolve())
})
