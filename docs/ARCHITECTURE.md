# 架构说明(ARCHITECTURE)

shengsheng-poker 的架构权威文档。目标产品是 **GTO 训练 + 牌谱复盘平台**,建立在
vendored 的两人翻后 GTO 引擎之上。读者是要在本仓库继续开发的工程师与 AI agent。

- 本文只**描述架构与边界并指向代码**,不复制类型/接口定义。契约的单一事实源在代码里:
  领域模型 `frontend/src/domain/types.js`、策略接口 `frontend/src/domain/policy/gtoPolicy.js`、
  评估 `frontend/src/domain/eval/deviationEvaluator.js`、引擎会话 `solver-wasm/src/lib.rs`。
- 阶段划分见 [ENGINEERING_ROADMAP.md](./ENGINEERING_ROADMAP.md);运行/构建见 [根 README](../README.md);
  给 AI 的工作约定见 [CLAUDE.md](../CLAUDE.md)。四文档职责不重叠、互相引用而非粘贴。

---

## 1. 分层总览

自上而下的层。**领域模型 / 策略服务 / 评估引擎是训练与复盘的公共地基;训练与复盘只是它
上面的两个前端形态。求解引擎在底层;后端是 P4 预留的触发式可选层。**

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 前端应用   SolverView(现状) · Trainer(实战对局) · Review(牌谱复盘)          │
│            共享 UI:StrategyGrid + lib/strategy.js(actionColor/13×13)/Card   │
├────────────────────────────────────────────────────────────────────────────┤
│ 评估引擎   DeviationEvaluator:实选 vs GTO → EV 损失 + 频率偏差 + 严重度 + 支撑集 │
│   frontend/src/domain/eval/                        (训练/复盘同一实现,零求解)│
├────────────────────────────────────────────────────────────────────────────┤
│ 策略服务   GtoPolicy.query(node) → NodeStrategy                               │
│   frontend/src/domain/policy/    翻前 PreflopChartPolicy(查表)              │
│                                  翻后 PostflopSolverPolicy(引擎会话)         │
├────────────────────────────────────────────────────────────────────────────┤
│ 领域模型   Hand = {setup, actionLog, boardLog} ──纯 reduce──► GameState        │
│   frontend/src/domain/           ──派生──► DecisionNode + RangeAssignment      │
├────────────────────────────────────────────────────────────────────────────┤
│ 求解引擎   solver-wasm 会话 API:open_spot / query_node(path) / close_spot     │
│   solver-wasm/src/lib.rs         旧 solve_spot = open+query(root)+close 薄包装 │
│   └── postflop-solver(vendored, AGPL):CFR 求解 + apply_history 树导航         │
├────────────────────────────────────────────────────────────────────────────┤
│ 后端(P4 预留,命中触发器才引入)  重局面多线程求解 / 共享缓存 / 持久化 / 队列  │
└────────────────────────────────────────────────────────────────────────────┘
```

上游引擎 `postflop-solver/` 来自 [b-inary/postflop-solver](https://github.com/b-inary/postflop-solver),
以 AGPL-3.0 发布;本仓库作为衍生作品同样受 AGPL-3.0 约束(见根 [LICENSE](../LICENSE))。

| 层 | 落地位置 | 职责 | 边界(不做什么) |
|---|---|---|---|
| 领域模型 | `frontend/src/domain/` | `Hand`/`GameState` reducer、`DecisionNode` 派生、`RangeAssignment` | 不含 GTO 计算;不感知 UI;不双持久化派生态 |
| 策略服务 | `frontend/src/domain/policy/` | `GtoPolicy.query(node)` 统一接口 + 翻前表/翻后会话两实现 | 不建 UI;不做偏差判定(交给评估层) |
| 评估引擎 | `frontend/src/domain/eval/` | `DeviationEvaluator`(EV 损失/严重度/支撑集) | 不求解(只读 NodeStrategy) |
| 求解引擎 | `solver-wasm/` + `postflop-solver/` | 有状态会话:solved game 常驻 Worker,按 path 导航读值 | 不含领域语义(动作日志→history 映射在领域层) |
| 前端应用 | `frontend/src/components/{train,review}/` + `lib/strategy.js` | Trainer / Review 两壳 + 共享 StrategyGrid | 不做求解(委托引擎);不各写一套评估 |
| 后端 | `backend/`(P4 后新增) | 重求解 / 共享缓存 / 持久化 / 批量队列 | 复用同一契约,不另造数据结构 |

## 2. 训练形态:真实实战对局

训练不是决策题,而是**打完整一手**,翻前+翻后都有 GTO 反馈:

- **9 人桌翻前**:真实位置博弈,bot 按范围表行动,hero 参与真实翻前决策。
- **翻后收敛两人才进入翻后 GTO 训练**:当翻牌只剩 hero + 1 人时才对翻后 solve;
  multiway(翻后仍多人)的手自然被过滤,因为多人翻后没有 GTO(见 §4)。
- bot **开局锁定一手具体牌**全程行动(线路自洽、可 showdown,分布仍取自 GTO/范围)。

**编排(单一事实源在代码)**:`frontend/src/training/` 把 §1 的地基串成一手可玩流程。
`session.js` 的 `TrainingSession` 是编排核心——事实源 `Hand = {setup, actionLog, boardLog}`,
GameState 恒为 reduce 结果:

- `newHand` 建 9 座/盲注/发牌;`advance()` 自动跑 bot 到 hero 回合或本手结束,并逐街揭示公共牌。
- **翻前→翻后接缝**:进翻牌前按存活人数分流——恰两人且双方有筹码 → 注入翻前**续牌范围**
  (`preflopLine.js` 的 `deriveContinuation`)开翻后 solve;3+ 人标注 multiway 跑马摊牌不训练翻后。
- `heroAct(action)`:先 `GtoPolicy.query` + `DeviationEvaluator` 生成反馈记账,再落动作、`advance()`。
- 辅助:`deck.js`(洗牌/发牌,可注入 rng)、`handEvaluator.js`(7 张牌力)、`settlement.js`(边池分配)。

**翻后下注尺寸对齐求解树**:求解树只含有限档尺寸(`betSizes` + allin)。hero 若下非引擎档位额度,
`TrainingSession` 在 `heroAct` 内把 amount 就近吸附到匹配档位的引擎额度,保证 reducer 实际下注、
评估依据、solver 树内导航三者沿同一条线。翻前(查表)不受此约束、尺寸自由。

**反馈维度按理论边界分**(§4):翻前查表无 EV → **频率维度**(各动作频率 + 是否在支撑集,
「GTO 最优」取最高频率动作);翻后精确 solve → **EV 维度**(EV 损失 / %pot 严重度 / 支撑集)。

**UI**:`frontend/src/components/train/` —— `TrainerView.vue`(接线 Worker 会话 + 三个策略/评估依赖,
镜像 `TrainingSession` 快照)、`PokerTable.vue`(军绿牌桌)、`ActionBar.vue`(按 `legalActions` 出招)、
`FeedbackPanel.vue`(频率/EV 两态反馈 + 决策时间线)、`HandControls.vue`(发新手 + 弱点统计)。
App.vue 以 Tab 在 SolverView 与训练场间切换。

> 测试:领域 + 编排的纯 JS 单测走 `node --test`(见根 `Makefile` 的 `test-frontend-unit`,
> 已挂进 CI);翻后真 Worker 路径已单独验证正确。

## 3. 两大需求共享同一地基

训练与复盘是**同一时间轴上的写 / 读两端**——"实时对局就是正在被书写的复盘"。整套系统
只有两条接缝:①被选动作来源(实时输入/bot 采样 vs 日志历史);②遍历方式(追加日志后
cursor 自增 vs 在预填日志上任意跳点)。主循环对两者统一:

```
训练(写):setup 给定,actionLog 从空增长
  deriveDecisionNode(state) → GtoPolicy.query(node) → bot 采样 / hero 输入
      → DeviationEvaluator(chosen, gto) → 即时反馈 → actionLog.push → cursor++

