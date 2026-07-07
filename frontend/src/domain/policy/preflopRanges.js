/**
 * 翻前范围数据层(真实 6-max GTO 图表)+ 纯函数工具。
 *
 * 这是 PreflopChartPolicy 的**数据 / 计算内核**:只含范围数据与纯函数(手牌规范化、
 * 范围串展开、查表得动作频率、续牌范围串),不含策略适配 / 节点解析(那些在
 * gtoPolicy.js 的 PreflopChartPolicy 里)。类型契约见 ../types.js。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 数据来源:AHTOOOXA/poker-charts 的 **pekarstas** provider(GGPoker chart pack)。
 *   https://github.com/AHTOOOXA/poker-charts (src/data/ranges/pekarstas.ts)
 *   License: MIT (Copyright (c) 2025-2026 Anton Safonov)。原始图表经构建脚本
 *   (scratchpad/gen)按 Cell→桶规则转成预计算频率表,落在 ./pekarstasCharts.js。
 *
 * 标准 6-max(位置 UTG/MP/CO/BTN/SB/BB),手牌键与本项目 canonicalHand 完全一致(零转换)。
 *
 * 对手位维度(真实数据的核心优势):
 *   - RFI 按 `${hero}-RFI` 单维索引(开池不看对手位)。
 *   - vs-open / vs-3bet 按【英雄位 × 对手位】双维:`${hero}-${scenario}-${villain}`。
 *     villain = 开池者 / 3bet 者的位置。故 A7s 小盲对 BTN=3bet、对 UTG=fold —— 真实细分生效。
 *   - 源图并非每个 (hero,villain) 组合都存在(pekarstas 只收录主流对位);缺失时**优雅回退**
 *     到最近似的可得对手位(标 approximate),绝不崩。
 *
 * 取舍:
 *   1. allin(5bet jam)并入 raise 桶;混频由源图 50/50 tuple 或 weight 决定(已预计算)。
 *   2. bbOption(limp 后 BB option)pekarstas 无覆盖 → 保留手写占位 BB_OPTION(非该数据源)。
 *   3. vs-4bet 数据已保留在 pekarstasCharts.js,但当前引擎动作线未映射到它(留待需要时启用)。
 * approximate=true 已在策略层标注为「非权威对照」。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 组织维度:位置 × 翻前动作线。动作线枚举 PREFLOP_LINES:
 *   - 'rfi'      folded-to-hero,首个进池者的开池(raise-or-fold)
 *   - 'bbOption' 无人加注(limp)轮到 BB 有 option,可 check / 加注隔离
 *   - 'vsRfi'    面对单个开池,可 3bet(raise)/ 跟注(call)/ 弃牌
 *   - 'vs3bet'   自己开池后遭 3bet,可 4bet(raise)/ 跟注 / 弃牌
 *
 * 手牌用 169 手规范键表示:对子 "AA".."22";非对子 高牌在前 + 花色标记 s/o,如 "AKs"/"T9o"。
 */

import { CHARTS } from './pekarstasCharts.js'

// ═══════════════════════════ 基础常量 ═══════════════════════════

/** 6-max 位置行动顺序(翻前;与 types.js Position 一致),仅用于校验/遍历/对手位距离。 */
export const POSITION_ORDER = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB']

/** 翻前动作线枚举。 @type {string[]} */
export const PREFLOP_LINES = ['rfi', 'bbOption', 'vsRfi', 'vs3bet']

/** 动作线 → pekarstas scenario 段(rfi 走独立 RFI 键)。 */
const SCENARIO_OF_LINE = { vsRfi: 'vs-open', vs3bet: 'vs-3bet' }

/** 牌力由高到低;下标越小牌越大。 */
const RANK_ORDER = 'AKQJT98765432'
const rankIdx = (r) => RANK_ORDER.indexOf(r)

const posIdx = (p) => POSITION_ORDER.indexOf(p)

// ═══════════════════════════ 图表键解析 + 对手位回退 ═══════════════════════════

