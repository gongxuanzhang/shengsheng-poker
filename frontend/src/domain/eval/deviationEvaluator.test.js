/**
 * DeviationEvaluator 单元测试。零依赖:用 Node 内置 test runner。
 *   运行:node --test frontend/src/domain/eval/
 * 不引入 vitest/jest,契合「不新增未安装依赖」。测试文件不被 app 引用,vite build 不打包。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviationEvaluator, DEFAULT_SEVERITY_THRESHOLDS } from './deviationEvaluator.js';

/** 构造一个只含 %pot 归一分母的最小 node。 */
const nodeWithPot = (pot) => ({ state: { pot } });

/** 构造一条 gto 策略。 */
const strategy = (actions, extra = {}) => ({
  street: 'flop',
  source: 'postflop-solver',
  approximate: false,
  actions,
  ...extra,
});

const ev = new DeviationEvaluator();

test('chosen 即最优动作 -> evLoss 0 / accurate / inSupport', () => {
  const gto = strategy([
    { label: 'Check', type: 'check', ev: 10, frequency: 0.7, inSupport: true },
    { label: 'Bet(75)', type: 'bet', amount: 75, ev: 8, frequency: 0.3, inSupport: true },
  ]);
  const r = ev.evaluate({ type: 'check' }, gto, nodeWithPot(100));
  assert.equal(r.evLoss, 0);
  assert.equal(r.evLossPctPot, 0);
  assert.equal(r.severity, 'accurate');
  assert.equal(r.inSupport, true);
  assert.equal(r.chosenFreq, 0.7);
  assert.equal(r.bestLabel, 'Check');
  assert.equal(r.approximate, false);
});

test('次优但小额损失 -> inaccurate,且 EV 损失 = maxEV − chosenEV', () => {
  const gto = strategy([
    { label: 'Check', type: 'check', ev: 10, frequency: 0.7, inSupport: true },
    { label: 'Bet(75)', type: 'bet', amount: 75, ev: 8, frequency: 0.3, inSupport: true },
  ]);
  const r = ev.evaluate({ type: 'bet', amount: 75 }, gto, nodeWithPot(100));
  assert.equal(r.evLoss, 2); // 10 - 8
  assert.equal(r.evLossPctPot, 2); // 2/100 = 2%
  assert.equal(r.severity, 'inaccurate'); // [1,5)
  assert.equal(r.inSupport, true);
  assert.equal(r.chosenFreq, 0.3);
  assert.equal(r.bestLabel, 'Check');
});

test('中等损失 -> mistake;非支撑动作 inSupport=false / chosenFreq=0', () => {
  const gto = strategy([
    { label: 'Bet(50)', type: 'bet', amount: 50, ev: 10, frequency: 1, inSupport: true },
    { label: 'Fold', type: 'fold', ev: 0, frequency: 0, inSupport: false },
  ]);
  const r = ev.evaluate({ type: 'fold' }, gto, nodeWithPot(100));
  assert.equal(r.evLoss, 10);
  assert.equal(r.evLossPctPot, 10); // [5,15) -> mistake
  assert.equal(r.severity, 'mistake');
  assert.equal(r.inSupport, false);
  assert.equal(r.chosenFreq, 0);
  assert.equal(r.bestLabel, 'Bet(50)');
});

test('大额损失 -> blunder', () => {
  const gto = strategy([
    { label: 'Call', type: 'call', ev: 10, frequency: 1, inSupport: true },
    { label: 'Fold', type: 'fold', ev: -20, frequency: 0, inSupport: false },
  ]);
  const r = ev.evaluate({ type: 'fold' }, gto, nodeWithPot(100));
  assert.equal(r.evLoss, 30);
  assert.equal(r.evLossPctPot, 30); // >=15 -> blunder
  assert.equal(r.severity, 'blunder');
});

test('%pot 相对分档:同样 30 筹码损失,大底池更宽容', () => {
  const gto = strategy([
    { label: 'Call', type: 'call', ev: 10, frequency: 1, inSupport: true },
    { label: 'Fold', type: 'fold', ev: -20, frequency: 0, inSupport: false },
  ]);
  const small = ev.evaluate({ type: 'fold' }, gto, nodeWithPot(100));
  const big = ev.evaluate({ type: 'fold' }, gto, nodeWithPot(600));
  assert.equal(small.severity, 'blunder'); // 30/100 = 30%
  assert.equal(big.evLossPctPot, 5); // 30/600 = 5%
  assert.equal(big.severity, 'mistake'); // 同样筹码,大池更轻
});

test('多档下注按 amount 取最接近者', () => {
  const gto = strategy([
    { label: 'Check', type: 'check', ev: 9, frequency: 0.5, inSupport: true },
    { label: 'Bet(33)', type: 'bet', amount: 33, ev: 6, frequency: 0.25, inSupport: true },
    { label: 'Bet(75)', type: 'bet', amount: 75, ev: 8, frequency: 0.25, inSupport: true },
  ]);
  const r = ev.evaluate({ type: 'bet', amount: 70 }, gto, nodeWithPot(100));
  assert.equal(r.chosenFreq, 0.25);
  assert.equal(r.evLoss, 1); // 命中 Bet(75): 9 - 8
  assert.equal(r.bestLabel, 'Check');
});

