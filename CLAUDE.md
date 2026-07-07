# CLAUDE.md

面向 Claude Code 的项目上下文与约束。

## 项目简介

shengsheng-poker 正从"单局面 GTO 求解器"演进为 **GTO 训练 + 牌谱复盘平台**,建立在
vendored 的两人翻后 GTO 引擎之上。架构权威见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md),
阶段划分见 [docs/ENGINEERING_ROADMAP.md](./docs/ENGINEERING_ROADMAP.md)(本文不复述,单一事实源)。

当前分层:

- `postflop-solver/` —— vendored 的 Rust GTO 引擎(AGPL-3.0)。
- `solver-wasm/` —— wasm-bindgen 接口层,编译出前端使用的 WASM;`solve_spot` 正演进为
  `open_spot`/`query_node`/`close_spot` 会话 API(旧接口降为薄包装,向后兼容)。
- `frontend/` —— Vue 3 + Vite 前端;`frontend/src/wasm/solver/` 是**已提交**的 WASM 产物。
- `frontend/src/domain/` —— 领域模型 / 策略服务(`GtoPolicy`)/ 评估引擎,训练与复盘的公共地基。

未来计划加入后端服务(暂定 `backend/`,倾向 Rust axum,命中 ARCHITECTURE §9 触发器才引入)。

## 契约:单一事实源

核心类型/接口只在代码定义一次,文档只描述+引用不复制:

- 领域模型类型:`frontend/src/domain/types.js`(`Hand`/`GameState`/`DecisionNode` 等 @typedef,
  含 `GameState=reduce(setup,actionLog,boardLog)` 不变式与会话 API 契约头注)。
- 策略接口:`frontend/src/domain/policy/gtoPolicy.js`(`GtoPolicy.query(node)`)。
- 评估契约:`frontend/src/domain/eval/deviationEvaluator.js`。
- 前端纯 JS(项目现状非 TS),类型用 JSDoc @typedef。

## 构建入口

- 根目录 `Makefile` 是唯一的构建/开发命令入口。新增语言或服务(例如 Go 后台)时,
  通过在 `Makefile` 中扩展 target(如 `build-backend`、`test-go`)接入,而非各自散落脚本。
- `frontend/package.json` 的 scripts 与 Makefile 配合:`check`(构建校验)、`clean`。
  不要引入未安装的依赖(无 eslint / vue-tsc 等)。

## 常用命令

```bash
make help      # 全部命令
make doctor    # 检查 node/npm/cargo/wasm-pack
make dev       # 前端开发服务器(缺依赖自动安装)
make build     # build-wasm + build-frontend
make test      # test-rust + test-frontend
make clean     # 清理产物(保留已提交的 WASM)
```

- WASM 输出:`solver-wasm` → `frontend/src/wasm/solver/`(已提交,改引擎才需重编)。
- 前端产物:`frontend/dist/`。
- `make clean` 不删除源码,也不删除已提交的 `frontend/src/wasm/solver/`。

## 约束与约定

- **README 只讲用途、快速开始、构建、测试、结构、贡献、许可证等。**
  不要写视觉主题(如配色/牌桌风格)或架构取舍宣传(如"纯前端/无后端/零服务器算力"),
  也不要把设计实现细节当卖点。
- 更长的说明放到独立文档,README 内使用相对链接。
- **二开归属**:README 必须明确说明本项目是在上游开源项目
  [b-inary/postflop-solver](https://github.com/b-inary/postflop-solver) 基础上的二次开发,
  并链接上游仓库与其 AGPL-3.0 许可证。这是许可证与出处要求,不是宣传,不要删除。
- License 为 AGPL-3.0(衍生自 postflop-solver);作为网络服务部署须提供对应源码。
- **不要提交构建/缓存产物**:`node_modules`、`dist`、`.vite` 缓存、Rust `target/`、
  wasm-pack `pkg/`、Go 构建产物、系统/编辑器临时文件都应被忽略。根 `.gitignore` 是唯一来源;
  新增语言/服务时同步补充其产物规则,并保持 `make clean` 与之一致。
  已提交的 WASM 产物 `frontend/src/wasm/solver/` 是例外,需保留。
- Rust 工具链(cargo / wasm-pack)可能在某些环境缺失;此时前端仍可基于已提交的 WASM 运行,
  但 `make build-wasm` / `make test-rust` 需要相应工具。不要因本机缺少 cargo 就删除 Rust 相关命令。
