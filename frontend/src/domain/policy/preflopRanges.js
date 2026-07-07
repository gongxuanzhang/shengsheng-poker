/**
 * 翻前范围数据层(内置简化 9-max 图表)+ 纯函数工具。
 *
 * 这是 PreflopChartPolicy 的**数据 / 计算内核**:只含范围数据与纯函数(手牌规范化、
 * 范围串展开、查表得动作频率、续牌范围串),不含策略适配 / 节点解析(那些在
 * gtoPolicy.js 的 PreflopChartPolicy 里)。类型契约见 ../types.js。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TODO(数据来源):当前是一份**结构正确的简化/占位范围**(手写,约 100bb,近似标准打法,
 *   非精确 GTO)。仅用于跑通训练主循环。上线前替换为完整开源范围表(如 poker-charts /
 *   GTOWizard 导出),保持本文件导出的 { RFI, VS_RFI, VS_3BET, BB_OPTION, MIXED } 结构
 *   即可无缝替换,查表逻辑与上层策略无需改动。approximate=true 已在策略层标注为「非权威对照」。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 组织维度:位置 × 翻前动作线。动作线枚举 PREFLOP_LINES:
 *   - 'rfi'      folded-to-hero,首个进池者的开池(raise-or-fold)
 *   - 'bbOption' 无人加注(limp)轮到 BB 有 option,可 check / 加注隔离
 *   - 'vsRfi'    面对单个开池,可 3bet(raise)/ 跟注(call)/ 弃牌
 *   - 'vs3bet'   自己开池后遭 3bet,可 4bet(raise)/ 跟注 / 弃牌
 *
 * 手牌用 169 手规范键表示:对子 "AA".."22";非对子 高牌在前 + 花色标记 s/o,如 "AKs"/"T9o"。
 * 范围串沿用引擎 Range 语法(与前端已存的范围串一致),逗号分隔,支持:
 *   对子 "AA" / "22+" / "TT-77";非对子 "AKs" / "A2s+" / "A5s-A2s" / "KQo"。
 */

// ═══════════════════════════ 基础常量 ═══════════════════════════

/** 位置行动顺序(与 types.js Position 一致),仅用于校验/遍历。 @type {string[]} */
export const POSITION_ORDER = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']

/** 翻前动作线枚举。 @type {string[]} */
export const PREFLOP_LINES = ['rfi', 'bbOption', 'vsRfi', 'vs3bet']

/** 牌力由高到低;下标越小牌越大。 */
const RANK_ORDER = 'AKQJT98765432'
const rankIdx = (r) => RANK_ORDER.indexOf(r)

// ═══════════════════════════ 内置范围数据(占位,见文件头 TODO) ═══════════════════════════

/** RFI(folded-to-hero 开池范围)。BB 无 RFI(轮到 BB 时若无人加注走 bbOption)。 */
export const RFI = {
  UTG: '77+,ATs+,KTs+,QTs+,JTs,AJo+,KQo',
  UTG1: '66+,A9s+,KTs+,QTs+,J9s+,T9s,AJo+,KQo',
  UTG2: '66+,A8s+,K9s+,QTs+,J9s+,T9s,98s,ATo+,KJo+',
  LJ: '55+,A7s+,K9s+,Q9s+,J9s+,T8s+,98s,ATo+,KJo+',
  HJ: '44+,A5s+,K8s+,Q9s+,J8s+,T8s+,97s+,87s,A9o+,KTo+,QJo',
  CO: '22+,A2s+,K7s+,Q8s+,J8s+,T7s+,97s+,86s+,76s,65s,A7o+,K9o+,QTo+,JTo',
  BTN: '22+,A2s+,K2s+,Q5s+,J7s+,T7s+,96s+,86s+,75s+,64s+,54s,A2o+,K7o+,Q9o+,J9o+,T9o,98o',
  SB: '22+,A2s+,K5s+,Q7s+,J8s+,T7s+,97s+,86s+,75s+,65s,54s,A2o+,K8o+,Q9o+,JTo',
}

/** vsRfi(面对单个开池)。_default 为兜底;个别位置按防守宽度覆盖(占位差异,非精确)。 */
export const VS_RFI = {
  _default: {
    threebet: 'QQ+,AKs,AKo,A5s,A4s',
    call: 'JJ-22,AQs-ATs,KJs+,QJs,JTs,T9s,98s,AQo,KQo',
  },
  BTN: {
    threebet: 'JJ+,AKs,AQs,AKo,A5s,A4s,KJs',
    call: 'TT-22,AJs-ATs,KTs+,QJs,JTs,T9s,98s,87s,AQo,KQo,AJo',
  },
  SB: {
    threebet: 'TT+,AQs+,AKo,A5s-A2s,KQs',
    call: '99-22,AJs-ATs,KJs,QJs,JTs',
  },
  BB: {
    threebet: 'QQ+,AKs,A5s,A4s,K5s',
    call: 'JJ-22,A2s+,K9s+,Q9s+,J9s+,T8s+,98s,87s,76s,ATo+,KJo+,QJo',
  },
}

