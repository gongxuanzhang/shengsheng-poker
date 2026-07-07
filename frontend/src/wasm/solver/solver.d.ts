/* tslint:disable */
/* eslint-disable */

/**
 * 会话 API ③:释放句柄对应的常驻 game,回收内存(会话生命周期结束时调用)。
 */
export function close_spot(handle: number): void;

/**
 * 模块加载时装 panic hook,让 Rust panic 文案进浏览器 console
 * (否则 panic 在浏览器只是无信息的 RuntimeError)。
 */
export function on_start(): void;

/**
 * 会话 API ①:建局 + 求解一次,把 solved game 留在 Worker,返回句柄(u32)。
 * 入参为 `OpenSpotRequest` 的 JSON 字符串(camelCase)。这是唯一的「重活」。
 */
export function open_spot(req_json: string): number;

/**
 * 会话 API ②:从该街 root 沿 path(动作下标序列)导航到目标节点,读取该节点读数。
 * 纯读取,微秒~低毫秒级,可反复调用。path 语义同引擎 `apply_history`:
 * action 节点步为动作下标;chance 节点步为牌 ID(0xFFFFFFFF 表示自动取最小可发牌)。
 * 返回 `NodeResult` 的 JSON 字符串。
 */
export function query_node(handle: number, path: Uint32Array): string;

/**
 * 旧接口:求解一个翻后局面,返回 root(先行动方 OOP)的 GTO 策略(JSON 字符串)。
 * turn / river 传空串 "" 表示该街未发。target_exploitability 单位是 % of pot。
 *
 * 现降为 `open_spot + query_node(root) + close_spot` 的薄包装:签名与返回形状
 * (`SolveResult`)完全不变,SolverView 零改动。
 */
export function solve_spot(oop_range: string, ip_range: string, flop: string, turn: string, river: string, starting_pot: number, effective_stack: number, bet_size: string, max_iter: number, target_exploitability: number): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly open_spot: (a: number, b: number) => [number, number, number];
    readonly query_node: (a: number, b: number, c: number) => [number, number, number, number];
    readonly solve_spot: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number, number, number];
    readonly on_start: () => void;
    readonly close_spot: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