/** 某 (hero, scenario) 下 pekarstas 收录的对手位列表(按行动顺序)。带缓存。 */
const _villainCache = new Map()
function availableVillains(hero, scenario) {
  const ck = `${hero}|${scenario}`
  if (_villainCache.has(ck)) return _villainCache.get(ck)
  const prefix = `${hero}-${scenario}-`
  const list = Object.keys(CHARTS)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort((a, b) => posIdx(a) - posIdx(b))
  _villainCache.set(ck, list)
  return list
}

/**
 * 解析对手位:精确命中优先;缺失时回退到最近似的可得对手位(按行动顺序距离,平局取更靠前)。
 * villain 省略时给默认代表:vs-3bet 优先 BB(最常见冷 3bet 位),vs-open 取最靠后的可得开池者。
 * @returns {{villain:string|null, approximate:boolean}}
 */
function resolveVillain(hero, scenario, villain) {
  const avail = availableVillains(hero, scenario)
  if (avail.length === 0) return { villain: null, approximate: true }
  if (villain && avail.includes(villain)) return { villain, approximate: false }

  // 默认代表(未指定对手位)。
  if (!villain) {
    if (scenario === 'vs-3bet' && avail.includes('BB')) return { villain: 'BB', approximate: true }
    return { villain: avail[avail.length - 1], approximate: true }
  }
  // 指定了对手位但源图缺失:取行动顺序距离最近者(平局取更靠前/更紧)。
  const wi = posIdx(villain)
  let best = avail[0]
  let bestD = Infinity
  for (const v of avail) {
    const d = Math.abs(posIdx(v) - wi)
    if (d < bestD) { bestD = d; best = v }
  }
  return { villain: best, approximate: true }
}

/**
 * 解析出该 (位置,动作线,对手位) 对应的图表频率表。
 * @returns {{table:Object|null, key:string|null, approximate:boolean}}
 */
export function resolveChart(position, line, villain) {
  if (line === 'rfi') {
    const key = `${position}-RFI`
    return { table: CHARTS[key] ?? null, key: CHARTS[key] ? key : null, approximate: false }
  }
  const scenario = SCENARIO_OF_LINE[line]
  if (!scenario) return { table: null, key: null, approximate: false }
  const r = resolveVillain(position, scenario, villain)
  if (!r.villain) return { table: null, key: null, approximate: true }
  const key = `${position}-${scenario}-${r.villain}`
  return { table: CHARTS[key] ?? null, key: CHARTS[key] ? key : null, approximate: r.approximate }
}

// ═══════════════════════════ 由图表派生范围串(续牌/展示用) ═══════════════════════════

/** 把频率表里某桶(raise/call)命中的手牌拼成引擎 Range 语法串(混频手也计入,近似)。 */
function chartRangeString(table, bucket) {
  if (!table) return ''
  const out = []
  for (const [hand, f] of Object.entries(table)) {
    if ((f[bucket] || 0) > 0) out.push(hand)
  }
  return out.join(',')
}

/** RFI 开池范围串(由图表派生;BB 无 RFI)。供数据自洽测试与续牌复用。 */
export const RFI = Object.fromEntries(
  POSITION_ORDER.filter((p) => p !== 'BB')
    .map((p) => [p, chartRangeString(CHARTS[`${p}-RFI`], 'raise')])
    .filter(([, s]) => s.length > 0),
)

/** bbOption:无人加注轮到 BB,有 option。命中 raise 则加注隔离,否则过牌(check)。
 *  pekarstas 无 limp/BB-option 图,此项保留手写占位(近似,非该数据源)。 */
export const BB_OPTION = {
  raise: 'TT+,AJs+,KQs,AQo+',
}

/** 供测试/调试查看的聚合。 */
export const RANGES = { RFI, BB_OPTION, CHARTS }

// ═══════════════════════════ 纯函数:手牌规范化 ═══════════════════════════

/**
 * 两张牌 → 169 手规范键。cards 为两字符 rank+suit(见 types.js Card),如 "As","Kd"。
 * @param {string} cardA
 * @param {string} cardB
 * @returns {string} 如 "AA" / "AKs" / "T9o"
 */
