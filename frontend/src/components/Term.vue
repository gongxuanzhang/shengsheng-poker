<script setup>
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'

// ─────────────────────────────────────────────────────────────────────────────
// 可复用「术语」组件：鼠标悬停在专业术语/英文上，弹出中文解释气泡。
// 纯 CSS/JS，零外部依赖/图片/字体/CDN（可完全离线）。
//
// 用法：
//   <Term id="gto">GTO</Term>        显示 GTO，hover 弹出解释
//   <Term id="gto" />                无插槽时用词典里的显示名
//   <Term :id="actionTermId(a)">{{ a }}</Term>   id 可动态绑定
//   <Term id="solver" no-click>Solve</Term>  放在按钮内：只 hover，不响应点击/焦点
//
// 防裁剪核心：气泡用 <Teleport to="body"> 脱离任何祖先的 overflow / z-index /
// stacking context（军绿牌桌、13×13 网格 overflow-x:auto、卡片区都不会裁切它），
// 再用 position:fixed + JS 依据触发元素的 getBoundingClientRect 定位到视口坐标，
// 并夹在视口内（含边距），保证靠近视口边缘的术语气泡也不被切掉。
// 极矮/横屏视口下再用 max-height + 内部滚动兜底，长解释也不会溢出视口底部。
// ─────────────────────────────────────────────────────────────────────────────

// 内置术语词典：id -> { term: 显示名, desc: 中文解释 }
const DICT = {
  gto: { term: 'GTO', desc: 'GTO（Game Theory Optimal，博弈论最优）：一种「不可被剥削」的均衡打法，即使对手知道你的完整策略也占不到便宜，是学习扑克的数学基准。' },
  oop: { term: 'OOP', desc: 'OOP（Out of Position，不利位置）：翻牌后需要先行动的一方，看不到对手动作，信息劣势。' },
  ip: { term: 'IP', desc: 'IP（In Position，有利位置）：翻牌后后行动的一方，能先看对手动作，信息优势。' },
  solver: { term: 'Solver', desc: 'Solver（求解器）：用博弈论算法（CFR）计算某牌局局面 GTO 最优策略的程序。' },
  range: { term: '范围', desc: '范围（range）：一个玩家在当前局面下所有可能持有的起手牌的集合（不是某一手具体牌）。' },
  board: { term: 'Board', desc: 'Board（公共牌）：牌桌中央翻开、双方共用的牌。' },
  flop: { term: 'Flop', desc: 'Flop（翻牌）：第一批 3 张公共牌。' },
  turn: { term: 'Turn', desc: 'Turn（转牌）：第 4 张公共牌。' },
  river: { term: 'River', desc: 'River（河牌）：第 5 张（最后一张）公共牌。' },
  postflop: { term: '后翻牌', desc: '后翻牌（postflop）：翻牌圈及之后（翻牌 / 转牌 / 河牌）的博弈阶段，与翻牌前（preflop）相对，也是本工具求解的对象。' },
  pot: { term: '底池', desc: '底池（pot）：当前这手牌已累积在桌上的筹码总量。' },
  stack: { term: '有效筹码', desc: '有效筹码（effective stack）：双方中较少一方还能投入的筹码，决定这手牌最多能打多大。' },
  spr: { term: 'SPR', desc: 'SPR（Stack-to-Pot Ratio，筹码底池比）：有效筹码÷底池，越小越容易全下。' },
  exploitability: { term: 'exploitability', desc: 'exploitability（可剥削度）：衡量当前策略离完美 GTO 还差多远，越接近 0 越无懈可击。' },
  equity: { term: 'equity', desc: 'equity（胜率/权益）：这手牌在当前局面摊牌获胜的概率（含平分）。' },
  ev: { term: 'EV', desc: 'EV（Expected Value，期望收益）：某打法长期平均能赢得的筹码量。' },
  check: { term: 'Check', desc: 'Check（过牌）：不下注、把行动权交给对手（不弃牌）。' },
  bet: { term: 'Bet', desc: 'Bet（下注）：主动投入筹码。' },
  call: { term: 'Call', desc: 'Call（跟注）：跟上对手的下注额。' },
  raise: { term: 'Raise', desc: 'Raise（加注）：在对手下注基础上再加大。' },
  allin: { term: 'AllIn', desc: 'AllIn（全下）：把剩余筹码全部推入底池。' },
  fold: { term: 'Fold', desc: 'Fold（弃牌）：放弃这手牌、退出这个底池。' },
  mixed: { term: '混合策略', desc: '混合策略：同一手牌不固定一个动作，而按比例随机（如 70%下注/30%过牌），让对手无法预测。' },
  wasm: { term: 'WASM', desc: 'WASM（WebAssembly）：让浏览器高速运行 Rust 等编译代码的技术，solver 靠它在你浏览器里实时计算。' },
  suited: { term: 's', desc: 's（suited，同花）：两张起手牌花色相同，如 AKs。' },
  offsuit: { term: 'o', desc: 'o（offsuit，不同花）：两张起手牌花色不同，如 AKo。' },
  cfr: { term: 'CFR', desc: 'CFR（反事实遗憾最小化）：solver 用的迭代算法，通过反复自我博弈逼近 GTO。' },
  // 词典给定条目外的补充：界面「内存」徽章需要解释（措辞自拟）
  mem: { term: '内存', desc: '内存（memory）：solver 求解这个局面所占用的运行内存，局面越大、下注尺寸越多越吃内存。' },
  mb: { term: 'MB', desc: 'MB（Megabyte，兆字节）：内存/数据容量单位，1 MB ≈ 100 万字节。此处表示 solver 求解占用的运行内存大小。' },
}

