# shengsheng-poker

德州扑克 GTO(博弈论最优)求解器。输入翻牌后的局面,即可计算并展示双方的最优打法策略。

## 二开与上游开源项目

本项目是在开源项目 **[b-inary/postflop-solver](https://github.com/b-inary/postflop-solver)** 基础上的二次开发(二开):

- 上游的 Rust 求解引擎已 vendored 到 `postflop-solver/` 目录。
- 本仓库在其之上新增了 WASM 接口层(`solver-wasm/`)与 Web 前端(`frontend/`),
  把引擎能力集成为一个可直接在浏览器中运行的求解器。

上游 postflop-solver 以 **[AGPL-3.0](./LICENSE)** 许可证发布,本项目作为其衍生作品同样受 AGPL-3.0 约束:
无论是分发本项目,还是将其作为网络服务对外提供,都必须向使用者提供完整的对应源码(含本项目所做的修改)。
详见文末 [License](#license)。

## 功能概览

- 描述翻牌后局面:双方范围、公共牌、底池、有效筹码、可选下注尺度。
- 求解该局面下的 GTO 最优策略。
- 以 13×13 手牌网格展示每一手的动作分布。
- 汇总整体动作频率(如过牌/下注/加注/弃牌的比例)。
- 对专业术语提供悬停解释,便于理解结果。

## 技术栈

- **Rust** —— GTO 求解引擎。
- **WebAssembly**(wasm-pack / wasm-bindgen)—— 将引擎编译为可在浏览器运行的模块。
- **Vue 3 + Vite** —— 前端界面与交互。
- **GNU Make** —— 统一的构建/开发命令入口。

## 项目结构

| 目录 | 说明 |
|------|------|
| `postflop-solver/` | Rust GTO 引擎([b-inary/postflop-solver](https://github.com/b-inary/postflop-solver),已 vendored)。 |
| `solver-wasm/` | wasm-bindgen 接口层,把引擎能力暴露给前端。 |
| `frontend/` | Vue 3 + Vite 前端。 |
| `frontend/src/wasm/solver/` | 由 `solver-wasm` 编译得到的 WASM 产物(已提交,便于开箱运行)。 |
| [`Makefile`](./Makefile) | 仓库级构建/开发命令入口。 |

## 架构与工程文档

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) —— 分层结构、模块边界、数据流、构建/发布边界,以及未来 Go 后台的接入方式。
- [docs/ENGINEERING_ROADMAP.md](./docs/ENGINEERING_ROADMAP.md) —— 按短期 / 中期 / 长期分阶段的工程能力规划(含收益、落地文件、验收方式)。

## 环境要求

| 工具 | 版本 | 何时需要 |
|------|------|----------|
| [Node.js](https://nodejs.org) | ≥ 18 | 运行 / 构建前端(必需) |
| [Rust](https://rustup.rs) | ≥ 1.85 | 仅在需要重新编译引擎时 |
| [wasm-pack](https://rustwasm.github.io/wasm-pack/) | 最新 | 仅在需要重新编译引擎时 |
| [GNU Make](https://www.gnu.org/software/make/) | 任意 | 可选,用于统一命令入口 |

运行 `make doctor` 可检查本机工具链是否就绪。

## 快速开始

仓库已提交编译好的 WASM 产物,因此**只想运行前端时,无需 Rust 工具链**:

```bash
make dev
# 等价于: cd frontend && npm install && npm run dev
```

启动后打开 http://localhost:5173 ,填写局面并点击 **Solve**。

若修改了引擎(`postflop-solver/` 或 `solver-wasm/`),需要重新编译 WASM 后再构建前端:

```bash
make build
```

## 常用命令

所有命令通过根目录 `Makefile` 统一入口,运行 `make help` 查看完整列表。

| 命令 | 作用 |
|------|------|
| `make help` | 显示可用命令 |
| `make doctor` | 检查 node/npm/cargo/wasm-pack 是否就绪并输出版本 |
| `make install` | 安装前端依赖 |
| `make dev` | 启动前端开发服务器(缺依赖时自动安装) |
| `make build` | 完整构建:WASM 引擎 + 前端静态产物 |
| `make build-wasm` | 仅把 Rust 引擎编译为 WebAssembly |
| `make build-frontend` | 仅安装依赖并打包前端 |
| `make test` | 运行全部测试 |
| `make test-rust` | 运行 Rust 引擎与接口层测试 |
| `make test-frontend` | 前端构建校验 |
| `make clean` | 清理构建产物 |

## 构建与打包

- **WASM 产物**:`make build-wasm` 由 `solver-wasm` 编译,输出到
  `frontend/src/wasm/solver/`。该目录已随仓库提交,因此在缺少 Rust 工具链时也能直接运行前端;
  只有改动引擎后才需要重新生成。
- **前端静态产物**:`make build-frontend` 在 `frontend/` 下打包,输出到
  `frontend/dist/`,可直接作为静态资源部署。
- **完整构建**:`make build` 依次执行上述两步(先 WASM,后前端)。

## 测试 / 质量检查

```bash
make test           # Rust 测试 + 前端构建校验
make test-rust      # 仅 Rust(需要 cargo)
make test-frontend  # 仅前端构建校验(npm run check)
```

> 前端的 `check` 通过一次生产构建来校验代码可编译打包;在引入专门的 lint/类型检查工具后可进一步扩展。

## 后续规划

工程演进(含预留的 Go 后台服务及其接入方式)见 [docs/ENGINEERING_ROADMAP.md](./docs/ENGINEERING_ROADMAP.md)
与 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 贡献指南

1. Fork 仓库并从 `main` 切出特性分支。
2. 运行 `make doctor` 确认本机工具链就绪。
3. 提交前本地运行 `make test`(或至少 `make build-frontend`)确保通过。
4. 遵循根目录 `.editorconfig` 的基础编码/缩进规范。
5. 提交 Pull Request,并在描述中说明动机与改动范围。

## License

[AGPL-3.0](./LICENSE) —— 引擎 postflop-solver 采用 AGPL-3.0,本项目作为衍生作品同样采用
AGPL-3.0。若将其作为网络服务公开部署,须依据许可证向使用者提供完整对应源码。
