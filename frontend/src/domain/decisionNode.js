/**
 * deriveDecisionNode(gameState, setup) —— 从 GameState 再派生决策节点。
 *
 * DecisionNode 是训练(写)与复盘(读)共用的统一入参:GtoPolicy.query(node) 只认它。
 * 翻前/翻后差异由 policy 内部消化,主循环不按街 if/else。类型契约见 ./types.js。
 *
 * setup 为可选:提供时才能判定 isHero(GameState 不携带 heroId,故需 setup)。
 * `path`(翻后引擎导航路径)与 `ranges`(翻后双方范围)由 Phase2 策略层填充:
 *   · path   需引擎动作枚举顺序,由 PostflopSolverPolicy 结合当街动作序列计算;
 *   · ranges 由 PreflopChartPolicy.deriveRanges 在收敛两人时注入。
 * 本层只产出与求解无关的结构骨架,保持领域层不依赖引擎。
 */

import { legalActions } from './legalActions.js';

/**
 * @param {import('./types.js').GameState} state
 * @param {import('./types.js').HandSetup} [setup] 提供则据 heroId 判定 isHero
 * @returns {import('./types.js').DecisionNode|null} 无人需行动(toActId 为 null)时返回 null
 */
export function deriveDecisionNode(state, setup) {
  if (!state.toActId) return null;
  return {
    playerId: state.toActId,
    isHero: setup ? setup.heroId === state.toActId : false,
    street: state.street,
    legalActions: legalActions(state),
    state,
    // path / ranges 交由 Phase2 策略层补齐(见文件头)。
  };
}
