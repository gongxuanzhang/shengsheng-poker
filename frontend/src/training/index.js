/**
 * 训练编排层出口(P1)。把 P0 domain/policy/eval 串成一手可玩对局。
 *
 *   const s = new TrainingSession({ preflopPolicy, postflopPolicy, evaluator, rng })
 *   s.newHand({ heroPosition })   // 建座/盲注/发牌
 *   await s.advance()             // 自动跑 bot 到 hero 回合或本手结束
 *   s.getDecision()               // 当前 hero 决策节点(+ legalActions)
 *   await s.heroAct(action)       // 提交动作:先反馈后落子再推进
 *   s.getViewState() / s.getFeedbackHistory() / s.getSettlement()
 *
 * 生产接线:preflopPolicy=PreflopChartPolicy,postflopPolicy=PostflopSolverPolicy(包 Worker 会话),
 * evaluator=DeviationEvaluator。测试用 mock 策略确定性驱动(见 __tests__)。
 */

export { TrainingSession } from './session.js'
export { fullDeck, mulberry32, shuffle, dealHand, RANKS, SUITS } from './deck.js'
export { evaluate5, evaluate7, compareRank, CATEGORY_NAME } from './handEvaluator.js'
export { settle } from './settlement.js'
export {
  computePreflopLine,
  deriveContinuation,
  preflopRaiseCount,
  lastPreflopAggressor,
} from './preflopLine.js'
