/**
 * 座位顺序 / 角色映射工具(纯函数,无状态)。
 *
 * 标准 6-max 物理顺时针环:按钮(BTN)最后,SB 紧接按钮之后。行动顺序都由该环 + 一个锚点旋转得到:
 *   - 翻前:自 BB 之后的座位起,BB 最后行动(大盲有选择权);
 *   - 翻后:自按钮之后的座位起,按钮最后行动(BTN/IP 位置行动权最晚)。
 * 这一套同时正确覆盖满座与单挑(HU 时按钮=SB):见单元测试。
 *
 * 位置字符串契约见 ../types.js 的 Position。
 */

/** 物理顺时针座位环(6-max):SB 紧跟按钮,BTN 为按钮(最后行动)。 */
export const CLOCKWISE = ['SB', 'BB', 'UTG', 'MP', 'CO', 'BTN'];

const RING_SIZE = CLOCKWISE.length;

/**
 * 把出现的位置按「锚点之后的顺时针距离」排序:紧接锚点的座位排第一,锚点自身排最后。
 * 锚点无需真的有人占用(它只是环上的一个槽位)。
 * @param {import('./types.js').Position[]} presentPositions 牌桌上出现的位置(去重)
 * @param {import('./types.js').Position} anchor 锚点位置
 * @returns {import('./types.js').Position[]} 排序后的位置序列
 */
export function orderAfter(presentPositions, anchor) {
  const ai = CLOCKWISE.indexOf(anchor);
  const set = new Set(presentPositions);
  return CLOCKWISE
    .filter((p) => set.has(p))
    .map((p) => ({ p, d: ((CLOCKWISE.indexOf(p) - ai - 1 + RING_SIZE) % RING_SIZE) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.p);
}

/**
 * 位置 -> 玩家 id 映射(每个位置至多一名玩家)。
 * @param {import('./types.js').HandSetup} setup
 * @returns {Record<string,string>} position -> playerId
 */
function positionToId(setup) {
  const map = {};
  for (const pl of setup.players) map[pl.position] = pl.id;
  return map;
}

/**
 * 出现的位置集合。
 * @param {import('./types.js').HandSetup} setup
 * @returns {import('./types.js').Position[]}
 */
function presentPositions(setup) {
  return setup.players.map((p) => p.position);
}

/**
 * 翻前行动顺序(玩家 id 序列):自 BB 之后起,BB 最后。
 * 满座 => UTG..BTN,SB,BB;单挑 => SB,BB(小盲/按钮先动)。
 * @param {import('./types.js').HandSetup} setup
 * @returns {string[]}
 */
export function preflopOrderIds(setup) {
  const posToId = positionToId(setup);
  return orderAfter(presentPositions(setup), 'BB').map((p) => posToId[p]);
}

/**
 * 翻后行动顺序(玩家 id 序列):自按钮之后起,按钮最后。
 * 满座 => SB,BB,..,BTN;单挑 => BB,SB(按钮=SB 后行动)。
 * @param {import('./types.js').HandSetup} setup
 * @returns {string[]}
 */
export function postflopOrderIds(setup) {
  const posToId = positionToId(setup);
  return orderAfter(presentPositions(setup), setup.buttonPosition).map((p) => posToId[p]);
}

/**
 * 翻后位置角色序号:自按钮之后的顺时针距离,越小越早行动(越 OOP)。
 * @param {import('./types.js').Position} position
 * @param {import('./types.js').Position} buttonPosition
 * @returns {number}
 */
export function postflopRoleIndex(position, buttonPosition) {
  const bi = CLOCKWISE.indexOf(buttonPosition);
  return (CLOCKWISE.indexOf(position) - bi - 1 + RING_SIZE) % RING_SIZE;
}

/**
 * 两名玩家的 OOP / IP 划分(翻后 solve 入参角色)。翻后先行动者 = OOP。
 * @param {[string,string]} twoIds 两名在手玩家 id
 * @param {import('./types.js').HandSetup} setup
 * @returns {{oopId:string, ipId:string}}
 */
export function oopIpIds(twoIds, setup) {
  const posOf = {};
  for (const pl of setup.players) posOf[pl.id] = pl.position;
  const [a, b] = twoIds;
  const ra = postflopRoleIndex(posOf[a], setup.buttonPosition);
  const rb = postflopRoleIndex(posOf[b], setup.buttonPosition);
  return ra <= rb ? { oopId: a, ipId: b } : { oopId: b, ipId: a };
}