export function canonicalHand(cardA, cardB) {
  const r1 = cardA[0], s1 = cardA[1]
  const r2 = cardB[0], s2 = cardB[1]
  if (r1 === r2) return r1 + r2 // 对子
  const hiFirst = rankIdx(r1) < rankIdx(r2)
  const hi = hiFirst ? r1 : r2
  const lo = hiFirst ? r2 : r1
  const suited = s1 === s2
  return hi + lo + (suited ? 's' : 'o')
}

// ═══════════════════════════ 纯函数:范围串展开 ═══════════════════════════

const _rangeCache = new Map()

/**
 * 把引擎 Range 语法的范围串展开为 169 手规范键集合(带缓存)。
 * 支持:对子 "AA"/"22+"/"TT-77";非对子 "AKs"/"A2s+"/"A5s-A2s"/"KQo"(以及裸 "AK" = s+o)。
 * 说明:非对子的 "+" 表示固定高牌、踢脚从当前上探到(高牌-1);"X-Y" 表示同高牌同花色的踢脚区间。
 * @param {string} str
 * @returns {Set<string>}
 */
export function expandRange(str) {
  if (!str) return new Set()
  if (_rangeCache.has(str)) return _rangeCache.get(str)
  const set = new Set()
  for (const raw of str.split(',')) {
    const t = raw.trim()
    if (!t) continue
    if (t.includes('-')) expandSpan(t, set)
    else if (t.endsWith('+')) expandPlus(t.slice(0, -1), set)
    else expandSingle(t, set)
  }
  _rangeCache.set(str, set)
  return set
}

function addCombo(rA, rB, suit, set) {
  if (rA === rB) { set.add(rA + rB); return }
  const hiFirst = rankIdx(rA) < rankIdx(rB)
  const hi = hiFirst ? rA : rB
  const lo = hiFirst ? rB : rA
  set.add(hi + lo + suit)
}

function expandSingle(t, set) {
  if (t.length === 2 && t[0] === t[1]) { set.add(t); return } // 对子 "AA"
  if (t.length === 2) { addCombo(t[0], t[1], 's', set); addCombo(t[0], t[1], 'o', set); return } // 裸 "AK"
  addCombo(t[0], t[1], t[2], set) // "AKs" / "AKo"
}

function expandPlus(base, set) {
  if (base.length === 2 && base[0] === base[1]) {
    // 对子 plus:base .. AA
    for (let i = rankIdx(base[0]); i >= 0; i--) set.add(RANK_ORDER[i] + RANK_ORDER[i])
    return
  }
  // 非对子 plus:固定高牌,踢脚从 lo 上探到(hi-1)
  const rA = base[0], rB = base[1], suit = base[2]
  const hiFirst = rankIdx(rA) < rankIdx(rB)
  const hi = hiFirst ? rA : rB
  const lo = hiFirst ? rB : rA
  const hiI = rankIdx(hi)
  for (let k = rankIdx(lo); k > hiI; k--) set.add(hi + RANK_ORDER[k] + suit)
}

function expandSpan(t, set) {
  const [a, b] = t.split('-').map((s) => s.trim())
  if (a.length === 2 && a[0] === a[1]) {
    // 对子区间(a 高 b 低,顺序无关)
    let hi = rankIdx(a[0]), lo = rankIdx(b[0])
    if (hi > lo) { const tmp = hi; hi = lo; lo = tmp }
    for (let i = hi; i <= lo; i++) set.add(RANK_ORDER[i] + RANK_ORDER[i])
    return
  }
  // 非对子区间:同高牌同花色,踢脚区间(假设 a[0]===b[0])
  const suit = a[2]
  const hiRank = a[0]
  let ka = rankIdx(a[1]), kb = rankIdx(b[1])
  if (ka > kb) { const tmp = ka; ka = kb; kb = tmp }
  for (let k = ka; k <= kb; k++) set.add(hiRank + RANK_ORDER[k] + suit)
}

