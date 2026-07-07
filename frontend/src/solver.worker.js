import * as Comlink from 'comlink'
import init, { solve_spot, open_spot, query_node, close_spot } from './wasm/solver/solver.js'

// 全 worker 只初始化一次 wasm(--target web 必须先 await init() 再调任何导出)
let ready = null
function ensureReady() {
  ready ??= init()
  return ready
}

const api = {
  // ── 旧接口(SolverView 用):一次阻塞 solve,内部完成 建局→护栏→分配→CFR→读 root→JSON。
  async solve(cfg) {
    await ensureReady()
    const json = solve_spot(
      cfg.oop, cfg.ip,
      cfg.flop, cfg.turn, cfg.river,
      cfg.pot, cfg.stack, cfg.bet,
      cfg.maxIter ?? 1000,
      cfg.targetExpl ?? 0.5, // 单位: % of pot
    )
    return JSON.parse(json)
  },

  // ── 会话 API(PostflopSolverPolicy 用):solve 一次留在 Worker,跨节点导航复用。
  //    形状对齐 solver-wasm/src/lib.rs 与 domain/types.js 的会话契约。

  // open_spot(req: OpenSpotRequest) -> handle。唯一的「重活」(建局+CFR 求解)。
  async openSpot(req) {
    await ensureReady()
    return open_spot(JSON.stringify(req)) // 返回 u32 句柄
  },

  // query_node(handle, path: number[]) -> NodeResult。纯读取,可反复调用。
  async queryNode(handle, path) {
    await ensureReady()
    const json = query_node(handle, Uint32Array.from(path ?? []))
    return JSON.parse(json)
  },

  // close_spot(handle) -> void。释放常驻 game。
  async closeSpot(handle) {
    await ensureReady()
    close_spot(handle)
  },
}

Comlink.expose(api)
