import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderAfter,
  preflopOrderIds,
  postflopOrderIds,
  oopIpIds,
  postflopRoleIndex,
} from '../positions.js';

const ring9 = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

function setup9() {
  return {
    players: ring9.map((pos) => ({ id: pos.toLowerCase(), position: pos, stack: 200 })),
    blinds: { sb: 1, bb: 2 },
    buttonPosition: 'BTN',
    heroId: 'bb',
  };
}

function setupHU() {
  // 单挑:按钮 = SB
  return {
    players: [
      { id: 'sb', position: 'SB', stack: 200 },
      { id: 'bb', position: 'BB', stack: 200 },
    ],
    blinds: { sb: 1, bb: 2 },
    buttonPosition: 'SB',
    heroId: 'bb',
  };
}

test('满座翻前顺序:UTG 先动,BB 最后', () => {
  assert.deepEqual(
    preflopOrderIds(setup9()),
    ['utg', 'utg1', 'utg2', 'lj', 'hj', 'co', 'btn', 'sb', 'bb'],
  );
});

test('满座翻后顺序:SB 先动,BTN 最后', () => {
  assert.deepEqual(
    postflopOrderIds(setup9()),
    ['sb', 'bb', 'utg', 'utg1', 'utg2', 'lj', 'hj', 'co', 'btn'],
  );
});

test('单挑翻前 SB 先动;翻后 BB 先动', () => {
  assert.deepEqual(preflopOrderIds(setupHU()), ['sb', 'bb']);
  assert.deepEqual(postflopOrderIds(setupHU()), ['bb', 'sb']);
});

test('orderAfter 锚点自身排最后', () => {
  assert.deepEqual(orderAfter(['SB', 'BB', 'BTN'], 'BB'), ['BTN', 'SB', 'BB']);
});

test('OOP/IP:翻后先行动者为 OOP', () => {
  const s = setup9();
  // BB 比 BTN 早行动(翻后)=> BB 为 OOP
  assert.deepEqual(oopIpIds(['btn', 'bb'], s), { oopId: 'bb', ipId: 'btn' });
  assert.ok(postflopRoleIndex('BB', 'BTN') < postflopRoleIndex('BTN', 'BTN'));
});