// ═══════════════════════════ 纯函数:查表得动作频率 ═══════════════════════════

/** 归一化 {raise,call,check,fold};全 0 时退化为纯弃牌。 */
function normalizeFreqs(f) {
  const out = { raise: f.raise || 0, call: f.call || 0, check: f.check || 0, fold: f.fold || 0 }
  const sum = out.raise + out.call + out.check + out.fold
  if (sum <= 0) return { raise: 0, call: 0, check: 0, fold: 1 }
  return { raise: out.raise / sum, call: out.call / sum, check: out.check / sum, fold: out.fold / sum }
}

/**
 * 查表:给定(位置 × 动作线 × 手牌键 × 对手位)→ 归一化的动作桶频率 {raise,call,check,fold}。
 *
 * villain(对手位,vs-open/vs-3bet 的开池者/3bet 者)驱动双维索引:同一手牌对不同对手位给出不同策略。
 * villain 省略时用代表对手位(见 resolveVillain);源图缺该对位时优雅回退到最近似对位。
 * bbOption 无 pekarstas 数据,走 BB_OPTION 占位:命中 raise→加注,否则 check;其余未命中→fold。
 *
 * @param {string} position 英雄位
 * @param {string} line     ∈ PREFLOP_LINES
 * @param {string} handKey  169 手规范键
 * @param {string} [villain] 对手位(vs-open/vs-3bet 用);省略走默认代表
 * @returns {{raise:number, call:number, check:number, fold:number}}
 */
export function lookupHandFreqs(position, line, handKey, villain) {
  if (line === 'bbOption') {
    const inRaise = expandRange(BB_OPTION.raise).has(handKey)
    return inRaise
      ? { raise: 1, call: 0, check: 0, fold: 0 }
      : { raise: 0, call: 0, check: 1, fold: 0 } // BB 过牌看翻牌
  }
  const { table } = resolveChart(position, line, villain)
  if (!table) return { raise: 0, call: 0, check: 0, fold: 1 } // 无图(BB-RFI / 无任何对位)→ 弃牌
  const f = table[handKey]
  if (!f) return { raise: 0, call: 0, check: 0, fold: 1 } // 未列手牌 = fold
  return normalizeFreqs({ raise: f.raise, call: f.call, check: 0, fold: f.fold })
}

// ═══════════════════════════ 纯函数:续牌范围(翻后 solve 入参来源) ═══════════════════════════

/**
 * 取某玩家以某(位置,动作线,动作,对手位)延续到翻后时的范围串。
 * 用于 PreflopChartPolicy.deriveRanges 拼 RangeAssignment,喂给 PostflopSolverPolicy。
 * @param {string} position
 * @param {string} line
 * @param {('open'|'raise'|'threebet'|'fourbet'|'call'|'check')} action
 * @param {string} [villain] 对手位(vs-open/vs-3bet 用)
 * @returns {string} 引擎 Range 语法范围串(可能为空串)
 */
export function rangeStringFor(position, line, action, villain) {
  if (line === 'rfi') return RFI[position] || ''
  if (line === 'bbOption') return BB_OPTION.raise
  const { table } = resolveChart(position, line, villain)
  const bucket = action === 'call' ? 'call' : 'raise'
  return chartRangeString(table, bucket)
}

/**
 * 由双方(位置,动作线,动作,对手位)拼一个 RangeAssignment(见 types.js)。纯函数,便于测试与复用。
 * @param {{position:string, line:string, action:string, villain?:string}} oop
 * @param {{position:string, line:string, action:string, villain?:string}} ip
 * @param {string} [source]
 * @returns {{oopRange:string, ipRange:string, source:string}}
 */
export function deriveRangeAssignment(oop, ip, source = 'preflop-chart') {
  return {
    oopRange: rangeStringFor(oop.position, oop.line, oop.action, oop.villain),
    ipRange: rangeStringFor(ip.position, ip.line, ip.action, ip.villain),
    source,
  }
}
