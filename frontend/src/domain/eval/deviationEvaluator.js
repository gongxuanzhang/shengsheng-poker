/**
 * DeviationEvaluator —— 评估引擎(训练与复盘共用同一实现,零额外求解)。
 *
 * 输入:实选动作 + 该节点的 GTO NodeStrategy(由 GtoPolicy.query 得到);
 * 输出:EV 损失 + 频率偏差 + 严重度分档 + 支撑集标记。它只**读** NodeStrategy,不求解。
 *
 *   EV 损失 = max_a EV[a] − EV[chosen]        // 相对最优动作的期望损失
 *   严重度  按 % of pot 相对分档(跨底池可比,比裸 bb 稳健)
 *   支撑集  chosen 是否在 GTO 支撑集内(inSupport)=> 避免把合法低频混合动作误判为错
 *
 * 类型契约见 ../types.js。本文件是评估契约的单一事实源(见 CLAUDE.md / ARCHITECTURE §7)。
 *
 * @typedef {import('../types.js').DecisionNode} DecisionNode
 * @typedef {import('../types.js').NodeStrategy} NodeStrategy
 * @typedef {import('../types.js').ActionStrategy} ActionStrategy
 * @typedef {import('../types.js').LegalAction} LegalAction
 * @typedef {import('../types.js').DomainAction} DomainAction
 */

/**
 * 偏差严重度分档(按 EV 损失占底池比例)。中文档位:准确/不准确/失误/大漏。
 * @typedef {('accurate'|'inaccurate'|'mistake'|'blunder')} Severity
 */

/**
 * 一次决策评估结果。
 * @typedef {Object} DeviationResult
 * @property {number}   evLoss        max_a EV[a] − EV[chosen](该行动方视角,已 clamp ≥ 0)
 * @property {number}   evLossPctPot  EV 损失占决策点底池(node.state.pot)的百分比(分档依据)
 * @property {Severity} severity
 * @property {boolean}  inSupport     实选动作是否落在 GTO 支撑集内
 * @property {number}   chosenFreq    GTO 对实选动作给出的频率 0~1
 * @property {string}   bestLabel     GTO 最优(最高 EV)动作标签
 * @property {boolean}  approximate   来源是否为近似策略(翻前表/多人)=> 反馈须弱化措辞
 */

/**
 * 默认严重度阈值(EV 损失占底池百分比,单位 %)。
 * 半开区间语义:
 *   accurate   : [0, inaccurate)
 *   inaccurate : [inaccurate, mistake)
 *   mistake    : [mistake, blunder)
 *   blunder    : [blunder, +∞)
 * 可在构造函数用 options.thresholds 覆盖(便于按玩家水平/场景调松紧)。
 * @type {{inaccurate:number, mistake:number, blunder:number}}
 */
export const DEFAULT_SEVERITY_THRESHOLDS = Object.freeze({
  inaccurate: 1,
  mistake: 5,
  blunder: 15,
});

/** inSupport 兜底阈值:仅当 gto 动作条目未显式给出 inSupport 时,用 frequency 判定。 */
const DEFAULT_SUPPORT_THRESHOLD = 0.005;

/** 取一个动作对象上的下注/加注总额(concrete amount),取不到返回 undefined。 */
function amountOf(a) {
  const n = Number(a && a.amount);
  return Number.isFinite(n) ? n : undefined;
}

export class DeviationEvaluator {
  /**
   * @param {Object} [options]
   * @param {{inaccurate?:number, mistake?:number, blunder?:number}} [options.thresholds]
   *        severity 边界(%pot)。缺省用 DEFAULT_SEVERITY_THRESHOLDS。
   * @param {number} [options.supportThreshold]
   *        inSupport 兜底阈值(仅当 gto 未标 inSupport 时用),默认 0.005。
   */
  constructor(options = {}) {
    const t = options.thresholds || {};
    /** @type {{inaccurate:number, mistake:number, blunder:number}} */
    this.thresholds = {
      inaccurate: t.inaccurate ?? DEFAULT_SEVERITY_THRESHOLDS.inaccurate,
      mistake: t.mistake ?? DEFAULT_SEVERITY_THRESHOLDS.mistake,
      blunder: t.blunder ?? DEFAULT_SEVERITY_THRESHOLDS.blunder,
    };
    this.supportThreshold = options.supportThreshold ?? DEFAULT_SUPPORT_THRESHOLD;
  }

