<script setup>
import { ref, reactive, computed } from 'vue'
import * as Comlink from 'comlink'
import Card from './Card.vue'
import Term from './Term.vue'

const RANKS = 'AKQJT98765432' // index 0=A .. 12=2
const rankList = RANKS.split('') // 供 13×13 网格轴标签使用

function actionColor(label) {
  if (label.startsWith('Fold')) return '#9aa0a6'
  if (label.startsWith('Check') || label.startsWith('Call')) return '#34a853'
  if (label.startsWith('AllIn')) return '#8b0000'
  return '#f9a825' // Bet / Raise
}

// 把动态动作标签（如 'Bet 50%' / 'Raise 2.5x' / 'AllIn'）映射到术语词典 id，纯展示用
function actionTermId(label) {
  if (label.startsWith('Fold')) return 'fold'
  if (label.startsWith('Check')) return 'check'
  if (label.startsWith('Call')) return 'call'
  if (label.startsWith('AllIn')) return 'allin'
  if (label.startsWith('Raise')) return 'raise'
  return 'bet' // Bet / 兜底
}

// board 用单框输入,提交前拆成 flop(6)/turn(2)/river(2)
const boardStr = ref('Qs7h2c2d') // 默认 TURN 局面(亚秒收敛;flop 单线程要 30-45s)
const cfg = reactive({
  oop: '88-22,AJs-A8s,KTs-K9s,QTs-Q9s,J9s+,T9s,98s,87s,76s,AJo,ATo,KQo',
  ip: 'TT-22,AQs-A2s,K9s+,Q9s+,J9s+,T8s+,98s,87s,76s,AQo+,KJo+,QJo',
  pot: 55,
  stack: 100,
  bet: '50%',
})
function splitBoard(b) {
  const s = b.trim().replace(/\s+/g, '')
  return { flop: s.slice(0, 6), turn: s.slice(6, 8), river: s.slice(8, 10) }
}

// 把 board 输入实时解析为 5 张牌槽(flop×3 / turn / river);缺牌为空串 -> 占位。仅视觉,不影响求解。
const boardCards = computed(() => {
  const s = boardStr.value.trim().replace(/\s+/g, '')
  const slots = []
  for (let i = 0; i < 5; i++) slots.push(s.slice(i * 2, i * 2 + 2) || '')
  return slots
})

const busy = ref(false)
const err = ref(null)
const elapsed = ref(0)
const expl = ref(null)
const memMB = ref(null)
const actions = ref([])
const overall = ref([])
const grid = ref([])

// 'AsKs' -> [行,列]: 高rank行/低rank列, 同花上三角, 不同花下三角, 对子对角
function handToRC(h) {
  const r1 = RANKS.indexOf(h[0]), s1 = h[1]
  const r2 = RANKS.indexOf(h[2]), s2 = h[3]
  const hi = Math.min(r1, r2), lo = Math.max(r1, r2)
  if (r1 === r2) return [hi, hi]
  if (s1 === s2) return [hi, lo]
  return [lo, hi]
}

async function run() {
  // 数值健壮性:清空输入会得到非数字(''/NaN),先做校验并给出友好提示,避免把 NaN 传给 Rust 求解器
  if (!Number.isFinite(cfg.pot) || cfg.pot <= 0 || !Number.isFinite(cfg.stack) || cfg.stack <= 0) {
    err.value = '底池与有效筹码需为正数'
    return
  }
  busy.value = true
  err.value = null
  expl.value = null
  grid.value = []
  const t0 = performance.now()
  const timer = setInterval(() => { elapsed.value = (performance.now() - t0) / 1000 }, 100)
  const worker = new Worker(new URL('../solver.worker.js', import.meta.url), { type: 'module' })
  const remote = Comlink.wrap(worker)
  try {
    const { flop, turn, river } = splitBoard(boardStr.value)
    const res = await remote.solve({ ...cfg, flop, turn, river })
    expl.value = res.exploitability
    memMB.value = res.memory_bytes / 1048576
    actions.value = res.actions
    overall.value = res.overall_freq

    const N = res.num_hands, A = res.num_actions
    // 聚合 169 格:按 weights 加权累加动作频率/equity/ev
    const cells = Array.from({ length: 169 }, () => ({
      label: '', freq: Array(A).fill(0), equity: 0, ev: 0, weight: 0,
    }))
    for (let h = 0; h < N; h++) {
      const [r, c] = handToRC(res.hands[h])
      const cell = cells[r * 13 + c]
      const w = res.weights[h]
      cell.weight += w
      cell.equity += res.equity[h] * w
      cell.ev += res.ev[h] * w
      for (let a = 0; a < A; a++) cell.freq[a] += res.strategy[a * N + h] * w
    }
    for (let r = 0; r < 13; r++) {
      for (let c = 0; c < 13; c++) {
        const cell = cells[r * 13 + c]
        cell.label = r === c ? RANKS[r] + RANKS[c]
          : c > r ? RANKS[r] + RANKS[c] + 's'
          : RANKS[c] + RANKS[r] + 'o'
        if (cell.weight > 0) {
          for (let a = 0; a < A; a++) cell.freq[a] /= cell.weight
          cell.equity /= cell.weight
          cell.ev /= cell.weight
        }
      }
    }
    grid.value = cells
  } catch (e) {
    err.value = String(e?.message ?? e)
  } finally {
    clearInterval(timer)
    busy.value = false
    worker.terminate() // 每次 Solve 新建+销毁,顺带隔离潜在 panic 毒化
  }
}

