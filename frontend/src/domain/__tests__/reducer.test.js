import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceGameState } from '../reducer.js';
import { deriveDecisionNode } from '../decisionNode.js';
import { legalActions } from '../legalActions.js';
import { streetStartingPot, effectiveStack, rolesForHeadsUp } from '../spot.js';

// 3 人桌:BTN / SB / BB,100bb(stack 200,bb 2)。
function setup3() {
  return {
    players: [
      { id: 'btn', position: 'BTN', stack: 200, isHero: false },
      { id: 'sb', position: 'SB', stack: 200, isHero: false },
      { id: 'bb', position: 'BB', stack: 200, isHero: true },
    ],
    blinds: { sb: 1, bb: 2 },
    buttonPosition: 'BTN',
    heroId: 'bb',
  };
}

const board = ['Qs', '7h', '2c', 'Td', '3s'];
const pget = (st, id) => st.players.find((p) => p.id === id);

test('初始翻前:盲注入池,BTN 先动,currentBet=bb', () => {
  const st = reduceGameState(setup3(), [], 0, board);
  assert.equal(st.street, 'preflop');
  assert.equal(st.pot, 3); // sb1 + bb2
  assert.equal(st.currentBet, 2);
  assert.equal(st.toActId, 'btn');
  assert.equal(pget(st, 'sb').streetCommitted, 1);
  assert.equal(pget(st, 'bb').streetCommitted, 2);
  assert.equal(pget(st, 'btn').streetCommitted, 0);
  assert.equal(st.board.length, 0);
  assert.equal(st.isHeadsUp, false);
});

test('翻前面对下注的合法动作:fold/call/raise/allin,最小加注到=4', () => {
  const st = reduceGameState(setup3(), [], 0, board);
  const acts = legalActions(st);
  const types = acts.map((a) => a.type);
  assert.deepEqual(types, ['fold', 'call', 'raise', 'allin']);
  assert.equal(acts.find((a) => a.type === 'call').amount, 2);
  const raise = acts.find((a) => a.type === 'raise');
  assert.equal(raise.min, 4); // currentBet 2 + 最小加注增量 2
  assert.equal(raise.max, 200);
  assert.equal(acts.find((a) => a.type === 'allin').amount, 200);
});

test('弃牌成局(walk):BTN、SB 弃牌 => BB 获胜,无决策', () => {
  const log = [
    { type: 'fold', playerId: 'btn', street: 'preflop' },
    { type: 'fold', playerId: 'sb', street: 'preflop' },
  ];
  const st = reduceGameState(setup3(), log, log.length, board);
  assert.deepEqual(st.activePlayers, ['bb']);
  assert.equal(st.toActId, null);
  assert.equal(deriveDecisionNode(st, setup3()), null);
});

test('加注-弃牌-跟注推进到翻牌:底池/街/首个行动方正确', () => {
  const log = [
    { type: 'raise', playerId: 'btn', street: 'preflop', amount: 6 },
    { type: 'fold', playerId: 'sb', street: 'preflop' },
    { type: 'call', playerId: 'bb', street: 'preflop', amount: 4 },
  ];
  const st = reduceGameState(setup3(), log, log.length, board);
  assert.equal(st.street, 'flop');
  assert.deepEqual(st.board, ['Qs', '7h', '2c']);
  assert.equal(st.pot, 13); // sb1(弃) + btn6 + bb6
  assert.equal(st.currentBet, 0);
  assert.equal(st.toActId, 'bb'); // SB 弃后 BB 翻后先行动
  assert.equal(st.isHeadsUp, true);
  assert.equal(streetStartingPot(st), 13);
  assert.equal(effectiveStack(st), 194); // 两家各投 6,余 194
});

