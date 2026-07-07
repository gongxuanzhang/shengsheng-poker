<script setup>
import { ref, shallowRef, computed, onBeforeUnmount } from 'vue'
import * as Comlink from 'comlink'
import { TrainingSession } from '../../training/index.js'
import { PreflopChartPolicy } from '../../domain/policy/gtoPolicy.js'
import { PostflopSolverPolicy, createSolverSession } from '../../domain/policy/postflopSolverPolicy.js'
import { DeviationEvaluator } from '../../domain/eval/deviationEvaluator.js'
import PokerTable from './PokerTable.vue'
import ActionBar from './ActionBar.vue'
import FeedbackPanel from './FeedbackPanel.vue'
import HandControls from './HandControls.vue'
import Term from '../Term.vue'

// ─────────────────────────────────────────────────────────────────────────────
// 生产接线:真 PreflopChartPolicy(查表)+ PostflopSolverPolicy(solver.worker 会话)
// + DeviationEvaluator,注入 TrainingSession。整个进程共用一个 Worker(跨手复用)。
// ─────────────────────────────────────────────────────────────────────────────
const worker = new Worker(new URL('../../solver.worker.js', import.meta.url), { type: 'module' })
const remote = Comlink.wrap(worker)
const solverSession = createSolverSession(remote) // { openSpot, queryNode, closeSpot }
const preflopPolicy = new PreflopChartPolicy()
const postflopPolicy = new PostflopSolverPolicy(solverSession, { betSizes: '50%' })
const evaluator = new DeviationEvaluator()
const training = new TrainingSession({ preflopPolicy, postflopPolicy, evaluator, betSizes: '50%' })

// ── 反应式镜像(TrainingSession 是普通类,每步后 sync 拉快照)──
const view = shallowRef(null)
const decision = shallowRef(null)
const history = shallowRef([])
const settlement = shallowRef(null)
const lastRecord = shallowRef(null)
const lastGto = shallowRef(null)

const busy = ref(false)
const busyLabel = ref('')
const elapsed = ref(0)
const err = ref(null)
const handCount = ref(0)
let timer = null

function sync() {
  view.value = training.getViewState()
  decision.value = training.getDecision()
  history.value = training.getFeedbackHistory().slice()
  settlement.value = training.getSettlement()
}

// 求解中启发式:busy 且已过 1.5s(翻后 solve 数十秒;快速的发牌/查表推进不会触及)。
const solving = computed(() => busy.value && elapsed.value >= 1.5)
const isHeroTurn = computed(() => Boolean(view.value?.isHeroTurn) && !busy.value)
const handOver = computed(() => Boolean(view.value?.handOver))
const heroId = computed(() => view.value?.heroId)
const heroNet = computed(() => {
  const s = settlement.value
  if (!s || heroId.value == null) return null
  return s.net?.[heroId.value] ?? 0
})
const winnerText = computed(() => {
  const s = settlement.value
  if (!s) return ''
  const posOf = new Map((view.value?.players ?? []).map((p) => [p.id, p.position]))
  return (s.winners ?? []).map((id) => posOf.get(id) || id).join(' / ')
})

// 弱点统计(供 HandControls)。
const stats = computed(() => {
  const acc = { decisions: 0, deviations: 0 }
  for (const r of history.value) {
    const f = r.feedback
    if (!f || f.skipped) continue
    acc.decisions++
    if (f.approximate) {
      if (!f.inSupport) acc.deviations++
    } else if (f.severity && f.severity !== 'accurate') {
      acc.deviations++
    }
  }
  return acc
})

async function withBusy(label, fn) {
  busy.value = true
  busyLabel.value = label
  err.value = null
  const t0 = performance.now()
  elapsed.value = 0
  timer = setInterval(() => { elapsed.value = (performance.now() - t0) / 1000 }, 100)
  try {
    return await fn()
  } catch (e) {
    err.value = String(e?.message ?? e)
  } finally {
    clearInterval(timer)
    busy.value = false
  }
}

async function newHand() {
  lastRecord.value = null
  lastGto.value = null
  training.newHand()
  handCount.value += 1
  sync()
  // advance 会自动跑 bot 到 hero 回合或本手结束;bot 翻后决策可能触发 solve(30-45s)。
  await withBusy('发牌 · 推进中', async () => { await training.advance() })
  sync()
}

async function submit(action) {
  const node = training.getDecision()
  if (!node) return
  const preflop = node.street === 'preflop'
  await withBusy(preflop ? '对照标准范围' : '求解中', async () => {
    // 先取完整 GTO 策略供反馈面板展示(翻后此步触发/复用同一 spot 的 solve,故 loading 包住它)。
    let gto = null
    try {
      gto = preflop ? await preflopPolicy.query(node) : await postflopPolicy.query(node)
    } catch {
      gto = null
    }
    const record = await training.heroAct(action) // 内部再评估并推进(query 命中缓存)
    lastGto.value = gto
    lastRecord.value = record
  })
  sync()
}

onBeforeUnmount(async () => {
  try { await postflopPolicy.dispose() } catch { /* ignore */ }
  worker.terminate()
})

// 起手
newHand()
</script>

