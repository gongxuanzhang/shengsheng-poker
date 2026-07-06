# 工程路线图(ENGINEERING ROADMAP)

按短期 / 中期 / 长期分阶段列出可搭建的工程能力。每条给出**收益**、**落地文件**、**验收方式**。
架构现状与边界见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

原则:

- 每一步都能通过根 `Makefile` 验证,不引入无法在本仓库跑通的重依赖。
- 需要 Rust 工具链(cargo/wasm-pack)的门禁一律**工具链就绪时才作为硬门禁**,缺失时可跳过而非报错。
- 契约(`solve_spot` / `SolveResult`)是主线:所有跨层能力都围绕"契约不漂移"演进。

---

## 短期(低成本、高收益,不引入重依赖)

### S1. CI:PR 上自动跑前端构建校验
- **收益**:合并前挡住"打不出包"的回归;`make ci-frontend` 从"记得手动跑"变成强制门禁。
- **落地文件**:`.github/workflows/ci.yml`(前端 job:`node` → `make ci-frontend`)。
- **验收**:开 PR 后 Actions 出现绿色 check;故意写坏一处让 `vite build` 失败可复现红叉。

### S2. CI:Rust 引擎/接口层测试(工具链就绪时)
- **收益**:`postflop-solver` 与 `solver-wasm` 的 `cargo test`、`make build-wasm` 进入 CI,防止引擎改动破坏 WASM 产物。
- **落地文件**:同 `ci.yml` 增加 rust job(装 Rust + wasm-pack,跑 `make test-rust` 与 `make build-wasm`)。
- **验收**:CI 上 rust job 通过;本机若无 cargo,以 `make doctor` 提示为准,不在本机声称通过。

### S3. WASM 产物一致性校验
- **收益**:防止"改了引擎但忘了重编 WASM"——已提交的 `frontend/src/wasm/solver/` 与源码脱节。
- **落地文件**:`ci.yml` 中一步 `make build-wasm` 后 `git diff --exit-code frontend/src/wasm/solver/`(仅在 rust job)。
- **验收**:产物与源码一致时 diff 为空;不一致时 CI 失败并提示需重新 `make build-wasm`。

### S4. Makefile 的 CI 友好聚合
- **收益**:CI 与本地共用同一入口;无需在 workflow 里重复命令。
- **落地文件**:`Makefile` 增补(如 `ci-frontend` 复用 `build-frontend` 的干净安装与生产构建),`make help` 已按注释自动生成。
- **验收**:`make help` 列出新 target;`make ci-frontend` 在本机通过。

---

## 中期(补齐契约与质量,可能引入前端 dev 依赖,需先评估)

### M1. 契约单一事实源(消除第 4 节的类型漂移)
- **收益**:`solve_spot` 入参与 `SolveResult` 出参由一份 schema 生成 TS 类型(未来还生成 Go 结构体),
  Rust 改字段时前端/后台编译期即报错,而非线上裸取 `undefined`。
- **落地文件**:`schema/solve.schema.json`(或从 Rust 用 `schemars` 导出);`frontend/src/wasm/solver-types.d.ts`(生成);
  在 `Makefile` 加 `gen-types` target。
- **验收**:`make gen-types` 产出的 TS 类型能被 `solver.worker.js` 引用;`make test-frontend` 通过。

### M2. 前端类型/静态检查门禁
- **收益**:当前 `check` 仅为一次 `vite build`,不做类型/规范检查。引入 `vue-tsc` + ESLint(flat config)后可挡住类型与低级错误。
- **落地文件**:`frontend/package.json` devDependencies(`vue-tsc`、`eslint`、`eslint-plugin-vue`);
  `frontend/eslint.config.js`;`Makefile` 的 `test-frontend` 追加 lint/typecheck。
- **前置约束**:CLAUDE.md 当前明确"不要引入未安装的依赖(无 eslint/vue-tsc)"。落地前需先安装并验证,
  并同步更新 CLAUDE.md 与 README 的测试说明,避免文档与实际脱节。
- **验收**:`make test-frontend` 依次跑 typecheck + lint + build 全绿。

### M3. 前端单元测试
- **收益**:为纯逻辑(board 拆分、`overall_freq` 展示换算、输入校验)加回归测试,不再只靠"能打包"。
- **落地文件**:`frontend/` 引入 `vitest`;`*.test.js`;`package.json` 加 `test` script;`Makefile` 接入。
- **验收**:`make test-frontend` 触发 vitest,示例用例通过。

### M4. Go 后台脚手架(重局面计算层)
- **收益**:把超出浏览器预算(内存 > 800MB / flop 全解 30–45s)的局面下沉到可多线程的后台;
  复用同一契约,前端按规模路由。
- **落地文件**:`backend/`(`go.mod`、`/solve` handler);`Makefile` 加 `build-backend`/`test-go` 并接进 `build`/`test`;
  同步 CLAUDE.md 与 ARCHITECTURE.md 第 7 节。
- **验收**:`make build-backend`、`make test-go` 通过;`/solve` 返回结构与 `SolveResult` 对齐(用 M1 的 schema 断言)。

---

## 长期(服务化与发布工程)

### L1. 长求解的异步作业与结果缓存
- **收益**:重局面不再阻塞请求;相同局面命中缓存直接返回。
- **落地文件**:`backend/` 的 job 队列与缓存层;契约扩展为"提交作业 → 轮询/推送结果"。
- **验收**:提交一个 flop 全解作业能异步完成并落缓存,二次请求显著更快(有基准数字)。

### L2. 端到端测试
- **收益**:覆盖"输入局面 → Solve → 渲染网格"整链路,防 UI 与契约联合回归。
- **落地文件**:`frontend/` 引入 Playwright;`e2e/` 用例;CI 增 e2e job。
- **验收**:CI 上 e2e 跑通默认 turn 局面并断言出现动作频率。

### L3. 发布工程:版本、镜像与产物溯源
- **收益**:前端 `dist/` 与(未来)后台镜像可复现发布;WASM 产物可溯源到源码 commit;满足 AGPL 源码提供义务的发布流程固化。
- **落地文件**:release workflow(打 tag → 构建 → 附产物);容器化 `backend/`;发布说明模板含对应源码入口。
- **验收**:打一个 tag 能自动产出前端产物与后台镜像,发布物内含或指向对应源码。

### L4. 观测性
- **收益**:后台求解的耗时/内存/错误可观测,支撑容量规划与 SPR/范围护栏调参。
- **落地文件**:`backend/` 接入指标与结构化日志;仪表盘配置。
- **验收**:一次求解产生可查询的耗时与内存指标。

---

## 依赖关系速览

```
S1 前端 CI ─┐
S2 Rust CI ─┼─► S3 WASM 一致性 ─► (质量门禁成型)
S4 Make 聚合┘

M1 共享 Schema ─► M2 前端类型检查 ─► M4 Go 后台 ─► L1 异步作业 ─► L3 发布
                 M3 前端单测 ────────────────────► L2 E2E
                                                    L4 观测性
```

短期条目彼此独立、可并行落地;中期以 M1(共享 schema)为枢纽;长期均建立在 `backend/` 之上。