test('翻牌 check 分支:check/bet/allin;下注后对手最小加注', () => {
  const base = [
    { type: 'raise', playerId: 'btn', street: 'preflop', amount: 6 },
    { type: 'fold', playerId: 'sb', street: 'preflop' },
    { type: 'call', playerId: 'bb', street: 'preflop', amount: 4 },
  ];
  const flopState = reduceGameState(setup3(), base, base.length, board);
  const acts = legalActions(flopState);
  assert.deepEqual(acts.map((a) => a.type), ['check', 'bet', 'allin']);
  assert.equal(acts.find((a) => a.type === 'bet').min, 2); // 最小下注 = bb
  assert.equal(acts.find((a) => a.type === 'bet').max, 194);

  // BB 下注 10,轮到 BTN:最小加注到 = 20
  const log2 = [...base, { type: 'bet', playerId: 'bb', street: 'flop', amount: 10 }];
  const st2 = reduceGameState(setup3(), log2, log2.length, board);
  assert.equal(st2.toActId, 'btn');
  assert.equal(st2.currentBet, 10);
  const raise = legalActions(st2).find((a) => a.type === 'raise');
  assert.equal(raise.min, 20);
  assert.equal(raise.max, 194);
});

test('翻后角色 OOP/IP:BB 为 OOP、BTN 为 IP', () => {
  const base = [
    { type: 'raise', playerId: 'btn', street: 'preflop', amount: 6 },
    { type: 'fold', playerId: 'sb', street: 'preflop' },
    { type: 'call', playerId: 'bb', street: 'preflop', amount: 4 },
  ];
  const st = reduceGameState(setup3(), base, base.length, board);
  const { oopId, ipId } = rolesForHeadsUp(st, setup3());
  assert.equal(oopId, 'bb');
  assert.equal(ipId, 'btn');
});

test('deriveDecisionNode:hero 标记与合法动作透传', () => {
  const st = reduceGameState(setup3(), [], 0, board);
  const node = deriveDecisionNode(st, setup3());
  assert.equal(node.playerId, 'btn');
  assert.equal(node.isHero, false); // hero 是 bb
  assert.equal(node.street, 'preflop');
  assert.ok(node.legalActions.length > 0);
  assert.equal(node.state, st);

  // 推进到 BB 行动点,isHero=true
  const log = [
    { type: 'raise', playerId: 'btn', street: 'preflop', amount: 6 },
    { type: 'fold', playerId: 'sb', street: 'preflop' },
  ];
  const st2 = reduceGameState(setup3(), log, log.length, board);
  const node2 = deriveDecisionNode(st2, setup3());
  assert.equal(node2.playerId, 'bb');
  assert.equal(node2.isHero, true);
});

test('cursor 中途回放:只消费部分动作', () => {
  const log = [
    { type: 'raise', playerId: 'btn', street: 'preflop', amount: 6 },
    { type: 'fold', playerId: 'sb', street: 'preflop' },
    { type: 'call', playerId: 'bb', street: 'preflop', amount: 4 },
  ];
  const s = setup3();
  // 只消费第 1 个动作:SB 尚未行动,轮到 SB
  const st = reduceGameState(s, log, 1, board);
  assert.equal(st.street, 'preflop');
  assert.equal(st.toActId, 'sb');
  assert.equal(st.currentBet, 6);
  assert.equal(st.cursor, 1);
});

test('全下跟注:短码全下与对手全下跟注,跑马到河牌无决策', () => {
  const s = {
    players: [
      { id: 'btn', position: 'BTN', stack: 50, isHero: false },
      { id: 'sb', position: 'SB', stack: 200, isHero: false },
      { id: 'bb', position: 'BB', stack: 200, isHero: true },
    ],
    blinds: { sb: 1, bb: 2 },
    buttonPosition: 'BTN',
    heroId: 'bb',
  };
  const log = [
    { type: 'allin', playerId: 'btn', street: 'preflop' }, // 全下 50
    { type: 'fold', playerId: 'sb', street: 'preflop' },
    { type: 'call', playerId: 'bb', street: 'preflop', amount: 48 }, // 补齐到 50
  ];
  const st = reduceGameState(s, log, log.length, board);
  assert.equal(pget(st, 'btn').allin, true);
  assert.equal(st.toActId, null); // 双方全下/无可行动者
  assert.equal(st.isHeadsUp, true);
  assert.equal(st.pot, 101); // sb1 + btn50 + bb50
});
