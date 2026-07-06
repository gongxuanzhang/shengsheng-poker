# shengsheng-poker

浏览器内实时求解的**德州扑克 GTO Solver**。纯前端(WebAssembly)、无后端、零服务器算力——所有计算都在你的浏览器里完成。

## 是什么

输入翻牌后的局面(双方范围、公共牌、底池、有效筹码、下注尺度),点 **Solve**,浏览器用 WASM 实时跑 CFR 算法求出 GTO 最优策略,渲染成 **13×13 策略网格** + 整体动作频率。军绿牌桌风格,公共牌以真实扑克牌卡片呈现,术语可鼠标悬停查看解释。

## 项目结构

| 目录 | 说明 |
|------|------|
| `postflop-solver/` | Rust GTO 引擎([b-inary/postflop-solver](https://github.com/b-inary/postflop-solver),Discounted CFR),已 vendored |
| `solver-wasm/` | wasm-bindgen 接口层,暴露 `solve_spot(...)` |
| `frontend/` | Vue 3 + Vite 前端(军绿牌桌 UI + 13×13 策略网格) |

## 本地运行

前置:Rust(≥1.85)、[wasm-pack](https://rustwasm.github.io/wasm-pack/)、Node(≥18)。

```bash
# 1) 把 solver 编译成 wasm(输出到 frontend/src/wasm/solver)
cd solver-wasm
wasm-pack build --target web --out-name solver --out-dir ../frontend/src/wasm/solver

# 2) 启动前端
cd ../frontend
npm install
npm run dev
```

打开 http://localhost:5173 ,点 **Solve**。

> 仓库已提交 `frontend/src/wasm/` 的 wasm 产物,所以若只想跑前端、不改引擎,可**跳过第 1 步**,直接 `cd frontend && npm install && npm run dev`。

## License

[AGPL-3.0](./LICENSE) —— 引擎 postflop-solver 采用 AGPL-3.0,本项目作为衍生作品同样采用 AGPL-3.0。若公开部署为网络服务,须向用户提供完整源码。