<template>
  <div class="trainer">
    <header class="t-hero">
      <h1><span class="spade">♠</span> 训练场 · <span class="accent">Heads-Up</span> GTO</h1>
      <p class="sub">9 人桌翻前查表 · 收敛两人进 <Term id="postflop">后翻牌</Term> 精确 <Term id="gto">GTO</Term> · 每步对照评分</p>
    </header>

    <!-- 牌桌 -->
    <PokerTable :view="view" />

    <!-- 状态横幅 -->
    <div class="banners">
      <div v-if="err" class="banner err">{{ err }}</div>
      <div v-if="busy" class="banner busy">
        <span class="dot" />
        {{ solving ? '求解中' : busyLabel }}
        <span v-if="busy && elapsed >= 1" class="tmr">{{ elapsed.toFixed(1) }}s</span>
        <span v-if="solving" class="hint">· 翻后一次性求解,请稍候</span>
      </div>
      <div v-if="view && view.multiway" class="banner info">
        多人底池:翻后无 <Term id="gto">GTO</Term> 精确解,本手不训练翻后,跑完公共牌直接摊牌。
      </div>
      <div v-else-if="view && !view.multiway && view.postflopTrained === false && view.street !== 'preflop' && !handOver" class="banner info">
        已有一方全下:无翻后决策,跑马至摊牌。
      </div>
    </div>

    <!-- 结算 -->
    <section v-if="handOver && settlement" class="panel settle">
      <div class="settle-head">
        <span class="s-title">本手结束</span>
        <span class="s-reason">{{ view.handOverReason }}</span>
      </div>
      <div class="settle-body">
        <div class="s-item">
          <span class="s-lbl">赢家</span>
          <span class="s-val">{{ winnerText || '—' }}</span>
        </div>
        <div class="s-item">
          <span class="s-lbl">底池</span>
          <span class="s-val">{{ settlement.potTotal }}</span>
        </div>
        <div class="s-item">
          <span class="s-lbl">你的盈亏</span>
          <span class="s-val" :class="heroNet > 0 ? 'pos' : heroNet < 0 ? 'neg' : ''">
            {{ heroNet > 0 ? '+' : '' }}{{ heroNet }}
          </span>
        </div>
        <div class="s-item">
          <span class="s-lbl">摊牌</span>
          <span class="s-val">{{ settlement.showdownReached ? '是' : '否' }}</span>
        </div>
      </div>
    </section>

    <!-- 动作栏(hero 回合) -->
    <section v-if="isHeroTurn && decision" class="panel act-panel">
      <ActionBar :decision="decision" :disabled="busy" @act="submit" />
    </section>

    <!-- 反馈 -->
    <section class="panel fb-panel">
      <FeedbackPanel :record="lastRecord" :gto="lastGto" :history="history" />
    </section>

    <!-- 控制 -->
    <section class="panel ctrl-panel">
      <HandControls
        :hand-count="handCount"
        :hand-over="handOver"
        :busy="busy"
        :stats="stats"
        @new-hand="newHand"
      />
    </section>
  </div>
</template>

<style scoped>
.trainer {
  /* 共享军绿主题变量(子组件通过 CSS 自定义属性继承复用) */
  color-scheme: dark;
  --ink: #ecf4ee;
  --ink-dim: #a9c2b1;
  --gold: #e7c667;
  --line: rgba(255, 255, 255, 0.1);
  --panel: rgba(8, 24, 15, 0.52);
  --field: rgba(0, 0, 0, 0.3);
  min-height: 100svh;
  color: var(--ink);
  font-family: system-ui, 'Segoe UI', Roboto, sans-serif;
  background: radial-gradient(ellipse 120% 85% at 50% -8%, #46704f 0%, #2f5039 42%, #1d3626 74%, #142a1d 100%);
  padding: clamp(16px, 3vw, 30px) clamp(12px, 3vw, 26px) 60px;
  box-sizing: border-box;
}
.trainer > * { max-width: 820px; margin-left: auto; margin-right: auto; }

.t-hero { text-align: center; margin-bottom: 14px; }
.t-hero h1 {
  margin: 0;
  font-size: clamp(21px, 4vw, 32px);
  font-weight: 700;
  letter-spacing: -0.5px;
  color: #fbfdf9;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}
.t-hero h1 .spade { color: var(--gold); }
.t-hero h1 .accent { color: var(--gold); font-style: italic; }
.t-hero .sub { margin: 7px 0 0; font-size: 12.5px; letter-spacing: 0.4px; color: var(--ink-dim); }

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 18px;
  margin-top: 14px;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(6px);
}

.banners { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.banner {
  font-size: 13px;
  padding: 10px 14px;
  border-radius: 10px;
  line-height: 1.5;
}
.banner.err { color: #ffb4ae; background: rgba(139, 0, 0, 0.22); border: 1px solid rgba(255, 120, 110, 0.3); white-space: pre-wrap; }
.banner.busy {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--ink-dim);
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid var(--line);
}
.banner.busy .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gold); animation: pulse 1.2s ease-out infinite; }
.banner.busy .tmr { color: var(--gold); font-weight: 700; font-variant-numeric: tabular-nums; }
.banner.busy .hint { color: var(--ink-dim); opacity: 0.8; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(231, 198, 103, 0.5); } 100% { box-shadow: 0 0 0 8px rgba(231, 198, 103, 0); } }
.banner.info {
  color: #ecf4ee;
  background: rgba(20, 42, 30, 0.6);
  border: 1px solid rgba(231, 198, 103, 0.3);
}

/* 结算 */
.settle-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
.s-title { font-size: 13px; font-weight: 800; letter-spacing: 0.6px; color: var(--gold); }
.s-reason { font-size: 12px; color: var(--ink-dim); }
.settle-body { display: flex; flex-wrap: wrap; gap: 10px; }
.s-item {
  flex: 1 1 auto;
  min-width: 110px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.26);
  border: 1px solid var(--line);
}
.s-lbl { font-size: 10.5px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--ink-dim); }
.s-val { font-size: 16px; font-weight: 800; color: var(--ink); font-variant-numeric: tabular-nums; }
.s-val.pos { color: #7ee29a; }
.s-val.neg { color: #ff9d92; }
</style>