  /**
   * 评估一次决策:把实选动作对照该节点 GTO 策略,算出偏差。纯对照 + 算差值,不 solve。
   *
   * @param {LegalAction|DomainAction} chosen 实选动作。只需 `type`;bet/raise/allin 另需 `amount`
   *        (加注到的总额)以在多档尺寸中对齐。训练=实时/bot 采样;复盘=日志动作。
   * @param {NodeStrategy} gto  该决策点的 GTO 策略(actions 与 node.legalActions 对齐)。
   * @param {DecisionNode} node 决策上下文;这里只用 node.state.pot 作 %pot 归一分母。
   * @returns {DeviationResult}
   */
  evaluate(chosen, gto, node) {
    if (!chosen || typeof chosen.type !== 'string') {
      throw new TypeError('DeviationEvaluator.evaluate: chosen 缺少 type');
    }
    if (!gto || !Array.isArray(gto.actions) || gto.actions.length === 0) {
      throw new TypeError('DeviationEvaluator.evaluate: gto.actions 为空,无法对照');
    }
    const pot = node && node.state ? node.state.pot : undefined;
    if (!Number.isFinite(pot) || pot <= 0) {
      throw new RangeError('DeviationEvaluator.evaluate: node.state.pot 必须为正数(用于 %pot 归一)');
    }

    // 1) 最优动作(最高 EV);EV 为该行动方视角,越大越好。严格 > 取首个最大,结果确定。
    let best = gto.actions[0];
    let maxEV = toEV(best);
    for (let i = 1; i < gto.actions.length; i++) {
      const ev = toEV(gto.actions[i]);
      if (ev > maxEV) {
        maxEV = ev;
        best = gto.actions[i];
      }
    }

    // 2) 对齐实选动作到策略条目。
    const matched = this._match(chosen, gto.actions);
    if (!matched) {
      const labels = gto.actions.map((a) => a.label).join(', ');
      const amt = amountOf(chosen);
      const shown = amt === undefined ? chosen.type : `${chosen.type}(${amt})`;
      throw new Error(
        `DeviationEvaluator.evaluate: 实选动作 ${shown} 不在 GTO 策略动作集中(可选: ${labels})`
      );
    }

    const chosenEV = toEV(matched);
    const chosenFreq = clampFreq(matched.frequency);

    // 3) EV 损失与 %pot。chosen 即最优时为 0;clamp 掉浮点噪声导致的负值。
    const evLoss = Math.max(0, maxEV - chosenEV);
    const evLossPctPot = (evLoss / pot) * 100;

    // 4) 支撑集:优先用策略给的 inSupport;缺省则按频率兜底判定。
    const inSupport =
      typeof matched.inSupport === 'boolean'
        ? matched.inSupport
        : chosenFreq > this.supportThreshold;

    return {
      evLoss,
      evLossPctPot,
      severity: this._classify(evLossPctPot),
      inSupport,
      chosenFreq,
      bestLabel: best.label,
      approximate: Boolean(gto.approximate),
    };
  }

  /**
   * 按 %pot 分档。半开区间见 DEFAULT_SEVERITY_THRESHOLDS。
   * @param {number} pct
   * @returns {Severity}
   */
  _classify(pct) {
    const { inaccurate, mistake, blunder } = this.thresholds;
    if (pct < inaccurate) return 'accurate';
    if (pct < mistake) return 'inaccurate';
    if (pct < blunder) return 'mistake';
    return 'blunder';
  }

  /**
   * 把实选动作对齐到某个 ActionStrategy。
   * - fold/check/call:同类型唯一,按 type 命中。
   * - bet/raise/allin:同类型可有多档,按 amount 取最接近者(尽力匹配)。
   * - 跨标注兜底:allin 与 bet/raise 互相回退(引擎/领域对 all-in 的类型标注可能不同)。
   * @param {LegalAction|DomainAction} chosen
   * @param {ActionStrategy[]} actions
   * @returns {ActionStrategy|null}
   */
  _match(chosen, actions) {
    const type = chosen.type;
    const amt = amountOf(chosen);

    let candidates = actions.filter((a) => a.type === type);
    if (candidates.length === 0) {
      // all-in 跨类型回退:领域 'allin' <-> 引擎可能标 bet/raise,反之亦然。
      if (type === 'allin') {
        candidates = actions.filter(
          (a) => a.type === 'bet' || a.type === 'raise' || a.type === 'allin'
        );
      } else if (type === 'bet' || type === 'raise') {
        candidates = actions.filter((a) => a.type === 'allin');
      }
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // 多档同类型:按额度取最近。无额度时退化到第一个。
    if (amt === undefined) return candidates[0];
    let bestMatch = candidates[0];
    let bestDiff = Infinity;
    for (const a of candidates) {
      const aAmt = amountOf(a);
      const diff = aAmt === undefined ? Infinity : Math.abs(aAmt - amt);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestMatch = a;
      }
    }
    return bestMatch;
  }
}

/** 读取并校验一个动作条目的 EV。 */
function toEV(a) {
  const ev = Number(a && a.ev);
  if (!Number.isFinite(ev)) {
    throw new RangeError(
      `DeviationEvaluator: 动作 ${(a && a.label) || '?'} 的 ev 非有限值(${a && a.ev})`
    );
  }
  return ev;
}

/** 频率归一到 [0,1] 的安全数值,非法/缺省视为 0。 */
function clampFreq(f) {
  const n = Number(f);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
