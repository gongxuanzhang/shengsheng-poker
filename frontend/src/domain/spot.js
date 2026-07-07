/**
 * 翻后 spot 构造工具(供 PostflopSolverPolicy 组装 OpenSpotRequest)。
 *
 * 领域层只负责从 GameState 抽取「与引擎会话对接」所需的局面数值:该街起始底池、有效筹码、
 * OOP/IP 角色、公共牌串。范围(oopRange/ipRange)来自翻前续牌范围(Phase2 注入),下注尺度
 * betSizes 由策略层给定。类型契约见 ./types.js 的 OpenSpotRequest / RangeAssignment。
 *
 * 关键恒等式:pot = 该街起始底池 + Σ 本街 streetCommitted。故起始底池可直接由快照还原,
 * 无需重放日志。
 */

import { oopIpIds } from './positions.js';

/**
 * 当前街的起始底池(本街任何下注之前)。
 * @param {import('./types.js').GameState} state
 * @returns {number}
 */
export function streetStartingPot(state) {
  const streetInvested = state.players.reduce((s, p) => s + p.streetCommitted, 0);
  return state.pot - streetInvested;
}

/**
 * 两人局面的有效筹码 = 两名在手玩家「本街起始筹码」的较小者。
 * 本街起始筹码 = 当前 stack + 本街已投入 streetCommitted。
 * @param {import('./types.js').GameState} state
 * @returns {number}
 */
export function effectiveStack(state) {
  const inHand = state.players.filter((p) => !p.folded);
  if (inHand.length === 0) return 0;
  return Math.min(...inHand.map((p) => p.stack + p.streetCommitted));
}

/**
 * 两人收敛后的 OOP / IP 角色(含玩家派生态)。要求 state.activePlayers.length === 2。
 * @param {import('./types.js').GameState} state
 * @param {import('./types.js').HandSetup} setup 提供位置以定角色
 * @returns {{oopId:string, ipId:string,
 *            oop:import('./types.js').PlayerState, ip:import('./types.js').PlayerState}}
 */
export function rolesForHeadsUp(state, setup) {
  if (state.activePlayers.length !== 2) {
    throw new Error(`rolesForHeadsUp 需恰两名在手玩家,实得 ${state.activePlayers.length}`);
  }
  const { oopId, ipId } = oopIpIds(/** @type {[string,string]} */ (state.activePlayers), setup);
  const find = (id) => state.players.find((p) => p.id === id);
  return { oopId, ipId, oop: find(oopId), ip: find(ipId) };
}

/**
 * 公共牌数组 -> 引擎 spot 的分街字符串。turn/river 未发时为空串。
 * @param {import('./types.js').Card[]} board
 * @returns {{flop:string, turn:string, river:string}}
 */
export function boardToSpot(board) {
  return {
    flop: board.slice(0, 3).join(''),
    turn: board[3] ?? '',
    river: board[4] ?? '',
  };
}

/**
 * 组装 OpenSpotRequest 的「局面」部分(board / 起始底池 / 有效筹码);范围与下注尺度由调用方补齐。
 * 这是领域层与求解会话之间的接缝:PostflopSolverPolicy 拿到范围后合并成完整 OpenSpotRequest。
 * @param {import('./types.js').GameState} state
 * @param {{ranges?:import('./types.js').RangeAssignment, betSizes?:string,
 *           maxIter?:number, targetExpl?:number}} [opts]
 * @returns {import('./types.js').OpenSpotRequest} ranges 缺省时 oopRange/ipRange 为空串(待注入)
 */
export function buildOpenSpotRequest(state, opts = {}) {
  const { flop, turn, river } = boardToSpot(state.board);
  const ranges = opts.ranges;
  /** @type {import('./types.js').OpenSpotRequest} */
  const req = {
    oopRange: ranges?.oopRange ?? '',
    ipRange: ranges?.ipRange ?? '',
    flop,
    turn,
    river,
    startingPot: streetStartingPot(state),
    effectiveStack: effectiveStack(state),
    betSizes: opts.betSizes ?? '',
  };
  if (opts.maxIter != null) req.maxIter = opts.maxIter;
  if (opts.targetExpl != null) req.targetExpl = opts.targetExpl;
  return req;
}