复盘(读):解析牌谱预填 setup+actionLog+boardLog,cursor 任意移动
  设/移 cursor → reduce(log[..cursor]) → deriveDecisionNode → GtoPolicy.query(node)
      → DeviationEvaluator(logAction, gto) → 逐点标注偏差 / EV 损失

统一:node → policy.query → chosen → evaluator → append_or_advance
```

因此领域模型、策略服务、评估引擎三层被两个前端形态原样复用,类型契约见 `types.js`
的不变式注释(`Hand`/`GameState`/`DecisionNode`)。**翻前/翻后不在主循环分叉**——两者
都只是"某玩家必须选择"的 `DecisionNode`,差异被 `GtoPolicy` 藏起来。

## 4. 策略分层与理论边界

`GtoPolicy` 是统一接口:主循环只调 `policy.query(node)`,不按街 if/else。两个实现对应
理论边界的两侧:

| | 翻前 | 翻后 |
|---|---|---|
| 实现 | `PreflopChartPolicy` | `PostflopSolverPolicy` |
| 机制 | 查固定范围表(静态数据,毫秒级,无算力问题) | 引擎 solve 一次 + 树内导航 |
| 精度 | 多人**近似**标准范围(查表够用),`approximate=true` | 两人**精确** GTO,`approximate=false` |
| 数据 | P0 用内置简化/占位范围(结构正确即可,来源完善为 TODO) | vendored CFR 引擎 |

**理论边界(为什么这样设计,非本引擎短板而是全行业边界):**

- **两人翻后有精确 GTO** → 引擎 `current_player() ∈ {0=OOP, 1=IP}`,可求解不可剥削策略。
- **多人翻后无 GTO** → 三人及以上无唯一均衡解(全行业边界),故 multiway 手在翻后被过滤,
  不让 GTO 反馈假装权威。
- **翻前多人有近似标准范围** → 无精确解但有业界公认范围表,查表足够,标注为近似对照。

翻前表输出的**续牌范围**正是翻后 solve 的 `oopRange/ipRange` 入参来源(`RangeAssignment`),
这是两个策略提供者之间的数据接缝,必须显式挂在 GameState 上、UI 可见、用户可覆盖。

## 5. 关键杠杆:一次 solve 覆盖整条街

引擎最反直觉、也最高价值的能力:`solve()` 一次后,内部已含该街之后**所有** turn/river
发牌(chance 节点)与全部行动线;`cache_normalized_weights()` 后用 `back_to_root()` /
`apply_history(&[usize])` / `play(idx)` 可跳到任意节点,读 `available_actions()` /
`strategy()` / `expected_values(p)` / `equity(p)`。导航是切片读取,微秒~低毫秒级。

> **推论:一手翻后的全部决策点 = 1 次 solve + N 次近乎免费的 query**,而非 N 次 solve。

据此 `solve_spot` 升级为**会话 API**(契约与语义定义见 `solver-wasm/src/lib.rs` 与
`types.js` 头部注释):

- `open_spot(req) → handle`:建局 + 内存护栏 + CFR 求解一次,solved game 留在 Worker(唯一的重活)。
- `query_node(handle, path) → NodeResult`:沿 path 导航到目标节点读值,纯读取,可反复调用。
- `close_spot(handle)`:释放常驻 game。
- 旧 `solve_spot` 降为 `open + query(root) + close` 的薄包装,**向后兼容,SolverView 零改动**。

`PostflopSolverPolicy` 据此把整手翻后摊到 1 次求解:同一 spot 的不同 `NodePath` 复用同一
handle。spot 身份(缓存键)= `(oopRange, ipRange, board, 该街起始底池, 有效筹码, betTree)`。

## 6. 引擎硬约束(一切取舍的事实依据)

均来自代码勘察,是层与形态选择的物理边界:

- **单线程 wasm**:`solver-wasm` 关闭引擎默认 feature(`rayon`/`bincode`),浏览器内单线程。
- **内存护栏**:`open_spot`/`solve_spot` 预估未压缩内存 > **800 MB** 即报错,防浏览器 OOM。
- **成本分布极不均匀**:flop 起手 solve 单线程约 **30–45s**(唯一重活);turn 起手亚秒、
  river 起手几十毫秒;树内导航微秒级。**本期不优化性能**:MVP 翻后先支持能快速 solve 的
  场景(turn/river 起手,亚秒级);任意 flop 起手的实时训练是已知坎,留到 P4 后端。
- **翻前查表无算力问题**,不受上述约束。

## 7. 契约(单一事实源在代码里)

跨层/跨语言的契约只在代码定义一次,本文只指向:

| 契约 | 定义位置 | 内容 |
|---|---|---|
| 领域模型类型 | `frontend/src/domain/types.js` | `Card`/`Position`/`Street`/`Player`/`Blinds`/`DomainAction`/`HandSetup`/`Hand`/`GameState`/`DecisionNode`/`LegalAction`/`RangeAssignment`/`NodeStrategy` 等 @typedef,及 `GameState=reduce(setup,actionLog,boardLog)` 不变式 |
| 会话 API | `solver-wasm/src/lib.rs` + `types.js` 头注 | `open_spot(req)→handle` / `query_node(handle,path)→NodeResult` / `close_spot(handle)` 签名与语义 |
| 策略接口 | `frontend/src/domain/policy/gtoPolicy.js` | `GtoPolicy.query(node)→NodeStrategy`;`PreflopChartPolicy`/`PostflopSolverPolicy`/`CompositeGtoPolicy` |
| 评估契约 | `frontend/src/domain/eval/deviationEvaluator.js` | `DeviationEvaluator.evaluate(chosen,gto,node)→DeviationResult`;`Severity` 分档 |

## 8. 构建与发布边界

统一入口是根 `Makefile`(见 [根 README](../README.md) 与 `make help`)。

| 阶段 | 命令 | 输入 → 输出 | 是否提交 |
|---|---|---|---|
| 编译引擎为 WASM | `make build-wasm` | `solver-wasm/` →(wasm-pack)→ `frontend/src/wasm/solver/` | 输出**已提交** |
| 打包前端 | `make build-frontend` | `frontend/` →(vite build)→ `frontend/dist/` | 不提交 |
| 完整构建 | `make build` | 先 WASM 后前端 | — |

- **WASM 产物已提交**:缺 Rust 工具链也能只跑前端;仅改 `postflop-solver/` 或 `solver-wasm/`
  后才需 `make build-wasm` 重新生成。
- **AGPL 义务**:作为网络服务对外提供时须向使用者提供完整对应源码(含本仓库改动)。

## 9. 演进路径

阶段总览如下,每阶段的落地文件与验收见 [ENGINEERING_ROADMAP.md](./ENGINEERING_ROADMAP.md)。

| 阶段 | 内容 | 里程碑 |
|---|---|---|
| **P0 · 共享地基**(本期) | 领域模型(`types.js` + reducer/派生);会话 API 改造(`solve_spot`→`open/query/close`,旧接口薄包装);`GtoPolicy` 接口 + `PostflopSolverPolicy`;`DeviationEvaluator`;从 SolverView 抽 `StrategyGrid` + `lib/strategy.js` | 会话 API 能"解一次、导航任意节点读 strategy/EV";SolverView 零改动仍可用;评估器在一个 turn 局面上算出 EV 损失 |
| **P1 · 训练** | Trainer:9 人桌翻前(bot 按范围表)+ 翻后收敛两人进入 GTO 训练;`PreflopChartPolicy`(先内置占位范围);`PlayerActionBar` + `DecisionFeedback`;showdown 结算;弱点统计 | 打完整一手 heads-up 对局,翻前+翻后逐点得 GTO 反馈(EV 损失/频率/严重度);multiway 手诚实标注不可训练 |
| **P2 · 复盘** | 牌谱 parser(可插拔 registry)+ 手动输入;范围重建(内置翻前图);回放/导入/报告 UI;IndexedDB 存牌谱与解缓存 | 导入牌谱→逐街回放→每个 hero 决策点标注偏差/EV 损失 + 整手报告;不可复盘手显式标 reason |
| **P3 · 闭环** | 跨手漏洞聚合(按街/动作/局面聚合 EV 损失)→ leak finder;靶向选题反哺训练 | 复盘发现的漏洞自动进训练选题,形成"练→复盘→再练"闭环 |
| **P4 · 后端**(命中触发器才启动) | 倾向 Rust axum:重局面 rayon 求解、规范化 spot 共享缓存(bincode+zstd)、批量复盘队列、可选牌谱持久化;前端按局面规模路由"浏览器内解/请求后端" | 任意 flop 起手实时训练降到数秒;canonical spot 全网解一次复用;AGPL 源码义务落实 |

**P4 触发器(命中任一才上后端,否则纯前端够用)**:① 任意 flop 起手的**实时**训练
(40s 单线程不可接受);② 跨用户共享预计算缓存;③ 牌谱持久化 / 多设备 / 账号;
④ 富动作树内存破 800MB 护栏;⑤ 批量复盘吞吐(队列而非每浏览器各磨 40s)。

后端语言倾向 **Rust axum**(直接复用 `postflop-solver` 的 default features:rayon 多线程 +
bincode 序列化,零 FFI),而非路线图早期默认的 Go——先决策语言再动工,避免返工。