const props = defineProps({
  id: { type: String, required: true },
  // 关闭「点击/焦点弹出」：用于放在 <button> 等本身可点击、且点击会切换内容而卸载本组件的元素内，
  // 避免点击瞬间 show() 后组件被卸载导致气泡闪现（见 Solve 按钮：点击后 busy 切换会卸载 v-else）。
  // 只保留 hover 解释，不再抢占点击/键盘焦点（外层 button 自身已可聚焦且语义完整）。
  noClick: { type: Boolean, default: false },
})

const entry = computed(() => DICT[props.id] || null)

// 每个实例一个唯一 id，供 aria-describedby 关联，屏幕阅读器聚焦时可朗读解释
const bubbleId = 'term-tip-' + Math.random().toString(36).slice(2, 9)

const open = ref(false)        // 气泡是否挂载
const positioned = ref(false)  // 是否已完成定位（用于淡入，避免 0,0 闪现）
const scrollable = ref(false)  // 内容被 max-height 夹住并可滚动 → 放开 pointer-events 以便滚动阅读
const coords = ref({ left: 0, top: 0 })
const triggerRef = ref(null)
const bubbleRef = ref(null)

const MARGIN = 10 // 气泡与视口边缘的最小间距
const GAP = 10    // 气泡与术语之间的间距
let hideTimer = null

function place() {
  const el = triggerRef.value
  const bub = bubbleRef.value
  if (!el || !bub) return
  const r = el.getBoundingClientRect()
  const bw = bub.offsetWidth
  const bh = bub.offsetHeight // 已被 max-height 夹住，用于垂直定位不会越界
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  // 水平：与术语中心对齐，再夹进视口（含边距），保证边缘术语不被切
  let left = r.left + r.width / 2 - bw / 2
  left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - bw - MARGIN))
  // 垂直：优先放上方；上方放不下则放下方；仍越界再夹住
  let top = r.top - bh - GAP
  if (top < MARGIN) top = r.bottom + GAP
  top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - bh - MARGIN))
  coords.value = { left, top }
  // 内容超过 max-height 被裁并可滚动时，放开 pointer-events，让用户能滚动读完（极矮/横屏视口）
  scrollable.value = bub.scrollHeight > bub.clientHeight + 1
  positioned.value = true
}

function addListeners() {
  // 跟随滚动/尺寸变化重新定位；capture:true 可捕获内层滚动容器（如网格 overflow-x）
  window.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)
  // 触屏/点击弹出后：点击或触碰「术语与气泡之外」的区域即关闭
  //（capture 阶段先于本次触发事件已结束，不会捕获打开它的这一次点击）
  document.addEventListener('click', onDocPointer, true)
  document.addEventListener('touchstart', onDocPointer, true)
  // 触屏一开始滚动就隐藏：规避 iOS 惯性滚动期间 scroll 仅在结束时触发、fixed 气泡与术语错位
  document.addEventListener('touchmove', onTouchMove, { passive: true })
}
function removeListeners() {
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('resize', place)
  document.removeEventListener('click', onDocPointer, true)
  document.removeEventListener('touchstart', onDocPointer, true)
  document.removeEventListener('touchmove', onTouchMove)
}

// 点/触气泡与术语之外 → 关闭（气泡内点击/滚动条不关闭）
function onDocPointer(e) {
  if (triggerRef.value && triggerRef.value.contains(e.target)) return
  if (bubbleRef.value && bubbleRef.value.contains(e.target)) return
  hide()
}
// 触屏滚动 → 关闭；但在（可滚动的）气泡内部滑动不关闭，以便滚动阅读长解释
function onTouchMove(e) {
  if (bubbleRef.value && bubbleRef.value.contains(e.target)) return
  hide()
}

