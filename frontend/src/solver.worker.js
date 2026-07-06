import * as Comlink from 'comlink'
import init, { solve_spot } from './wasm/solver/solver.js'

// 全 worker 只初始化一次 wasm(--target web 必须先 await init() 再调 solve_spot)
let ready = null

const api = {
  // 一次阻塞调用:solve_spot 内部完成 建局→内存护栏→分配→CFR 求解→读 root→JSON。
  // 放在 Worker 里跑,不阻塞主线程 UI。抛错(JsError)会作为异常被主线程 catch。
  async solve(cfg) {
    ready ??= init()
    await ready
    const json = solve_spot(
      cfg.oop, cfg.ip,
      cfg.flop, cfg.turn, cfg.river,
      cfg.pot, cfg.stack, cfg.bet,
      cfg.maxIter ?? 1000,
      cfg.targetExpl ?? 0.5, // 单位: % of pot
    )
    return JSON.parse(json)
  },
}

Comlink.expose(api)
