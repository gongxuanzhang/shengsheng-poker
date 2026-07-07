/**
 * PreflopChartPolicy + preflopRanges 单元测试(零依赖,Node 内置 test runner)。
 * 运行:  cd frontend && node --test src/domain/policy
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalHand,
  expandRange,
  lookupHandFreqs,
  rangeStringFor,
  deriveRangeAssignment,
  RFI,
  POSITION_ORDER,
} from './preflopRanges.js'
import { PreflopChartPolicy } from './gtoPolicy.js'

// ── 测试小工具:构造一个翻前 DecisionNode(显式带 position/holeCards/preflopLine)──
function preflopNode({ position, holeCards, line, legalActions, playerId = 'hero' }) {
  return {
    playerId,
    isHero: true,
    street: 'preflop',
    legalActions,
    state: { street: 'preflop', players: [{ id: playerId }] },
    position,
    holeCards,
    preflopLine: line,
  }
}

const LA = {
  fold: { type: 'fold' },
  check: { type: 'check' },
  call: (amt) => ({ type: 'call', amount: amt }),
  raise: (min) => ({ type: 'raise', min }),
  allin: (max) => ({ type: 'allin', max }),
}

// ═══════════════════════════ canonicalHand ═══════════════════════════

test('canonicalHand: 对子/同花/非同花/顺序无关', () => {
  assert.equal(canonicalHand('Ah', 'Ad'), 'AA')
  assert.equal(canonicalHand('As', 'Ks'), 'AKs')
  assert.equal(canonicalHand('As', 'Kd'), 'AKo')
  assert.equal(canonicalHand('Kd', 'As'), 'AKo') // 顺序无关,高牌在前
  assert.equal(canonicalHand('9c', 'Ts'), 'T9o') // 规范高牌在前
  assert.equal(canonicalHand('2c', '2d'), '22')
})

// ═══════════════════════════ expandRange ═══════════════════════════

test('expandRange: 对子 plus / 区间', () => {
  assert.equal(expandRange('22+').size, 13) // 全部对子
  assert.deepEqual([...expandRange('QQ+')].sort(), ['AA', 'KK', 'QQ'])
  assert.deepEqual([...expandRange('TT-77')].sort(), ['77', '88', '99', 'TT'])
})

test('expandRange: 非对子 suited/offsuit / plus / 区间', () => {
  assert.deepEqual([...expandRange('AKs')], ['AKs'])
  assert.deepEqual([...expandRange('AKo')], ['AKo'])
  const a2sPlus = expandRange('A2s+')
  assert.equal(a2sPlus.size, 12) // A2s..AKs
  assert.ok(a2sPlus.has('A2s') && a2sPlus.has('AKs') && a2sPlus.has('ATs'))
  assert.ok(!a2sPlus.has('AKo')) // 不越花色
  assert.deepEqual([...expandRange('A5s-A2s')].sort(), ['A2s', 'A3s', 'A4s', 'A5s'])
  assert.deepEqual([...expandRange('K9s+')].sort(), ['K9s', 'KJs', 'KQs', 'KTs'])
})

test('expandRange: 多 token / 空串 / 缓存返回同一实例', () => {
  const s = expandRange('AA,AKs,72o')
  assert.equal(s.size, 3)
  assert.ok(s.has('AA') && s.has('AKs') && s.has('72o'))
  assert.equal(expandRange('').size, 0)
  assert.strictEqual(expandRange('AA,AKs,72o'), s) // 命中缓存,同一 Set 实例
})

// ═══════════════════════════ lookupHandFreqs ═══════════════════════════

test('lookupHandFreqs: rfi 命中开池=纯 raise,未命中=纯 fold', () => {
  assert.deepEqual(lookupHandFreqs('UTG', 'rfi', 'AA'), { raise: 1, call: 0, check: 0, fold: 0 })
  assert.deepEqual(lookupHandFreqs('UTG', 'rfi', '72o'), { raise: 0, call: 0, check: 0, fold: 1 })
})

test('lookupHandFreqs: vsRfi 命中 call 范围=纯 call', () => {
  const f = lookupHandFreqs('UTG1', 'vsRfi', 'KQo') // _default.call 含 KQo
  assert.deepEqual(f, { raise: 0, call: 1, check: 0, fold: 0 })
})

test('lookupHandFreqs: bbOption 未命中加注=纯 check', () => {
  assert.deepEqual(lookupHandFreqs('BB', 'bbOption', '72o'), { raise: 0, call: 0, check: 1, fold: 0 })
  assert.deepEqual(lookupHandFreqs('BB', 'bbOption', 'AA'), { raise: 1, call: 0, check: 0, fold: 0 })
})

test('lookupHandFreqs: MIXED 混频覆盖优先并归一化', () => {
  const f = lookupHandFreqs('BTN', 'vsRfi', 'A5s') // MIXED: raise .5 / fold .5
  assert.equal(f.raise, 0.5)
  assert.equal(f.fold, 0.5)
  assert.equal(f.call + f.check, 0)
})

// ═══════════════════════════ query ═══════════════════════════

test('query: 返回 preflop-chart / approximate=true,actions 与 legalActions 同序等长', async () => {
  const policy = new PreflopChartPolicy()
  const node = preflopNode({
    position: 'UTG',
    holeCards: ['As', 'Ah'],
    line: 'rfi',
    legalActions: [LA.fold, LA.call(1), LA.raise(3)],
  })
  const s = await policy.query(node)
  assert.equal(s.source, 'preflop-chart')
  assert.equal(s.approximate, true)
  assert.equal(s.street, 'preflop')
  assert.equal(s.actions.length, node.legalActions.length)
  assert.deepEqual(s.actions.map((a) => a.type), ['fold', 'call', 'raise'])
})

test('query: AA 开池 → raise 频率 1,其余 0', async () => {
  const policy = new PreflopChartPolicy()
  const s = await policy.query(
    preflopNode({ position: 'UTG', holeCards: ['As', 'Ah'], line: 'rfi', legalActions: [LA.fold, LA.raise(3)] }),
  )
  const byType = Object.fromEntries(s.actions.map((a) => [a.type, a]))
  assert.equal(byType.raise.frequency, 1)
  assert.equal(byType.fold.frequency, 0)
  assert.equal(byType.raise.inSupport, true)
  assert.equal(byType.fold.inSupport, false)
})

test('query: 冷门牌开池 → fold 频率 1', async () => {
  const policy = new PreflopChartPolicy()
  const s = await policy.query(
    preflopNode({ position: 'UTG', holeCards: ['7c', '2d'], line: 'rfi', legalActions: [LA.fold, LA.raise(3)] }),
  )
  const byType = Object.fromEntries(s.actions.map((a) => [a.type, a]))
  assert.equal(byType.fold.frequency, 1)
  assert.equal(byType.raise.frequency, 0)
})

test('query: 频率总和为 1(混频手)', async () => {
  const policy = new PreflopChartPolicy()
  const s = await policy.query(
    preflopNode({ position: 'BTN', holeCards: ['As', '5s'], line: 'vsRfi', legalActions: [LA.fold, LA.call(2), LA.raise(9)] }),
  )
  const total = s.actions.reduce((t, a) => t + a.frequency, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
  const byType = Object.fromEntries(s.actions.map((a) => [a.type, a]))
  assert.ok(Math.abs(byType.raise.frequency - 0.5) < 1e-9)
  assert.ok(Math.abs(byType.fold.frequency - 0.5) < 1e-9)
})

test('query: raise 桶无对应合法动作时重归一化(raise 频率不凭空残留)', async () => {
  const policy = new PreflopChartPolicy()
  // AA 想 raise,但合法动作只有 fold/call → raise 重量重摊,分布仍合法且和为 1
  const s = await policy.query(
    preflopNode({ position: 'UTG', holeCards: ['As', 'Ah'], line: 'rfi', legalActions: [LA.fold, LA.call(1)] }),
  )
  const total = s.actions.reduce((t, a) => t + a.frequency, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
  assert.ok(!s.actions.some((a) => a.type === 'raise')) // 无 raise 动作
})

test('query: 缺底牌抛出明确错误', async () => {
  const policy = new PreflopChartPolicy()
  await assert.rejects(
    () => policy.query(preflopNode({ position: 'UTG', holeCards: undefined, line: 'rfi', legalActions: [LA.fold] })),
    /底牌/,
  )
})

test('query: 从 state.players 解析 position/holeCards(无节点级字段)', async () => {
  const policy = new PreflopChartPolicy()
  const node = {
    playerId: 'hero',
    street: 'preflop',
    legalActions: [LA.fold, LA.raise(3)],
    preflopLine: 'rfi',
    state: { street: 'preflop', players: [{ id: 'hero', position: 'UTG', holeCards: ['As', 'Ah'] }] },
  }
  const s = await policy.query(node)
  assert.equal(s.raw.position, 'UTG')
  assert.equal(s.raw.handKey, 'AA')
})

// ═══════════════════════════ sampleAction ═══════════════════════════

test('sampleAction: 按频率随机(确定性 rng 覆盖各分支)', async () => {
  const policy = new PreflopChartPolicy()
  // BTN vsRfi A5s:legalActions [fold, call(0), raise] → 频率 [0.5, 0, 0.5],累积 fold<0.5<=raise
  const node = preflopNode({
    position: 'BTN', holeCards: ['As', '5s'], line: 'vsRfi',
    legalActions: [LA.fold, LA.call(2), LA.raise(9)],
  })
  const foldPick = await policy.sampleAction(node, () => 0.2) // 落在 fold 区
  assert.equal(foldPick.type, 'fold')
  const raisePick = await policy.sampleAction(node, () => 0.8) // 落在 raise 区
  assert.equal(raisePick.type, 'raise')
})

test('sampleAction: 纯策略必得该动作', async () => {
  const policy = new PreflopChartPolicy()
  const node = preflopNode({
    position: 'UTG', holeCards: ['As', 'Ah'], line: 'rfi',
    legalActions: [LA.fold, LA.raise(3)],
  })
  for (const r of [0, 0.3, 0.99]) {
    const pick = await policy.sampleAction(node, () => r)
    assert.equal(pick.type, 'raise')
  }
})

test('sampleAction: 返回的是 node.legalActions 中的对象', async () => {
  const policy = new PreflopChartPolicy()
  const node = preflopNode({
    position: 'UTG', holeCards: ['As', 'Ah'], line: 'rfi',
    legalActions: [LA.fold, LA.raise(3)],
  })
  const pick = await policy.sampleAction(node, () => 0.9)
  assert.ok(node.legalActions.includes(pick))
})

// ═══════════════════════════ deriveRanges / 续牌范围 ═══════════════════════════

test('rangeStringFor: 各线取正确参考范围', () => {
  assert.equal(rangeStringFor('UTG', 'rfi', 'open'), RFI.UTG)
  assert.equal(rangeStringFor('BB', 'vsRfi', 'call').length > 0, true)
  assert.equal(rangeStringFor('BB', 'vsRfi', 'threebet').length > 0, true)
  assert.notEqual(rangeStringFor('BB', 'vsRfi', 'call'), rangeStringFor('BB', 'vsRfi', 'threebet'))
})

test('deriveRangeAssignment: 拼 RangeAssignment', () => {
  const ra = deriveRangeAssignment(
    { position: 'SB', line: 'rfi', action: 'open' },
    { position: 'BB', line: 'vsRfi', action: 'call' },
  )
  assert.equal(ra.oopRange, RFI.SB)
  assert.equal(ra.source, 'preflop-chart')
  assert.ok(ra.ipRange.length > 0)
})

test('deriveRanges: 已有 node.ranges 原样返回', () => {
  const policy = new PreflopChartPolicy()
  const ranges = { oopRange: 'AA', ipRange: 'KK', source: 'manual' }
  assert.strictEqual(policy.deriveRanges({ ranges }), ranges)
})

test('deriveRanges: 由 node.continuation 推导', () => {
  const policy = new PreflopChartPolicy()
  const ra = policy.deriveRanges({
    continuation: {
      oop: { position: 'BB', line: 'vsRfi', action: 'call' },
      ip: { position: 'BTN', line: 'rfi', action: 'open' },
    },
  })
  assert.equal(ra.ipRange, RFI.BTN)
  assert.ok(ra.oopRange.length > 0)
})

test('deriveRanges: 信息不足抛出指引错误', () => {
  const policy = new PreflopChartPolicy()
  assert.throws(() => policy.deriveRanges({}), /continuation/)
})

// ═══════════════════════════ 数据自洽性 ═══════════════════════════

test('数据自洽:RFI 覆盖 UTG..SB(BB 无 RFI),范围串可展开且非空', () => {
  for (const pos of POSITION_ORDER) {
    if (pos === 'BB') { assert.equal(RFI[pos], undefined); continue }
    assert.ok(RFI[pos], `缺 RFI[${pos}]`)
    assert.ok(expandRange(RFI[pos]).size > 0, `RFI[${pos}] 展开为空`)
  }
})

test('数据自洽:注入自定义 lookup 可覆盖内置表', async () => {
  const policy = new PreflopChartPolicy({ lookup: () => ({ raise: 0, call: 0, check: 0, fold: 1 }) })
  const s = await policy.query(
    preflopNode({ position: 'UTG', holeCards: ['As', 'Ah'], line: 'rfi', legalActions: [LA.fold, LA.raise(3)] }),
  )
  const byType = Object.fromEntries(s.actions.map((a) => [a.type, a]))
  assert.equal(byType.fold.frequency, 1) // 自定义 lookup 强制弃牌
})
