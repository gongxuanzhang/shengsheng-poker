/**
 * 结算 / 边池分配单测。运行:cd frontend && node --test src/training
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settle } from '../settlement.js'

// 构造最小 setup/state:只填 settle 需要的字段。
function mk(playersSpec, board, pot) {
  const setup = { players: playersSpec.map((p) => ({ id: p.id, stack: p.initial, holeCards: p.hole })) }
  const state = {
    pot,
    activePlayers: playersSpec.filter((p) => !p.folded).map((p) => p.id),
    players: playersSpec.map((p) => ({
      id: p.id, committed: p.committed, stack: p.stack, folded: !!p.folded,
    })),
  }
  return { setup, state, board }
}

test('弃牌成局:唯一在手者独得底池', () => {
  const { setup, state, board } = mk([
    { id: 'a', initial: 200, stack: 194, committed: 6, hole: ['As', 'Ks'], folded: true },
    { id: 'b', initial: 200, stack: 196, committed: 4, hole: ['2c', '7d'] },
  ], [], 10)
  const r = settle(setup, state, board)
  assert.equal(r.showdownReached, false)
  assert.deepEqual(r.winners, ['b'])
  assert.equal(r.payouts.b, 10)
  assert.equal(r.finalStacks.b, 206)
  assert.equal(r.net.b, 6)
  assert.equal(r.net.a, -6)
})

test('摊牌:强手赢等额底池', () => {
  const { setup, state, board } = mk([
    { id: 'a', initial: 200, stack: 100, committed: 100, hole: ['As', 'Ac'] },
    { id: 'b', initial: 200, stack: 100, committed: 100, hole: ['Kd', 'Kh'] },
  ], ['Ah', 'Qs', 'Jd', '3c', '2s'], 200)
  const r = settle(setup, state, board)
  assert.equal(r.showdownReached, true)
  assert.deepEqual(r.winners, ['a']) // 三条 A > 一对 K
  assert.equal(r.payouts.a, 200)
  assert.equal(r.net.a, 100)
  assert.equal(r.net.b, -100)
})

test('平局:平分底池', () => {
  const { setup, state, board } = mk([
    { id: 'a', initial: 200, stack: 150, committed: 50, hole: ['As', 'Kc'] },
    { id: 'b', initial: 200, stack: 150, committed: 50, hole: ['Ad', 'Kh'] },
  ], ['Ah', 'Kd', 'Qs', 'Jc', '2d'], 100)
  const r = settle(setup, state, board)
  assert.equal(r.payouts.a, 50)
  assert.equal(r.payouts.b, 50)
  assert.equal(r.net.a, 0)
  assert.equal(r.net.b, 0)
})

test('边池:短码全下只能赢主池,超额部分归大码', () => {
  // a 全下 50(最强),b/c 各投 100。主池 150 归 a;边池 100(b/c)由 b/c 较强者取。
  const { setup, state, board } = mk([
    { id: 'a', initial: 50, stack: 0, committed: 50, hole: ['As', 'Ac'] }, // 三条 A
    { id: 'b', initial: 200, stack: 100, committed: 100, hole: ['Kd', 'Kh'] }, // 三条 K
    { id: 'c', initial: 200, stack: 100, committed: 100, hole: ['Qd', 'Qh'] }, // 三条 Q
  ], ['Ah', 'Kc', 'Qs', '3d', '2c'], 250)
  const r = settle(setup, state, board)
  // 主池 = 3*50 = 150 → a(最强)
  assert.equal(r.payouts.a, 150)
  // 边池 = 2*50 = 100 → b(KK > QQ)
  assert.equal(r.payouts.b, 100)
  assert.equal(r.payouts.c, 0)
  assert.equal(r.net.a, 100) // 赢 150 − 投入 50
  assert.equal(r.net.b, 0) // 赢 100 − 投入 100
  assert.equal(r.net.c, -100)
})
