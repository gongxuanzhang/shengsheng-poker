/**
 * 7 张牌牌力评估器(纯 JS,7 选 5 取最强)。用于摊牌定赢家。
 *
 * 评分表示:一个可字典序比较的数组 [category, ...tiebreaks],数值越大越强。
 *   category: 8 同花顺 / 7 四条 / 6 葫芦 / 5 同花 / 4 顺子 / 3 三条 / 2 两对 / 1 一对 / 0 高牌
 * tiebreaks 为按牌力降序的关键点数(A=14 … 2=2),已含 A2345 轮子顺(顺高记 5)。
 *
 * compareRank(a,b) > 0 表示 a 更强;评分数组长度可不同但同 category 下等长,字典序比较正确。
 */

const RANK_VALUE = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 }

/**
 * 字典序比较两个评分数组。
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} >0:a 强;<0:b 强;0:相等
 */
export function compareRank(a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? -1
    const y = b[i] ?? -1
    if (x !== y) return x - y
  }
  return 0
}

/**
 * 评估恰好 5 张牌。
 * @param {string[]} cards 5 张 "Rs"
 * @returns {number[]} [category, ...tiebreaks]
 */
export function evaluate5(cards) {
  const ranks = cards.map((c) => RANK_VALUE[c[0]]).sort((a, b) => b - a)
  const suits = cards.map((c) => c[1])
  const isFlush = suits.every((s) => s === suits[0])

  const counts = {}
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1
  // 分组:先按出现次数降序,再按点数降序。
  const groups = Object.entries(counts)
    .map(([r, c]) => [c, Number(r)])
    .sort((x, y) => y[0] - x[0] || y[1] - x[1])

  // 顺子:5 个不同点数且跨度为 4;或 A-5 轮子(A 记作 1)。
  const uniq = [...new Set(ranks)]
  let straightHigh = 0
  if (uniq.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0]
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) straightHigh = 5 // 轮子 A2345
  }
  const isStraight = straightHigh > 0

  if (isStraight && isFlush) return [8, straightHigh]
  if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]]
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]]
  if (isFlush) return [5, ...ranks]
  if (isStraight) return [4, straightHigh]
  if (groups[0][0] === 3) return [3, groups[0][1], groups[1][1], groups[2][1]]
  if (groups[0][0] === 2 && groups[1][0] === 2) return [2, groups[0][1], groups[1][1], groups[2][1]]
  if (groups[0][0] === 2) return [1, groups[0][1], groups[1][1], groups[2][1], groups[3][1]]
  return [0, ...ranks]
}

/**
 * 评估 7 张牌:枚举 C(7,5)=21 组,取最强。
 * @param {string[]} cards7 7 张 "Rs"(2 底牌 + 5 公共牌)
 * @returns {number[]} 最强 5 张的评分数组
 */
export function evaluate7(cards7) {
  if (cards7.length < 5) throw new Error(`evaluate7 需至少 5 张,实得 ${cards7.length}`)
  let best = null
  for (let i = 0; i < cards7.length; i++) {
    for (let j = i + 1; j < cards7.length; j++) {
      const five = cards7.filter((_, k) => k !== i && k !== j)
      const score = evaluate5(five)
      if (best === null || compareRank(score, best) > 0) best = score
    }
  }
  return best
}

/** 类别可读名(调试/UI 用)。 */
export const CATEGORY_NAME = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
]