function cellStyle(cell) {
  if (cell.weight <= 0) return { background: '#1a1a1a', opacity: 0.2 }
  let acc = 0
  const stops = []
  actions.value.forEach((lab, a) => {
    const col = actionColor(lab)
    const from = acc * 100
    acc += cell.freq[a]
    const to = acc * 100
    stops.push(`${col} ${from}%`, `${col} ${to}%`)
  })
  return { background: `linear-gradient(90deg, ${stops.join(',')})` }
}

function cellTitle(cell) {
  const acts = actions.value.map((a, i) => `${a}: ${(cell.freq[i] * 100).toFixed(0)}%`).join('  ')
  return `${cell.label}\n${acts}\neq ${(cell.equity * 100).toFixed(1)}%  ev ${cell.ev.toFixed(1)}`
}
</script>

<template>
  <div class="solver">
    <div class="felt">
      <!-- 标题 -->
      <header class="hero">
        <h1><span class="spade">♠</span> 德州扑克 <span class="accent"><Term id="gto">GTO</Term></span> <Term id="solver">Solver</Term></h1>
        <p class="sub">浏览器内 <Term id="wasm">WASM</Term> 实时求解 · <Term id="postflop">后翻牌</Term>博弈最优策略</p>
      </header>

      <!-- 输入面板 -->
      <section class="panel form">
        <label class="field span">
          <span class="flabel"><Term id="oop">OOP</Term> <Term id="range">范围</Term></span>
          <textarea v-model="cfg.oop" rows="2" spellcheck="false" />
        </label>
        <label class="field span">
          <span class="flabel"><Term id="ip">IP</Term> <Term id="range">范围</Term></span>
          <textarea v-model="cfg.ip" rows="2" spellcheck="false" />
        </label>
        <div class="field-row">
          <label class="field grow">
            <span class="flabel"><Term id="board">Board</Term></span>
            <input v-model="boardStr" spellcheck="false" />
          </label>
          <label class="field mini">
            <span class="flabel"><Term id="pot">底池</Term></span>
            <input type="number" v-model.number="cfg.pot" />
          </label>
          <label class="field mini">
            <span class="flabel"><Term id="stack">有效筹码</Term></span>
            <input type="number" v-model.number="cfg.stack" />
          </label>
          <label class="field mini">
            <span class="flabel"><Term id="bet">下注</Term></span>
            <input v-model="cfg.bet" />
          </label>
        </div>
        <div class="actions">
          <button class="solve" :disabled="busy" @click="run">
            <span v-if="busy" class="spinner" aria-hidden="true"></span>
            <template v-if="busy">求解中…</template>
            <Term v-else id="solver" no-click>Solve</Term>
          </button>
        </div>
      </section>

      <!-- 牌桌:公共牌以拟真扑克牌卡片实时呈现 -->
      <section class="board-stage">
        <div class="stage-head">
          <span class="stage-title"><Term id="board">公共牌 · Board</Term></span>
          <span class="stage-meta"><Term id="stack">有效筹码</Term> {{ cfg.stack }} ｜ <Term id="bet">下注</Term> {{ cfg.bet }}</span>
        </div>
        <div class="board-cards">
          <Card
            v-for="(c, i) in boardCards"
            :key="i"
            :card="c"
            :placeholder="!c"
            size="lg"
            :class="{ street: i >= 3 }"
          />
        </div>
        <div class="pot-row">
          <div class="felt-chip">
            <span class="felt-chip-lbl"><Term id="pot">POT</Term></span>
            <span class="felt-chip-val">{{ cfg.pot }}</span>
          </div>
        </div>
        <div class="street-labels">
          <span><Term id="flop">Flop</Term></span>
          <span><Term id="turn">Turn</Term></span>
          <span><Term id="river">River</Term></span>
        </div>
      </section>

      <!-- 状态 / 收敛信息 -->
      <p v-if="err" class="err">{{ err }}</p>
      <div class="statusbar">
        <span v-if="busy" class="status live">
          <span class="dot"></span>求解中 {{ elapsed.toFixed(1) }}s ·一次性求解，请稍候
        </span>
        <template v-if="memMB !== null && !busy">
          <span class="badge"><Term id="mem">内存</Term> <b>{{ memMB.toFixed(1) }}</b> <Term id="mb">MB</Term></span>
          <span class="badge"><Term id="exploitability">exploitability</Term> <b>{{ expl?.toFixed(3) }}</b></span>
        </template>
      </div>

      <!-- 整体动作频率 -->
      <template v-if="actions.length">
        <div class="legend">
          <span v-for="(a, i) in actions" :key="i" class="chip">
            <i :style="{ background: actionColor(a) }" />
            <span class="chip-lab"><Term :id="actionTermId(a)">{{ a }}</Term></span>
            <b>{{ (overall[i] * 100).toFixed(1) }}%</b>
          </span>
        </div>
        <div class="overallbar">
          <div
            v-for="(a, i) in actions"
            :key="i"
            class="seg"
            :style="{ width: overall[i] * 100 + '%', background: actionColor(a) }"
          />
        </div>
      </template>

      <!-- 13×13 策略网格 -->
      <section v-if="grid.length" class="matrix-wrap">
        <div class="matrix">
          <div class="matrix-top">
            <span class="corner-cell"></span>
            <span v-for="r in rankList" :key="'t' + r" class="axis">{{ r }}</span>
          </div>
          <div class="matrix-body">
            <div class="matrix-left">
              <span v-for="r in rankList" :key="'l' + r" class="axis">{{ r }}</span>
            </div>
            <div class="grid">
              <div
                v-for="(cell, k) in grid"
                :key="k"
                class="cell"
                :style="cellStyle(cell)"
                :title="cellTitle(cell)"
              >
                {{ cell.label }}
              </div>
            </div>
          </div>
        </div>
        <p class="matrix-hint">
          格内彩色比例即 <Term id="mixed">混合策略</Term> 各动作占比 ·
          右上三角=<Term id="suited">s</Term> 同花，左下三角=<Term id="offsuit">o</Term> 不同花，对角=对子 ·
          悬停格子查看 <Term id="equity">equity</Term> 与 <Term id="ev">EV</Term>
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 满屏牌桌的容器契约(#app 满宽复位 + body 深绿底色)已上移到全局 src/style.css,
   避免叶子组件用 :global(...) 静默改写文档级样式。此处只负责视图内部样式。 */
.solver {
  color-scheme: dark; /* 统一深色原生控件(number 微调箭头/滚动条),覆盖 :root 的 light dark */
  --ink: #ecf4ee;
  --ink-dim: #a9c2b1;
  --gold: #e7c667;
  --line: rgba(255, 255, 255, 0.10);
  --panel: rgba(8, 24, 15, 0.52);
  --field: rgba(0, 0, 0, 0.30);
  --cell: 36px;
  --gap: 3px;
  --axis: 22px;
  --axisgap: 6px;
  min-height: 100svh;
  color: var(--ink);
  font-family: system-ui, 'Segoe UI', Roboto, sans-serif;
  /* 军绿赌场毛毡:中心亮、四周深的暗角渐变 */
  background:
    radial-gradient(ellipse 120% 85% at 50% -8%, #46704f 0%, #2f5039 42%, #1d3626 74%, #142a1d 100%);
}
.felt {
  max-width: 860px;
  margin: 0 auto;
  padding: clamp(18px, 4vw, 40px) clamp(16px, 4vw, 32px) 56px;
  box-sizing: border-box;
}

/* 标题 */
.hero { text-align: center; margin-bottom: 22px; }
.hero h1 {
  margin: 0;
  font-size: clamp(24px, 4.6vw, 38px);
  font-weight: 700;
  letter-spacing: -0.5px;
  color: #fbfdf9;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}
.hero h1 .spade { color: var(--gold); }
.hero h1 .accent { color: var(--gold); font-style: italic; letter-spacing: 0.5px; }
.hero .sub { margin: 8px 0 0; font-size: 13px; letter-spacing: 0.6px; color: var(--ink-dim); }

/* 通用面板 */
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 18px;
  padding: 20px;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(6px);
}

/* 表单 */
.form { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.flabel {
  font-size: 11px; font-weight: 600; letter-spacing: 0.8px;
  text-transform: uppercase; color: var(--ink-dim);
}
.field textarea,
.field input {
  width: 100%;
  box-sizing: border-box;
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--ink);
  padding: 9px 11px;
  font-size: 13px;
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  outline: none;
  transition: border-color 0.16s, box-shadow 0.16s, background 0.16s;
}
.field textarea { resize: vertical; line-height: 1.45; }
.field textarea:focus,
.field input:focus {
  border-color: var(--gold);
  background: rgba(0, 0, 0, 0.38);
  box-shadow: 0 0 0 3px rgba(231, 198, 103, 0.16);
}
.field-row { display: flex; flex-wrap: wrap; gap: 14px; }
.field-row .grow { flex: 1 1 200px; }
.field-row .mini { flex: 0 1 96px; }
.field-row .mini input { font-family: system-ui, sans-serif; }

.actions { display: flex; justify-content: flex-end; }
.solve {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 11px 30px;
  border: none;
  border-radius: 11px;
  cursor: pointer;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.4px;
  color: #22331f;
  background: linear-gradient(180deg, #f2d879 0%, #e7c667 55%, #d3ac47 100%);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.5);
  transition: transform 0.12s, box-shadow 0.12s, filter 0.12s;
}
.solve:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.05); box-shadow: 0 10px 22px rgba(0, 0, 0, 0.4); }
.solve:active:not(:disabled) { transform: translateY(0); }
.solve:disabled { cursor: default; opacity: 0.65; filter: saturate(0.6); }
.spinner {
  width: 15px; height: 15px;
  border: 2px solid rgba(34, 51, 31, 0.35);
  border-top-color: #22331f;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 牌桌 / 公共牌:军绿毛毡织纹 + 木/皮围栏 + 金色内描边 + 下注缝线
   (融合 P2 质感;保留 P1 的矩形圆角,规避 P2 椭圆 overflow 在窄屏裁切筹码/标签) */
.board-stage {
  position: relative;
  margin: 22px 0;
  padding: 26px 24px 20px;
  border-radius: 20px;
  border: 9px solid #2b1d12; /* 木/皮围栏 */
  background:
    repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.05) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.022) 0 1px, transparent 1px 3px),
    radial-gradient(ellipse 90% 130% at 50% 40%, rgba(89, 133, 98, 0.45) 0%, rgba(31, 56, 39, 0.25) 60%, transparent 100%),
    rgba(0, 0, 0, 0.16);
  box-shadow:
    inset 0 0 0 2px rgba(231, 198, 103, 0.28), /* 金色内描边 */
    inset 0 0 40px rgba(0, 0, 0, 0.34),
    0 12px 32px rgba(0, 0, 0, 0.3);
}
/* 一圈虚线下注缝线 */
.board-stage::before {
  content: '';
  position: absolute;
  inset: 8px;
  border-radius: 13px;
  border: 2px dashed rgba(231, 198, 103, 0.16);
  pointer-events: none;
}
.board-stage > * { position: relative; } /* 内容置于缝线之上 */