test('inSupport 缺省时按 frequency 兜底判定', () => {
  const gto = strategy([
    { label: 'Check', type: 'check', ev: 10, frequency: 0.2 }, // 无 inSupport 字段
    { label: 'Bet(50)', type: 'bet', amount: 50, ev: 10, frequency: 0 }, // 频率 0
  ]);
  const inSup = ev.evaluate({ type: 'check' }, gto, nodeWithPot(100));
  assert.equal(inSup.inSupport, true); // 0.2 > 0.005
  const outSup = ev.evaluate({ type: 'bet', amount: 50 }, gto, nodeWithPot(100));
  assert.equal(outSup.inSupport, false); // 0 不 > 0.005
});

test('all-in 跨类型回退:领域 allin 命中引擎标为 bet 的满注条目', () => {
  const gto = strategy([
    { label: 'Check', type: 'check', ev: 5, frequency: 0.5, inSupport: true },
    { label: 'AllIn(200)', type: 'bet', amount: 200, ev: 12, frequency: 0.5, inSupport: true },
  ]);
  const r = ev.evaluate({ type: 'allin', amount: 200 }, gto, nodeWithPot(100));
  assert.equal(r.chosenFreq, 0.5);
  assert.equal(r.evLoss, 0); // all-in 即最优
  assert.equal(r.bestLabel, 'AllIn(200)');
});

test('approximate 透传(翻前表/多人来源须弱化措辞)', () => {
  const gto = strategy(
    [{ label: 'Raise', type: 'raise', amount: 3, ev: 1, frequency: 1, inSupport: true }],
    { approximate: true, source: 'preflop-chart' }
  );
  const r = ev.evaluate({ type: 'raise', amount: 3 }, gto, nodeWithPot(1.5));
  assert.equal(r.approximate, true);
});

test('自定义阈值可放松/收紧分档', () => {
  const loose = new DeviationEvaluator({ thresholds: { inaccurate: 3, mistake: 8, blunder: 20 } });
  const gto = strategy([
    { label: 'Check', type: 'check', ev: 10, frequency: 0.5, inSupport: true },
    { label: 'Bet(50)', type: 'bet', amount: 50, ev: 8, frequency: 0.5, inSupport: true },
  ]);
  // 2% pot:默认 -> inaccurate;放松阈值(inaccurate=3)-> accurate
  assert.equal(ev.evaluate({ type: 'bet', amount: 50 }, gto, nodeWithPot(100)).severity, 'inaccurate');
  assert.equal(loose.evaluate({ type: 'bet', amount: 50 }, gto, nodeWithPot(100)).severity, 'accurate');
});

test('浮点噪声导致的负 evLoss 被 clamp 到 0', () => {
  const gto = strategy([
    { label: 'Check', type: 'check', ev: 10.0000001, frequency: 0.5, inSupport: true },
    { label: 'Bet(50)', type: 'bet', amount: 50, ev: 10, frequency: 0.5, inSupport: true },
  ]);
  const r = ev.evaluate({ type: 'check' }, gto, nodeWithPot(100));
  assert.equal(r.evLoss, 0);
  assert.equal(r.severity, 'accurate');
});

test('frequency 越界被安全归一到 [0,1]', () => {
  const gto = strategy([
    { label: 'Check', type: 'check', ev: 10, frequency: 1.4, inSupport: true },
    { label: 'Bet(50)', type: 'bet', amount: 50, ev: 9, frequency: -0.2, inSupport: false },
  ]);
  assert.equal(ev.evaluate({ type: 'check' }, gto, nodeWithPot(100)).chosenFreq, 1);
  assert.equal(ev.evaluate({ type: 'bet', amount: 50 }, gto, nodeWithPot(100)).chosenFreq, 0);
});

test('实选动作不在策略动作集 -> 抛错(契约要求 actions 与 legalActions 对齐)', () => {
  const gto = strategy([
    { label: 'Check', type: 'check', ev: 10, frequency: 1, inSupport: true },
    { label: 'Bet(50)', type: 'bet', amount: 50, ev: 9, frequency: 0, inSupport: false },
  ]);
  assert.throws(() => ev.evaluate({ type: 'raise', amount: 20 }, gto, nodeWithPot(100)), /不在 GTO 策略动作集/);
});

test('空动作集 / 非法底池 / 缺 type 均抛错', () => {
  const okAction = [{ label: 'Check', type: 'check', ev: 1, frequency: 1, inSupport: true }];
  assert.throws(() => ev.evaluate({ type: 'check' }, strategy([]), nodeWithPot(100)), TypeError);
  assert.throws(() => ev.evaluate({ type: 'check' }, strategy(okAction), nodeWithPot(0)), RangeError);
  assert.throws(() => ev.evaluate({ type: 'check' }, strategy(okAction), { state: {} }), RangeError);
  assert.throws(() => ev.evaluate({}, strategy(okAction), nodeWithPot(100)), TypeError);
});

test('非有限 EV 抛错', () => {
  const gto = strategy([{ label: 'Check', type: 'check', ev: NaN, frequency: 1, inSupport: true }]);
  assert.throws(() => ev.evaluate({ type: 'check' }, gto, nodeWithPot(100)), RangeError);
});

test('导出的默认阈值稳定(供 UI 图例复用)', () => {
  assert.deepEqual(DEFAULT_SEVERITY_THRESHOLDS, { inaccurate: 1, mistake: 5, blunder: 15 });
});
