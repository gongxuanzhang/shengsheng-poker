# 工程路线图(ENGINEERING ROADMAP)

按**产品阶段 P0–P4** 分解落地工作,阶段划分与 [ARCHITECTURE.md §9](./ARCHITECTURE.md#9-演进路径)
一致。本文只列**每阶段做什么、落哪些文件、怎么验收**;架构与边界的权威解释在 ARCHITECTURE.md,
不在此复述。契约的单一事实源在代码里(见 ARCHITECTURE §7),本文只引用不复制。

原则:

- 每一步都能通过根 `Makefile` 验证,不引入无法在本仓库跑通的重依赖。
- 需要 Rust 工具链(cargo/wasm-pack)的门禁**工具链就绪时才作为硬门禁**,缺失时可跳过而非报错。
- 主循环只认 `GtoPolicy.query(node)`,不按街分叉;领域模型 `GameState=reduce(...)` 是单一事实源。

---

## P0 · 共享地基(本期)

训练与复盘的公共地基,后续所有代码建立在此。**先做对**。

### P0.1 领域模型
- **收益**:`Hand`/`GameState`/`DecisionNode` 成为训练写、复盘读共用的单一事实源。
- **落地文件**:`frontend/src/domain/types.js`(类型契约,已建);同目录 `hand.js`/`gameState.js`
  实现 `reduce(setup, actionLog[..cursor], boardLog)` 与 `deriveDecisionNode`。
- **验收**:给定 setup+actionLog+boardLog,reduce 出正确 GameState,派生出结构一致的 DecisionNode;
  同一 Hand 在任意 cursor 处可重放。

### P0.2 会话 API 改造
- **收益**:兑现"一次 solve 覆盖整条街"的杠杆;solved game 常驻 Worker 跨节点复用。
- **落地文件**:`solver-wasm/src/lib.rs` 新增 `open_spot`/`query_node`/`close_spot`;
  旧 `solve_spot` 降为薄包装;`frontend/src/solver.worker.js` 暴露会话方法;`make build-wasm` 重编。
- **验收**:`open_spot` 一次后多次 `query_node(path)` 读到不同节点的 strategy/EV;
  `SolverView` **零改动**仍可用(旧 solve_spot 行为不变);内存护栏(>800MB 报错)保留。

### P0.3 策略接口 + 翻后实现
- **收益**:主循环统一 `policy.query(node)`,翻后走会话导航。
- **落地文件**:`frontend/src/domain/policy/gtoPolicy.js`(接口,已建)填充 `PostflopSolverPolicy`
  与 `CompositeGtoPolicy`。
- **验收**:对一个两人 turn 局面,`query(node)` 返回与 `legalActions` 对齐的 `NodeStrategy`(freq/EV)。

### P0.4 评估引擎
- **收益**:训练/复盘共用同一偏差判定。
- **落地文件**:`frontend/src/domain/eval/deviationEvaluator.js`(接口,已建)填充 `evaluate`。
- **验收**:给实选动作 + NodeStrategy,算出 `EV 损失 = max_a EV[a] − EV[chosen]`、%pot 严重度分档、
  支撑集标记。

### P0.5 共享 UI 抽取
- **收益**:StrategyGrid 被 SolverView/Trainer/Review 三处复用。
- **落地文件**:从 `SolverView.vue` 抽 `frontend/src/components/StrategyGrid.vue` +
  `frontend/src/lib/strategy.js`(`actionColor`/`handToRC`/`cellStyle`/13×13)。
- **验收**:SolverView 改用抽出的组件后行为不变;`make ci-frontend` 通过。

---

## P1 · 训练(真实实战对局)

- **收益**:9 人桌翻前(bot 按范围表)+ 翻后收敛两人进入 GTO 训练,hero 打完整一手、逐点得反馈。
- **落地文件**:`frontend/src/components/train/`(TrainerView + PlayerActionBar + DecisionFeedback);
  `frontend/src/domain/policy/` 填充 `PreflopChartPolicy`(先内置占位 100bb 范围);
  showdown 7 张牌结算器;localStorage 弱点统计。
- **验收**:打完整一手 heads-up 对局,翻前查表对照 + 翻后 GTO 反馈(EV 损失/频率/严重度)逐点显示;
  multiway 手显式标注"翻后不可训练";翻前/多人反馈标注为近似(`approximate`)。

## P2 · 复盘(牌谱)

- **收益**:导入真实牌谱,逐街回放 + 每决策点偏差标注。
- **落地文件**:`frontend/src/components/review/`(导入/回放/报告);牌谱 parser 可插拔 registry
  (v1 PokerStars 文本 + 手动输入);范围重建(内置翻前图);IndexedDB 存牌谱与解缓存。
- **验收**:导入一份牌谱→逐街回放→每个 hero 决策点标注偏差/EV 损失 + 整手报告;
  解析失败降级为 warning;不可复盘手(multiway)显式标 reason。

## P3 · 闭环与聚合

- **收益**:训练与复盘数据互通,形成"练→复盘→再练"闭环。
- **落地文件**:跨手漏洞聚合报表(按街/动作/局面聚合 EV 损失)→ leak finder;靶向选题反哺训练。
- **验收**:复盘发现的漏洞自动进训练选题。

## P4 · 后端(命中触发器才启动)

- **触发器**(命中任一才上,否则纯前端够用):见 [ARCHITECTURE.md §9](./ARCHITECTURE.md#9-演进路径)。
- **收益**:任意 flop 起手实时训练降到数秒;canonical spot 全网解一次复用;批量复盘不再各磨 40s。
- **落地文件**:`backend/`(倾向 Rust axum,复用 `postflop-solver` default features:rayon+bincode);
  规范化 spot 共享缓存(bincode+zstd);批量队列;可选牌谱持久化;根 `Makefile` 加
  `build-backend`/`test-go`(或 `test-rust-backend`)并接进 `build`/`test`;同步 CLAUDE.md 与 ARCHITECTURE。
- **验收**:重局面走后端多线程求解;`/solve` 返回结构与会话 API 的 `NodeResult` 对齐;AGPL 源码义务落实。

---

## 横切:工程质量门禁(与产品阶段并行,随时可做)

不绑定单一产品阶段的基础设施能力。

### X1. CI:前端构建校验
- **落地文件**:`.github/workflows/ci.yml`(前端 job:`make ci-frontend`)。
- **验收**:PR 上 Actions 出现绿色 check;故意写坏一处让 `vite build` 失败可复现红叉。

### X2. CI:Rust 测试 + WASM 一致性(工具链就绪时)
- **落地文件**:`ci.yml` 增 rust job(装 Rust+wasm-pack,跑 `make test-rust`、`make build-wasm`,
  再 `git diff --exit-code frontend/src/wasm/solver/`)。
- **验收**:rust job 通过;WASM 产物与源码脱节时 CI 失败并提示重编。

### X3. 契约类型检查(可选,随 P1 铺开时评估)
- **收益**:领域类型与会话 API 契约漂移在开发期即暴露。
- **落地文件**:若引入 `vue-tsc`/JSDoc 检查,先安装并同步更新 CLAUDE.md/README 的测试说明
  (当前 CLAUDE.md 明确"不引入未安装依赖")。
- **验收**:`make test-frontend` 跑 typecheck + build 全绿。

### X4. 前端单元测试
- **落地文件**:引入 `vitest`;为 reducer / 评估器 / strategy 换算加 `*.test.js`。
- **验收**:`make test-frontend` 触发 vitest,示例用例通过。
