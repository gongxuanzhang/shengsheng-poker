# 架构说明(ARCHITECTURE)

本文说明 shengsheng-poker 当前的工程架构、模块边界、数据流、构建/发布边界,
以及未来 Go 后台服务的接入方式。目标读者是要在本仓库上继续开发或部署的工程师。

> 本文只描述工程结构与技术取舍的**事实依据**(内存、耗时、许可证等硬约束),
> 不涉及界面视觉主题,也不做"是否需要后端"这类立场性宣传。
> 路线图(可分阶段搭建的工程能力)见 [ENGINEERING_ROADMAP.md](./ENGINEERING_ROADMAP.md)。

## 1. 分层概览

当前是一个多语言 monorepo,自下而上分三层,外加规划中的第四层:

```
┌─────────────────────────────────────────────────────────────┐
│ frontend/            Vue 3 + Vite 前端(UI + Web Worker)     │
│   src/solver.worker.js   ── Comlink 包装,在 Worker 内跑 WASM │
│   src/wasm/solver/       ── 已提交的 WASM 产物(开箱即用)    │
├─────────────────────────────────────────────────────────────┤
│ solver-wasm/         wasm-bindgen 接口层(Rust → WASM)       │
│   src/lib.rs             ── 导出 solve_spot(...);单线程 wasm │
├─────────────────────────────────────────────────────────────┤
│ postflop-solver/     vendored Rust GTO 引擎(上游二开,AGPL) │
│   b-inary/postflop-solver;CFR 求解、动作树、范围解析等       │
├─────────────────────────────────────────────────────────────┤
│ backend/  (规划中)  Go 后台服务:承接重局面求解 / 持久化      │
└─────────────────────────────────────────────────────────────┘
```

