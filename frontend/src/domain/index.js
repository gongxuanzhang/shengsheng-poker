/**
 * 领域模型层出口(单一事实源的派生逻辑)。
 *
 *   Hand = { setup, actionLog, boardLog }                       // 事实源(types.js)
 *   GameState    = reduceGameState(setup, actionLog, cursor, boardLog)
 *   DecisionNode = deriveDecisionNode(gameState, setup)
 *   LegalAction[] = legalActions(gameState)
 *
 * 类型契约见 ./types.js;策略层 ./policy/、评估层 ./eval/ 在此之上构建。
 */

export { reduceGameState } from './reducer.js';
export { deriveDecisionNode } from './decisionNode.js';
export { legalActions } from './legalActions.js';
export {
  streetStartingPot,
  effectiveStack,
  rolesForHeadsUp,
  boardToSpot,
  buildOpenSpotRequest,
} from './spot.js';
export {
  CLOCKWISE,
  orderAfter,
  preflopOrderIds,
  postflopOrderIds,
  postflopRoleIndex,
  oopIpIds,
} from './positions.js';