/* 红白扑克筹码底池(融合 P2) */
.pot-row { display: flex; justify-content: center; margin-top: 16px; }
.felt-chip {
  position: relative;
  width: clamp(50px, 13vw, 66px);
  aspect-ratio: 1;
  border-radius: 50%;
  background: repeating-conic-gradient(from 0deg, #b8332c 0 15deg, #ece6d6 15deg 30deg);
  box-shadow: 0 7px 15px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  line-height: 1;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
.felt-chip::before {
  content: '';
  position: absolute;
  inset: 16%;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 34%, #c94238, #8f221b);
  box-shadow:
    inset 0 0 0 2px rgba(255, 255, 255, 0.3),
    inset 0 3px 6px rgba(255, 255, 255, 0.15),
    inset 0 -4px 8px rgba(0, 0, 0, 0.35);
}
.felt-chip-lbl { position: relative; z-index: 1; font-size: 8px; letter-spacing: 1.5px; opacity: 0.9; }
.felt-chip-val {
  position: relative; z-index: 1;
  font-size: clamp(13px, 3.4vw, 18px);
  font-weight: 800; margin-top: 1px;
  font-variant-numeric: tabular-nums;
}
.stage-head {
  display: flex; align-items: baseline; justify-content: space-between;
  flex-wrap: wrap; gap: 6px; margin-bottom: 14px;
}
.stage-title { font-size: 12px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--gold); }
.stage-meta { font-size: 12px; color: var(--ink-dim); font-variant-numeric: tabular-nums; }
.board-cards { display: flex; justify-content: center; align-items: center; gap: 10px; flex-wrap: wrap; }
.board-cards .street { margin-left: 12px; } /* turn / river 与 flop 视觉分组 */
.street-labels {
  display: flex; justify-content: center; gap: 34px; margin-top: 12px;
  font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase;
  color: var(--ink-dim); opacity: 0.75;
}

/* 状态条 / 徽章 */
.err {
  color: #ffb4ae;
  background: rgba(139, 0, 0, 0.22);
  border: 1px solid rgba(255, 120, 110, 0.3);
  padding: 10px 14px;
  border-radius: 10px;
  white-space: pre-wrap;
  font-size: 13px;
  margin: 14px 0 0;
}
.statusbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; min-height: 8px; margin: 16px 0 4px; }
.status.live { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-dim); }
.status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gold); animation: pulse 1.2s ease-out infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(231, 198, 103, 0.5); } 100% { box-shadow: 0 0 0 8px rgba(231, 198, 103, 0); } }
.badge {
  font-size: 12px;
  color: var(--ink-dim);
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 5px 12px;
}
.badge b { color: var(--ink); font-variant-numeric: tabular-nums; }

