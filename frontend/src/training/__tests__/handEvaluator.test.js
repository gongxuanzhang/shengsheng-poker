/**
 * 7 张牌力评估器单测。运行:cd frontend && node --test src/training
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate5, evaluate7, compareRank } from '../handEvaluator.js'

test('类别排序:同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌', () => {
  const sf = evaluate5(['As', 'Ks', 'Qs', 'Js', 'Ts'])
  const quads = evaluate5(['Ac', 'Ad', 'Ah', 'As', 'Ks'])
  const boat = evaluate5(['Ac', 'Ad', 'Ah', 'Ks', 'Kd'])
  const flush = evaluate5(['As', 'Js', '9s', '5s', '2s'])
  const straight = evaluate5(['9c', '8d', '7h', '6s', '5c'])
  const trips = evaluate5(['Ac', 'Ad', 'Ah', 'Ks', 'Qd'])
  const twoPair = evaluate5(['Ac', 'Ad', 'Ks', 'Kd', 'Qc'])
  const pair = evaluate5(['Ac', 'Ad', 'Ks', 'Qd', 'Jc'])
  const high = evaluate5(['Ac', 'Jd', '9s', '5d', '2c'])
  const order = [sf, quads, boat, flush, straight, trips, twoPair, pair, high]
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(compareRank(order[i], order[i + 1]) > 0, `第 ${i} 项应强于第 ${i + 1} 项`)
  }
  assert.equal(sf[0], 8)
  assert.equal(high[0], 0)
})

test('轮子顺 A2345:顺高记 5,弱于 23456', () => {
  const wheel = evaluate5(['Ac', '2d', '3h', '4s', '5c'])
  const six = evaluate5(['2c', '3d', '4h', '5s', '6c'])
  assert.equal(wheel[0], 4)
  assert.equal(wheel[1], 5)
  assert.ok(compareRank(six, wheel) > 0)
})

test('皇家同花顺是最强同花顺', () => {
  const royal = evaluate5(['As', 'Ks', 'Qs', 'Js', 'Ts'])
  const lowSf = evaluate5(['6s', '5s', '4s', '3s', '2s'])
  assert.equal(royal[0], 8)
  assert.ok(compareRank(royal, lowSf) > 0)
})

test('evaluate7:从 7 张取最强 5(同花优先于低对)', () => {
  // 5 张黑桃成同花,盖过任何对子
  const s = evaluate7(['As', 'Ks', 'Qs', '7s', '2s', '7d', '7h'])
  assert.equal(s[0], 5) // flush(而非葫芦?这里 7 是三条+同花 → 取更强:三条7 vs 同花,同花强)
})

test('evaluate7:踢脚比较', () => {
  const a = evaluate7(['Ac', 'Ad', 'Ks', 'Qd', 'Jc', '9h', '2s']) // 一对 A,踢 KQJ
  const b = evaluate7(['Ac', 'Ah', 'Ks', 'Qd', 'Tc', '8h', '2s']) // 一对 A,踢 KQT
  assert.equal(a[0], 1)
  assert.equal(b[0], 1)
  assert.ok(compareRank(a, b) > 0) // J 踢脚 > T 踢脚
})

test('平手判定', () => {
  const a = evaluate7(['Ac', 'Ad', 'Ks', 'Qd', 'Jc', '3h', '2s'])
  const b = evaluate7(['Ah', 'As', 'Kd', 'Qc', 'Jh', '3d', '2c'])
  assert.equal(compareRank(a, b), 0)
})