async function show() {
  if (!entry.value) return
  cancelHide()
  open.value = true
  positioned.value = false
  await nextTick()
  place()
  addListeners()
}

function hide() {
  cancelHide()
  open.value = false
  positioned.value = false
  scrollable.value = false
  removeListeners()
}

function scheduleHide() {
  cancelHide()
  hideTimer = setTimeout(hide, 90)
}
function cancelHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

// 移出术语：普通气泡立即关闭（保持利落、无闪烁）；
// 可滚动气泡给一小段延时，方便鼠标跨过间距移入气泡内滚动阅读（移入即 cancelHide 保持打开）。
function onLeave() {
  if (scrollable.value) scheduleHide()
  else hide()
}

// 触屏/无 hover 环境：点击也能弹出（不阻止冒泡，绝不影响外层按钮等原有点击）
function onFocus() {
  if (props.noClick) return
  show()
}
function onClick() {
  if (props.noClick || !entry.value) return
  show()
}

onBeforeUnmount(hide)
</script>

<template>
  <span
    ref="triggerRef"
    :class="['term', { 'term--plain': !entry }]"
    :tabindex="entry && !noClick ? 0 : null"
    :aria-describedby="open && entry ? bubbleId : null"
    @mouseenter="show"
    @mouseleave="onLeave"
    @focus="onFocus"
    @blur="hide"
    @click="onClick"
  ><slot>{{ entry ? entry.term : id }}</slot></span>

  <Teleport to="body">
    <div
      v-if="open && entry"
      :id="bubbleId"
      ref="bubbleRef"
      class="term-bubble"
      :class="{ show: positioned, 'is-scroll': scrollable }"
      :style="{ left: coords.left + 'px', top: coords.top + 'px' }"
      role="tooltip"
      @mouseenter="cancelHide"
      @mouseleave="hide"
    >{{ entry.desc }}</div>
  </Teleport>
</template>

<style scoped>
/* 触发文本：淡金色虚线下划线，暗示「可悬停」 */
.term {
  cursor: help;
  text-decoration-line: underline;
  text-decoration-style: dashed;
  text-decoration-color: rgba(231, 198, 103, 0.5);
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
  transition: text-decoration-color 0.14s ease;
  border-radius: 2px;
}
.term:hover,
.term:focus-visible {
  text-decoration-color: rgba(231, 198, 103, 0.95);
}
.term:focus-visible {
  outline: 2px solid rgba(231, 198, 103, 0.5);
  outline-offset: 2px;
}
/* 未知 id：降级为普通文本，不加下划线、不弹气泡（永不报错） */
.term--plain {
  cursor: inherit;
  text-decoration: none;
}

/* 解释气泡：与军绿牌桌协调的深绿气泡 + 浅字 + 金边 + 微阴影。
   position:fixed（配合 Teleport 到 body）——不受任何祖先裁剪/层叠影响。
   pointer-events:none —— 常规气泡纯展示，不拦截鼠标，避免与 mouseleave 抢焦点造成闪烁；
   仅当内容被 max-height 夹住需滚动时（.is-scroll）才放开，让用户能滚动读完。 */
.term-bubble {
  position: fixed;
  z-index: 99999;
  max-width: min(320px, calc(100vw - 24px));
  max-height: calc(100vh - 20px);   /* = 视口高 - 2×MARGIN：极矮/横屏也不溢出视口 */
  overflow-y: auto;                 /* 超长解释在气泡内部滚动，而非被视口切掉 */
  overscroll-behavior: contain;     /* 滚动到头不连带滚动页面 */
  box-sizing: border-box;
  padding: 10px 13px;
  border-radius: 10px;
  font-family: system-ui, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.55;
  letter-spacing: 0.2px;
  text-align: left;
  color: #ecf4ee;
  background: linear-gradient(180deg, rgba(20, 42, 30, 0.98), rgba(11, 26, 18, 0.98));
  border: 1px solid rgba(231, 198, 103, 0.38);
  box-shadow:
    0 12px 30px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  white-space: normal;
  overflow-wrap: break-word;
  word-break: break-word;
  pointer-events: none;
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 0.14s ease, transform 0.14s ease;
}
/* 需滚动时放开鼠标事件：允许滚轮/拖拽滚动条，且移入气泡可保持打开 */
.term-bubble.is-scroll {
  pointer-events: auto;
}
.term-bubble.show {
  opacity: 1;
  transform: translateY(0);
}
</style>