/* 图例 + 整体频率条 */
.legend { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 10px; }
.chip {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12px; color: var(--ink);
  background: rgba(0, 0, 0, 0.26);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 5px 12px 5px 8px;
}
.chip i { width: 11px; height: 11px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25); }
.chip-lab { color: var(--ink-dim); }
.chip b { font-variant-numeric: tabular-nums; }
.overallbar {
  display: flex;
  height: 26px;
  width: 100%;
  max-width: 520px;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 22px;
  border: 1px solid rgba(0, 0, 0, 0.35);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
}
.overallbar .seg + .seg { box-shadow: inset 1px 0 0 rgba(0, 0, 0, 0.28); }

/* 13×13 策略网格 */
.matrix-wrap {
  overflow-x: auto;
  padding: 20px;
  border-radius: 18px;
  background: var(--panel);
  border: 1px solid var(--line);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
.matrix { display: inline-block; }
.matrix-hint {
  margin: 16px 2px 0;
  font-size: 11.5px;
  line-height: 1.75;
  letter-spacing: 0.3px;
  color: var(--ink-dim);
}
.matrix-top { display: flex; align-items: center; margin-bottom: var(--axisgap); }
.matrix-top .corner-cell { width: calc(var(--axis) + var(--axisgap)); flex: none; }
.matrix-top .axis { width: var(--cell); margin-right: var(--gap); text-align: center; }
.matrix-body { display: flex; align-items: flex-start; }
.matrix-left { display: flex; flex-direction: column; width: var(--axis); margin-right: var(--axisgap); flex: none; }
.matrix-left .axis { height: var(--cell); margin-bottom: var(--gap); display: flex; align-items: center; justify-content: center; }
.axis { font-size: 11px; font-weight: 700; color: var(--gold); opacity: 0.8; font-family: ui-monospace, monospace; }

.grid { display: grid; grid-template-columns: repeat(13, var(--cell)); gap: var(--gap); }
.cell {
  position: relative;
  height: var(--cell);
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
  cursor: default;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18);
  transition: transform 0.08s;
}
.cell:hover {
  transform: scale(1.12);
  z-index: 3;
  outline: 2px solid rgba(255, 255, 255, 0.85);
  outline-offset: -1px;
}

@media (max-width: 560px) {
  .solver { --cell: 30px; --axis: 18px; }
  .street-labels { gap: 18px; }
}
</style>
