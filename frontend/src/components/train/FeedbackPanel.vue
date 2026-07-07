<script setup>
import { computed } from 'vue'
import Term from '../Term.vue'

// hero 决策反馈:翻前用频率维度(GTO 各动作频率 + 是否 inSupport),翻后用 EV 损失/严重度/支撑集。
const props = defineProps({
  record: { type: Object, default: null }, // {street, action, feedback, pot, position}
  gto: { type: Object, default: null }, // NodeStrategy {actions:[{label,type,amount,frequency,ev,inSupport}]}
  history: { type: Array, default: () => [] },
})

const fb = computed(() => props.record?.feedback ?? null)
const skipped = computed(() => Boolean(fb.value?.skipped))
// 翻前查表无 EV(approximate)→ 频率维度;翻后精确 GTO → EV 维度。
const freqMode = computed(() => props.record?.street === 'preflop' || fb.value?.approximate)

const chosenAction = computed(() => props.record?.action ?? null)

function sameAction(a) {
  const c = chosenAction.value
  if (!c || !a) return false
  if (a.type !== c.type) {
    // all-in 与 bet/raise 跨标注:类型不同则不算同一条(简化)
    return false
  }
  if (a.amount == null || c.amount == null) return true
  return Math.abs(Number(a.amount) - Number(c.amount)) < 0.5
}

const gtoActions = computed(() => props.gto?.actions ?? [])

// 频率模式(翻前查表)下的「GTO 最优」= 最高频率动作的 label。
// 翻前无 EV(ev 恒 0),evaluator 的 bestLabel 由 EV argmax 得 → 恒取首个动作(通常 fold),
// 与频率条自相矛盾;故频率模式改用最高频率动作。翻后仍用 EV 版 fb.bestLabel。
const freqBestLabel = computed(() => {
  const acts = gtoActions.value
  if (!acts.length) return fb.value?.bestLabel ?? '?'
  return acts.reduce((b, a) => ((a.frequency ?? 0) > (b.frequency ?? 0) ? a : b)).label
})

// ── 翻前:频率维度评价 ──
const freqVerdict = computed(() => {
  const f = fb.value
  if (!f) return null
  const cf = f.chosenFreq ?? 0
  if (!f.inSupport || cf <= 0) return { key: 'off', text: '明显偏离(不在 GTO 支撑集)', tone: 'blunder' }
  if (cf >= 0.5) return { key: 'main', text: '主线选择', tone: 'accurate' }
  if (cf >= 0.15) return { key: 'mix', text: '合理混合', tone: 'accurate' }
  return { key: 'low', text: '低频/边缘选择', tone: 'inaccurate' }
})

// ── 翻后:严重度 ──
const SEV = {
  accurate: { text: '准确', tone: 'accurate' },
  inaccurate: { text: '不准确', tone: 'inaccurate' },
  mistake: { text: '失误', tone: 'mistake' },
  blunder: { text: '大漏', tone: 'blunder' },
}
const sev = computed(() => SEV[fb.value?.severity] ?? null)

const pct = (x) => (x * 100).toFixed(0) + '%'

// 时间线:每个 hero 决策一条,倒序(最新在上)。
const timeline = computed(() => props.history.slice().reverse())
function chipTone(r) {
  const f = r.feedback
  if (!f || f.skipped) return 'skip'
  if (f.approximate) return f.inSupport ? 'accurate' : 'blunder'
  return f.severity || 'accurate'
}
function chipText(r) {
  const f = r.feedback
  if (!f || f.skipped) return '—'
  if (f.approximate) return f.inSupport ? '在范围' : '偏离'
  return SEV[f.severity]?.text ?? f.severity
}
function actLabel(a) {
  if (!a) return '?'
  const t = { fold: '弃', check: '过', call: '跟', bet: '注', raise: '加', allin: '全下' }[a.type] || a.type
  return a.amount != null ? `${t}${a.amount}` : t
}
</script>