上游引擎 `postflop-solver/` 来自 [b-inary/postflop-solver](https://github.com/b-inary/postflop-solver),
以 AGPL-3.0 发布;本仓库作为其衍生作品同样受 AGPL-3.0 约束(见根 [LICENSE](../LICENSE))。

## 2. 模块边界与职责

| 模块 | 语言/工具链 | 职责 | 边界(不做什么) | 构建产物 |
|------|-------------|------|------------------|----------|
| `postflop-solver/` | Rust(cargo) | GTO 求解算法:CFR、动作树、范围/牌面解析、EV/equity 计算 | 不感知前端、不含 WASM/JS 绑定;尽量保持与上游可对齐 | `target/`(不提交) |
| `solver-wasm/` | Rust + wasm-bindgen(wasm-pack) | 把引擎能力收敛成**一个稳定入口** `solve_spot(...)`,负责入参解析、内存护栏、结果序列化为 JSON | 不含 UI 逻辑;不引入多线程(wasm 单线程,禁用引擎 `rayon`/`bincode` 默认 feature) | `frontend/src/wasm/solver/`(**已提交**) |
| `frontend/` | Vue 3 + Vite(npm) | 局面输入、调用 Worker、渲染 13×13 策略网格与整体频率 | 不做求解计算(全部委托给 WASM);不直接 import 引擎 Rust | `frontend/dist/`(不提交) |
| `backend/`(规划) | Go | 承接超出浏览器内存/耗时预算的重局面;可选持久化与缓存 | 复用同一求解契约,不另造一套数据结构 | 二进制(不提交) |

关键约束(来自代码,作为边界的事实依据,而非取舍宣传):

- **单线程 wasm**:`solver-wasm` 关闭引擎默认 feature(`rayon`/`bincode`),浏览器内单线程求解。
- **内存护栏**:`solve_spot` 预估未压缩内存超过 **800 MB** 即直接报错,避免大局面把浏览器 OOM。
- **耗时特征**:flop 起手的完整求解在单线程下约 30–45s;turn/river 起手通常亚秒级。
  这条是后续把重局面下沉到 `backend/`(可开 `rayon` 多线程)的主要动因。

## 3. 数据流

一次求解的端到端路径:

```
SolverView.vue (reactive cfg)
    │  { oop, ip, board→flop/turn/river, pot, stack, bet, maxIter, targetExpl }
    ▼  Comlink.wrap(new Worker(solver.worker.js))
solver.worker.js
    │  init() 一次性加载 wasm(--target web 必须先 await init)
    ▼  solve_spot(oop, ip, flop, turn, river, pot, stack, bet, maxIter, targetExpl)
solver-wasm/src/lib.rs
    │  解析范围/牌面 → 建 TreeConfig/ActionTree → 内存护栏 → allocate → solve(CFR)
    ▼  serde_json::to_string(SolveResult)   // 返回 JSON 字符串
solver.worker.js
    │  JSON.parse(json)
    ▼
SolverView.vue  渲染:每手动作分布(13×13)、整体动作频率、exploitability
```

- Worker 边界:求解是一次**阻塞**调用,放在 Web Worker 里执行,不阻塞主线程 UI;
  Rust `panic` 经 `console_error_panic_hook` 进入浏览器 console,`Err` 作为异常被主线程 `catch`。
- 参数语义:`targetExpl` 单位为 **% of pot**(如 `0.5` = 底池的 0.5%);
  `turn`/`river` 传空串表示该街未发,起始街由牌面推断。

## 4. 数据契约(跨语言边界)

前端与引擎之间只有**一个契约**,即 `solve_spot` 的入参签名与 `SolveResult` 出参结构。
这是最需要保持稳定、也是目前最薄弱的一环。

**出参 `SolveResult`(定义见 `solver-wasm/src/lib.rs`):**

| 字段 | 类型 | 含义 |
|------|------|------|
| `exploitability` | f32 | 收敛后的可利用度 |
| `memory_bytes` | f64 | 本次求解的未压缩内存占用 |
| `num_hands` / `num_actions` | usize | 手牌数 / 动作数 |
| `actions` | string[] | 动作标签,如 `["Check", "Bet(28)", "AllIn(100)"]` |
| `hands` | string[] | 手牌标签,长度 `num_hands` |
| `strategy` | f32[] | 长度 `num_actions * num_hands`,`strategy[a*num_hands + h]` = 手牌 h 选动作 a 的概率 |
| `equity` / `ev` / `weights` | f32[] | 各长度 `num_hands` |
| `overall_freq` | f32[] | 长度 `num_actions`,按权重加权的整体动作频率 |

**当前的契约缺口(工程债,已在路线图中登记):**

- `solve_spot` 的 TS 返回类型是 `string`(JSON),因此 `SolveResult` 的形状在 TS 侧**没有类型**,
  前端 `JSON.parse` 后按约定裸取字段。Rust 结构体一旦改字段,前端不会在编译期报错。
- 入参是 10 个位置参数(`solver.worker.js` 里手工按序传入),新增/调整参数容易错位。

改进方向(把契约变成单一事实源、生成而非手写)见
[ENGINEERING_ROADMAP.md](./ENGINEERING_ROADMAP.md) 的"共享 API/Schema"条目。

## 5. 构建与发布边界

统一入口是根 `Makefile`(见 [根 README](../README.md#常用命令) 与 `make help`)。

| 阶段 | 命令 | 输入 → 输出 | 是否提交 |
|------|------|-------------|----------|
| 编译引擎为 WASM | `make build-wasm` | `solver-wasm/` →(wasm-pack)→ `frontend/src/wasm/solver/` | 输出**已提交** |
| 打包前端 | `make build-frontend` | `frontend/` →(vite build)→ `frontend/dist/` | 不提交 |
| 完整构建 | `make build` | 先 WASM 后前端 | — |

- **WASM 产物已提交**:因此在缺少 Rust 工具链(cargo/wasm-pack)的环境也能只跑前端;
  只有改动 `postflop-solver/` 或 `solver-wasm/` 后才需 `make build-wasm` 重新生成。
- **前端发布物**:`frontend/dist/` 是纯静态资源,可部署到任意静态托管。
- **许可证义务**:作为网络服务对外提供时,AGPL-3.0 要求向使用者提供完整对应源码(含本仓库改动)。
  部署与发布流程都应保留这一义务,详见根 README 的 License 一节。

## 6. 推荐目标架构

近期目标不是重构,而是把现有边界**补齐工程能力**(契约、CI、质量门禁),
并为重局面预留一个可选的计算层。要点:

1. **契约单一事实源**:把 `solve_spot` 入参与 `SolveResult` 出参抽成一份 schema(如 JSON Schema),
   由它生成 TS 类型与(未来)Go 结构体,消除第 4 节的漂移风险。
2. **质量门禁进 CI**:前端构建校验 + Rust `test`/`fmt`/`clippy`(工具链就绪时)在 PR 上自动跑。
3. **可选计算层 `backend/`**:把超出浏览器预算(内存 > 800MB / flop 全解 30–45s)的局面下沉到 Go 后台,
   后台内部可复用同一 Rust 引擎并开启 `rayon` 多线程;前端按局面规模选择"浏览器内解"或"请求后台解"。

保持不变的边界:引擎算法只在 Rust 层;前端不做求解;所有服务共用根 `Makefile` 与同一份契约。

## 7. 未来 Go 后台接入方式

规划中的 `backend/`(Go)按以下约定接入,避免另起炉灶:

- **目录**:新增 `backend/`,Go 源码与 `go.mod` 提交;二进制/覆盖率产物由根 `.gitignore` 忽略
  (已预置 `backend/bin/`、`*.test`、`*.out` 等规则)。
- **构建入口**:在根 `Makefile` 扩展 target(如 `build-backend`、`test-go`),
  并接进 `build`/`test` 聚合目标,**不新增散落脚本**。
- **数据契约**:HTTP/JSON 接口的请求/响应直接对齐 `SolveResult`(见第 4 节),
  与 WASM 路径共用同一 schema,前端调用两条路径时数据结构一致。
- **计算复用**:后台可直接依赖 `postflop-solver/`(开启 `rayon`/`bincode` 默认 feature)获得多线程与序列化,
  无需重写算法。
- **许可证**:后台作为网络服务同样受 AGPL-3.0 约束,须提供对应源码。

落地顺序与验收标准见 [ENGINEERING_ROADMAP.md](./ENGINEERING_ROADMAP.md)。