/** vs3bet(自己开池后遭 3bet)。_default 兜底,BTN 覆盖。 */
export const VS_3BET = {
  _default: {
    fourbet: 'KK+,AKs,A5s',
    call: 'QQ-JJ,AKo,AQs,KQs',
  },
  BTN: {
    fourbet: 'KK+,AKs,AKo,A5s',
    call: 'QQ-TT,AQs,AJs,KQs,AQo',
  },
}

/** bbOption:无人加注轮到 BB,有 option。命中 raise 则加注隔离,否则过牌(check)。 */
export const BB_OPTION = {
  raise: 'TT+,AJs+,KQs,AQo+',
}

/**
 * 混合策略覆盖(键 `${position}|${line}`)。优先级最高:命中则直接用其 {raise,call,check,fold}。
 * 占位:仅示范少量混频手(展示频率采样与偏差评估对混合打法的处理),完整表由数据源提供。
 */
export const MIXED = {
  'BTN|vsRfi': {
    A5s: { raise: 0.5, fold: 0.5 },
    KJs: { raise: 0.35, call: 0.65 },
  },
  'CO|rfi': {
    A5o: { raise: 0.5, fold: 0.5 },
  },
}

/** 供测试/调试查看的聚合。 */
export const RANGES = { RFI, VS_RFI, VS_3BET, BB_OPTION, MIXED }

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

/** 取某(位置,动作线)的 raise/call 参考范围串。 */
function bucketsForLine(position, line) {
  switch (line) {
    case 'rfi':
      return { raise: RFI[position] }
    case 'bbOption':
      return { raise: BB_OPTION.raise }
    case 'vsRfi': {
      const t = VS_RFI[position] || VS_RFI._default
      return { raise: t.threebet, call: t.call }
    }
    case 'vs3bet': {
      const t = VS_3BET[position] || VS_3BET._default
      return { raise: t.fourbet, call: t.call }
    }
    default:
      return {}
  }
}

/**
 * 查表:给定(位置 × 动作线 × 手牌键)→ 归一化的动作桶频率 {raise,call,check,fold}。
 * 优先用 MIXED 混频覆盖;否则命中 raise 范围→纯 raise,命中 call 范围→纯 call,
 * bbOption 未命中→check,其余未命中→fold。这是策略层映射到具体 legalActions 前的中间表示。
 * @param {string} position
 * @param {string} line   ∈ PREFLOP_LINES
 * @param {string} handKey 169 手规范键
 * @returns {{raise:number, call:number, check:number, fold:number}}
 */
export function lookupHandFreqs(position, line, handKey) {
  const mixed = MIXED[`${position}|${line}`]?.[handKey]
  if (mixed) return normalizeFreqs(mixed)

  const b = bucketsForLine(position, line)
  const inRaise = b.raise ? expandRange(b.raise).has(handKey) : false
  const inCall = b.call ? expandRange(b.call).has(handKey) : false

  if (inRaise) return { raise: 1, call: 0, check: 0, fold: 0 }
  if (inCall) return { raise: 0, call: 1, check: 0, fold: 0 }
  if (line === 'bbOption') return { raise: 0, call: 0, check: 1, fold: 0 } // BB 过牌看翻牌
  return { raise: 0, call: 0, check: 0, fold: 1 }
}

// ═══════════════════════════ 纯函数:续牌范围(翻后 solve 入参来源) ═══════════════════════════

/**
 * 取某玩家以某(位置,动作线,动作)延续到翻后时的范围串。
 * 用于 PreflopChartPolicy.deriveRanges 拼 RangeAssignment,喂给 PostflopSolverPolicy。
 * @param {string} position
 * @param {string} line
 * @param {('open'|'raise'|'threebet'|'fourbet'|'call'|'check')} action
 * @returns {string} 引擎 Range 语法范围串(可能为空串)
 */
export function rangeStringFor(position, line, action) {
  switch (line) {
    case 'rfi':
      return RFI[position] || ''
    case 'bbOption':
      return BB_OPTION.raise
    case 'vsRfi': {
      const t = VS_RFI[position] || VS_RFI._default
      return action === 'call' ? t.call : t.threebet
    }
    case 'vs3bet': {
      const t = VS_3BET[position] || VS_3BET._default
      return action === 'call' ? t.call : t.fourbet
    }
    default:
      return ''
  }
}

/**
 * 由双方(位置,动作线,动作)拼一个 RangeAssignment(见 types.js)。纯函数,便于测试与复用。
 * @param {{position:string, line:string, action:string}} oop
 * @param {{position:string, line:string, action:string}} ip
 * @param {string} [source]
 * @returns {{oopRange:string, ipRange:string, source:string}}
 */
export function deriveRangeAssignment(oop, ip, source = 'preflop-chart') {
  return {
    oopRange: rangeStringFor(oop.position, oop.line, oop.action),
    ipRange: rangeStringFor(ip.position, ip.line, ip.action),
    source,
  }
}