<template>
  <div class="fbpanel">
    <!-- 当前决策反馈 -->
    <div v-if="record" class="fb-current">
      <div class="fb-head">
        <span class="fb-title">决策反馈</span>
        <span class="fb-your">你的选择:<b>{{ actLabel(chosenAction) }}</b>（{{ record.position }}）</span>
      </div>

      <!-- 无法评估(如求解失败) -->
      <div v-if="skipped" class="note skip">
        未能生成反馈:{{ fb.reason }}
      </div>

      <!-- 翻前:频率维度 -->
      <template v-else-if="freqMode">
        <div class="verdict" :class="freqVerdict?.tone">
          <span class="v-badge">{{ freqVerdict?.text }}</span>
          <span class="v-sub">
            GTO 对 <b>{{ actLabel(chosenAction) }}</b> 的频率
            <b>{{ pct(fb.chosenFreq) }}</b> · <Term id="gto" no-click>GTO</Term> 最优 <b>{{ freqBestLabel }}</b>
          </span>
        </div>
        <div class="freq-list">
          <div class="freq-caption">翻前对照标准范围(频率维度,无 <Term id="ev" no-click>EV</Term>):</div>
          <div
            v-for="(a, i) in gtoActions"
            :key="i"
            class="freq-row"
            :class="{ chosen: sameAction(a) }"
          >
            <span class="fa-label">{{ a.label }}</span>
            <span class="fa-bar"><i :style="{ width: pct(a.frequency) }" /></span>
            <span class="fa-num">{{ pct(a.frequency) }}</span>
          </div>
        </div>
      </template>

      <!-- 翻后:EV 损失 / 严重度 / 支撑集 -->
      <template v-else>
        <div class="verdict" :class="sev?.tone">
          <span class="v-badge">{{ sev?.text }}</span>
          <span class="v-sub">
            <Term id="ev" no-click>EV</Term> 损失 <b>{{ fb.evLoss.toFixed(2) }}</b>
            （{{ fb.evLossPctPot.toFixed(1) }}% 底池）·
            {{ fb.inSupport ? '在 GTO 支撑集内' : '不在支撑集' }} ·
            最优 <b>{{ fb.bestLabel }}</b>
          </span>
        </div>
        <div class="freq-list">
          <div class="freq-caption"><Term id="gto" no-click>GTO</Term> 策略(频率 · <Term id="ev" no-click>EV</Term>):</div>
          <div
            v-for="(a, i) in gtoActions"
            :key="i"
            class="freq-row"
            :class="{ chosen: sameAction(a), best: a.label === fb.bestLabel }"
          >
            <span class="fa-label">{{ a.label }}</span>
            <span class="fa-bar"><i :style="{ width: pct(a.frequency) }" /></span>
            <span class="fa-num">{{ pct(a.frequency) }}</span>
            <span class="fa-ev">ev {{ Number(a.ev).toFixed(2) }}</span>
          </div>
        </div>
      </template>
    </div>
    <div v-else class="note idle">尚无决策 · 轮到你时在此显示反馈</div>

    <!-- 时间线 -->
    <div v-if="timeline.length" class="timeline">
      <div class="tl-title">本手决策时间线</div>
      <div
        v-for="(r, i) in timeline"
        :key="i"
        class="tl-row"
      >
        <span class="tl-street">{{ r.street }}</span>
        <span class="tl-act">{{ actLabel(r.action) }}</span>
        <span class="tl-chip" :class="chipTone(r)">{{ chipText(r) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fbpanel { display: flex; flex-direction: column; gap: 14px; }
.fb-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.fb-title { font-size: 12px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: var(--gold, #e7c667); }
.fb-your { font-size: 13px; color: var(--ink-dim, #a9c2b1); }
.fb-your b { color: var(--ink, #ecf4ee); }

.verdict {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.1));
  background: rgba(0, 0, 0, 0.28);
}
.v-badge {
  align-self: flex-start;
  padding: 3px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.5px;
}
.v-sub { font-size: 12.5px; color: var(--ink-dim, #a9c2b1); line-height: 1.5; }
.v-sub b { color: var(--ink, #ecf4ee); font-variant-numeric: tabular-nums; }

/* 严重度配色 */
.verdict.accurate { border-color: rgba(63, 174, 99, 0.5); }
.verdict.accurate .v-badge { background: rgba(63, 174, 99, 0.22); color: #7ee29a; }
.verdict.inaccurate { border-color: rgba(231, 198, 103, 0.5); }
.verdict.inaccurate .v-badge { background: rgba(231, 198, 103, 0.2); color: #f2d879; }
.verdict.mistake { border-color: rgba(230, 145, 60, 0.55); }
.verdict.mistake .v-badge { background: rgba(230, 145, 60, 0.22); color: #f5b169; }
.verdict.blunder { border-color: rgba(200, 60, 50, 0.6); }
.verdict.blunder .v-badge { background: rgba(200, 60, 50, 0.24); color: #ff9d92; }

.freq-list { margin-top: 12px; display: flex; flex-direction: column; gap: 5px; }
.freq-caption { font-size: 11.5px; color: var(--ink-dim, #a9c2b1); margin-bottom: 3px; }
.freq-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 7px;
  border-radius: 7px;
}
.freq-row.chosen { background: rgba(231, 198, 103, 0.14); outline: 1px solid rgba(231, 198, 103, 0.4); }
.freq-row.best .fa-label { color: #7ee29a; }
.fa-label {
  width: 96px;
  flex: none;
  font-size: 12px;
  color: var(--ink, #ecf4ee);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fa-bar {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.fa-bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #d99a2b, #f2d879);
  border-radius: 999px;
}
.fa-num {
  width: 40px;
  text-align: right;
  flex: none;
  font-size: 11.5px;
  color: var(--ink-dim, #a9c2b1);
  font-variant-numeric: tabular-nums;
}
.fa-ev {
  width: 62px;
  text-align: right;
  flex: none;
  font-size: 11px;
  color: var(--ink-dim, #a9c2b1);
  font-variant-numeric: tabular-nums;
}

.note {
  font-size: 13px;
  padding: 12px 14px;
  border-radius: 10px;
  line-height: 1.55;
}
.note.idle { color: var(--ink-dim, #a9c2b1); background: rgba(0, 0, 0, 0.2); }
.note.skip { color: #ffd9d3; background: rgba(139, 26, 18, 0.24); border: 1px solid rgba(200, 60, 50, 0.4); }

/* 时间线 */
.timeline {
  border-top: 1px solid var(--line, rgba(255, 255, 255, 0.1));
  padding-top: 12px;
}
.tl-title { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--ink-dim, #a9c2b1); margin-bottom: 8px; }
.tl-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
  font-size: 12.5px;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
}
.tl-street { width: 58px; flex: none; color: var(--ink-dim, #a9c2b1); text-transform: capitalize; }
.tl-act { flex: 1; color: var(--ink, #ecf4ee); font-variant-numeric: tabular-nums; }
.tl-chip {
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}
.tl-chip.accurate { background: rgba(63, 174, 99, 0.2); color: #7ee29a; }
.tl-chip.inaccurate { background: rgba(231, 198, 103, 0.2); color: #f2d879; }
.tl-chip.mistake { background: rgba(230, 145, 60, 0.22); color: #f5b169; }
.tl-chip.blunder { background: rgba(200, 60, 50, 0.24); color: #ff9d92; }
.tl-chip.skip { background: rgba(255, 255, 255, 0.12); color: var(--ink-dim, #a9c2b1); }
</style>
