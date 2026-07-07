/**
 * 训练发牌工具(纯 JS,无依赖)。
 *
 * 负责:确定性可注入的伪随机源、52 张牌洗牌、给 9 座位发底牌、预留公共牌(flop/turn/river)。
 * 牌串两字符 rank+suit,契约见 domain/types.js 的 Card:rank ∈ "AKQJT98765432",suit ∈ "shdc"。
 *
 * 确定性:所有随机走注入的 rng()(缺省 Math.random)。测试可用 mulberry32(seed) 得可复现序列,
 * 或用 forced 覆盖指定座位/公共牌,精确构造 showdown 场景。
 */

export const RANKS = 'AKQJT98765432'.split('')
export const SUITS = 'shdc'.split('')

/** 全副 52 张(rank 高→低 × 花色)。 */
export function fullDeck() {
  const deck = []
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s)
  return deck
}

/**
 * mulberry32:32 位种子确定性 PRNG,返回 () => [0,1)。用于测试可复现洗牌/采样。
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 原地 Fisher–Yates 洗牌(用注入 rng)。返回同一数组便于链式。
 * @param {string[]} deck
 * @param {() => number} rng
 * @returns {string[]}
 */
export function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = deck[i]
    deck[i] = deck[j]
    deck[j] = tmp
  }
  return deck
}

/**
 * 发一手牌:给每个座位两张底牌 + 预留 5 张公共牌。支持 forced 覆盖(测试精确造牌)。
 *
 * @param {string[]} seatIds 需发牌的座位 id(顺序即发牌顺序)
 * @param {Object} [opts]
 * @param {() => number} [opts.rng] 随机源,缺省 Math.random
 * @param {Record<string,[string,string]>} [opts.forcedHoles] 座位 id -> 指定底牌(从牌堆扣除)
 * @param {string[]} [opts.forcedBoard] 指定公共牌(≤5 张,从牌堆扣除,不足部分随机补)
 * @returns {{ holes: Record<string,[string,string]>, board: string[] }}
 *          holes:每座位两张;board:5 张预留公共牌(flop×3,turn,river)
 */
export function dealHand(seatIds, opts = {}) {
  const rng = opts.rng ?? Math.random
  const forcedHoles = opts.forcedHoles ?? {}
  const forcedBoard = opts.forcedBoard ?? []

  // 从牌堆扣除所有 forced 牌,余牌洗匀。
  const used = new Set()
  for (const id of Object.keys(forcedHoles)) for (const c of forcedHoles[id]) used.add(c)
  for (const c of forcedBoard) used.add(c)
  const pool = shuffle(fullDeck().filter((c) => !used.has(c)), rng)
  let p = 0
  const draw = () => pool[p++]

  /** @type {Record<string,[string,string]>} */
  const holes = {}
  for (const id of seatIds) {
    if (forcedHoles[id]) {
      holes[id] = [forcedHoles[id][0], forcedHoles[id][1]]
    } else {
      holes[id] = [draw(), draw()]
    }
  }

  const board = []
  for (let i = 0; i < 5; i++) board.push(forcedBoard[i] ?? draw())

  return { holes, board }
}
