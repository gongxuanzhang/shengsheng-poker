/**
 * 结算:摊牌定赢家 + 边池分配(纯 JS)。
 *
 * 依据各家 committed(本手总投入,含盖牌者的死钱)与在手玩家 7 张牌力,按标准边池算法把
 * 底池逐层分给该层有资格的最强手。等强平分。盖牌者贡献死钱但无资格赢取。
 *
 * 输入取自 reduce 后的 GameState(committed / stack / folded / activePlayers)与静态 setup
 * (holeCards / 开局 stack)。返回每家 payout / 终筹 / 净盈亏,便于 UI 展示与链式下一手。
 */

import { evaluate7, compareRank } from './handEvaluator.js'

/**
 * @param {import('../domain/types.js').HandSetup} setup
 * @param {import('../domain/types.js').GameState} state  终局 GameState(已跑到摊牌/弃牌成局)
 * @param {string[]} board 5 张公共牌(摊牌需齐;弃牌成局可不足,不参与评估)
 * @returns {{
 *   potTotal:number,
 *   winners:string[],
 *   payouts:Record<string,number>,
 *   finalStacks:Record<string,number>,
 *   net:Record<string,number>,
 *   showdown:{id:string, score:number[]}[],
 *   showdownReached:boolean,
 * }}
 */
export function settle(setup, state, board) {
  const initialStack = {}
  const holeOf = {}
  for (const p of setup.players) {
    initialStack[p.id] = p.stack
    holeOf[p.id] = p.holeCards
  }
  const committed = {}
  const remainingStack = {}
  for (const p of state.players) {
    committed[p.id] = p.committed
    remainingStack[p.id] = p.stack
  }

  const active = state.activePlayers.slice() // 未盖牌者
  const potTotal = state.pot
  const payouts = {}
  for (const p of setup.players) payouts[p.id] = 0

  /** @type {{id:string, score:number[]}[]} */
  let showdown = []
  let winners = []
  let showdownReached = false

  if (active.length <= 1) {
    // 弃牌成局:唯一在手者独得。
    const w = active[0]
    if (w != null) {
      payouts[w] = potTotal
      winners = [w]
    }
  } else {
    // 摊牌:评估各在手玩家 7 张牌力。
    showdownReached = true
    const score = {}
    for (const id of active) {
      const s = evaluate7([...holeOf[id], ...board])
      score[id] = s
      showdown.push({ id, score: s })
    }

    // 边池分层:按不同 committed 水位切片,每层由「投入达该水位」的玩家均摊,
    // 该层的钱奖给此层「在手且牌力最强」的玩家(等强平分)。
    const levels = [...new Set(Object.values(committed).filter((v) => v > 0))].sort((a, b) => a - b)
    let prev = 0
    let deadCarry = 0 // 某层无在手资格者(死池),留存至末尾归总冠军
    for (const lvl of levels) {
      const layer = lvl - prev
      const contributors = Object.keys(committed).filter((id) => committed[id] >= lvl)
      const potSize = layer * contributors.length
      const eligible = contributors.filter((id) => active.includes(id))
      prev = lvl
      if (eligible.length === 0) {
        deadCarry += potSize
        continue
      }
      let bestScore = null
      let layerWinners = []
      for (const id of eligible) {
        if (bestScore === null) {
          bestScore = score[id]
          layerWinners = [id]
        } else {
          const c = compareRank(score[id], bestScore)
          if (c > 0) {
            bestScore = score[id]
            layerWinners = [id]
          } else if (c === 0) {
            layerWinners.push(id)
          }
        }
      }
      const share = potSize / layerWinners.length
      for (const id of layerWinners) payouts[id] += share
    }

    // 整体最强手(用于 winners 展示,并领取死池残值)。
    let overallBest = null
    for (const id of active) {
      if (overallBest === null || compareRank(score[id], score[overallBest]) > 0) overallBest = id
    }
    winners = active.filter((id) => compareRank(score[id], score[overallBest]) === 0)
    if (deadCarry > 0 && winners.length > 0) {
      const share = deadCarry / winners.length
      for (const id of winners) payouts[id] += share
    }
    showdown.sort((a, b) => compareRank(b.score, a.score))
  }

  const finalStacks = {}
  const net = {}
  for (const p of setup.players) {
    finalStacks[p.id] = remainingStack[p.id] + payouts[p.id]
    net[p.id] = finalStacks[p.id] - initialStack[p.id]
  }

  return { potTotal, winners, payouts, finalStacks, net, showdown, showdownReached }
}
