/**
 * 领域模型类型契约(单一事实源) —— 纯 JS + JSDoc @typedef。
 *
 * 本文件只定义**类型形状**,不含实现逻辑。训练(写)与复盘(读)共用这一套类型。
 * 架构说明见 docs/ARCHITECTURE.md;reducer / 派生逻辑将在同目录其它文件实现。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 核心不变式(整套系统的地基,务必遵守):
 *
 *   Hand = { setup, actionLog, boardLog }           // 唯一被持久化的事实源
 *   GameState = reduce(setup, actionLog[..cursor], boardLog)   // 纯函数派生,不双持久化
 *   DecisionNode = deriveDecisionNode(GameState)     // 从 GameState 再派生
 *
 * 训练与复盘只差两条接缝:
 *   1. 被选动作来源:实时输入 / bot 采样(训练) vs 日志历史(复盘)
 *   2. 遍历方式:  追加日志后 cursor 自增(训练) vs 在预填日志上任意跳点(复盘)
 * 主循环对两者统一:node -> GtoPolicy.query(node) -> chosen -> DeviationEvaluator -> append_or_advance
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * solver-wasm 会话 API 契约(有状态,solved game 常驻 Worker 跨节点复用)
 *
 * 关键杠杆:引擎 `solve()` 一次即含该街之后所有 chance/action 节点;solve 后可
 * `back_to_root()` / `apply_history(&[usize])` 跳到任意节点读值,导航是微秒级切片读取。
 * 因此「一手翻后的全部决策点 = 1 次 solve + N 次近乎免费的 query」,而非 N 次 solve。
 *
 *   open_spot(req: OpenSpotRequest) -> handle: number
 *       建局 + 内存护栏(未压缩 > 800MB 直接报错) + CFR 求解一次,
 *       把 solved PostFlopGame 留在 Worker 内,返回句柄。这是唯一的「重活」。
 *
 *   query_node(handle: number, path: number[]) -> NodeResult
 *       从该街 root 沿 path(动作下标序列)导航到目标节点,读取该节点的
 *       策略 / EV / equity / 权重。纯读取,微秒~低毫秒级,可反复调用。
 *
 *   close_spot(handle: number) -> void
 *       释放该句柄对应的常驻 game,回收内存(会话生命周期结束时调用)。
 *
 *   旧 solve_spot(...) = open_spot + query_node(root) + close_spot 的薄包装,
 *   向后兼容,SolverView 零改动。NodeResult 形状见下方 @typedef。
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ═══════════════════════════ 基础标量类型 ═══════════════════════════

/**
 * 一张牌:两字符 `rank+suit`。rank ∈ "AKQJT98765432",suit ∈ "shdc"。
 * 例:"As"(黑桃A)、"Td"(方块10)、"2c"(梅花2)。
 * @typedef {string} Card
 */

/**
 * 9 人桌位置。按行动顺序(翻前)自 UTG 起。
 * @typedef {('UTG'|'UTG1'|'UTG2'|'LJ'|'HJ'|'CO'|'BTN'|'SB'|'BB')} Position
 */

/**
 * 街。翻前查表、翻后引擎会话;差异由 GtoPolicy 藏起来,主循环不按街分叉。
 * @typedef {('preflop'|'flop'|'turn'|'river')} Street
 */

/**
 * 领域动作类型。amount 语义见 DomainAction。
 * @typedef {('fold'|'check'|'call'|'bet'|'raise'|'allin')} ActionType
 */

// ═══════════════════════════ 配置(setup)类型 ═══════════════════════════

/**
 * 盲注与前注(单位:筹码,通常以 bb 计)。
 * @typedef {Object} Blinds
 * @property {number} sb   小盲
 * @property {number} bb   大盲
 * @property {number} [ante] 前注(可选,每人或 BB ante 由 setup 约定)
 */

/**
 * 一名玩家的开局配置(不含随对局变化的派生态,如剩余筹码由 reduce 计算)。
 * @typedef {Object} Player
 * @property {string}   id        席位唯一 id
 * @property {Position} position  9 人桌位置
 * @property {number}   stack     开局筹码(有效筹码由 setup/派生态给出)
 * @property {[Card,Card]} [holeCards] 底牌;bot 开局锁定一手具体牌全程行动(线路自洽、可 showdown)
 * @property {boolean}  isHero    是否为训练/复盘的主角
 * @property {boolean}  [isBot]   是否为按范围表行动的机器人
 */

/**
 * 一手牌的开局设置 —— Hand 三要素之一,静态不变。
 * @typedef {Object} HandSetup
 * @property {Player[]} players         9 人桌全体(multiway 手在翻后收敛两人前不进入 GTO 训练)
 * @property {Blinds}   blinds
 * @property {Position} buttonPosition  按钮位
 * @property {string}   heroId          主角 player id
 * @property {number}   [effectiveStack] 有效筹码(可由 players.stack 推出,冗余时以此为准)
 */

// ═══════════════════════════ 事实源:Hand ═══════════════════════════

/**
 * 一个领域动作(actionLog 元素)。这是训练「写」与复盘「读」的最小事实单元。
 * amount 语义:
 *   - bet / raise:该动作**加注到**的总下注额(to,不是增量),便于回放
 *   - call:跟注补齐额可由派生态算出;amount 冗余记录实付
 *   - fold / check / allin:amount 省略或为 allin 的总额
 * @typedef {Object} DomainAction
 * @property {ActionType} type
 * @property {string}     playerId  执行动作的玩家
 * @property {Street}     street    动作所在街(冗余,便于校验;真值由 reduce 决定)
 * @property {number}     [amount]  见上方语义说明
 */

/**
 * 一手牌 = 唯一被持久化的事实源。GameState 恒为其 reduce 结果,不另存派生态。
 * @typedef {Object} Hand
 * @property {HandSetup}      setup      开局设置(静态)
 * @property {DomainAction[]} actionLog  按时间顺序的动作序列(训练追加 / 复盘预填)
 * @property {Card[]}         boardLog   已发公共牌,顺序 flop×3, turn, river;长度 0~5
 */

// ═══════════════════════════ 派生态:GameState / DecisionNode ═══════════════════════════

/**
 * 每玩家在当前 GameState 下的派生态。
 * @typedef {Object} PlayerState
 * @property {string}  id
 * @property {number}  stack          剩余筹码
 * @property {number}  committed      本手已投入底池总额
 * @property {number}  streetCommitted 本街已投入(用于计算跟注/最小加注)
 * @property {boolean} folded
 * @property {boolean} allin
 */

/**
 * GameState = reduce(setup, actionLog[..cursor], boardLog)。纯派生,可记忆化。
 * @typedef {Object} GameState
 * @property {Street}        street         当前街(由已消费的动作/发牌推断)
 * @property {Card[]}        board          当前可见公共牌(boardLog 的当前前缀)
 * @property {number}        pot            当前底池
 * @property {number}        currentBet     本街当前最高下注额(0 表示可 check)
 * @property {(string|null)} toActId        轮到谁行动;null = 该街行动结束/摊牌
 * @property {PlayerState[]} players        各玩家派生态
 * @property {string[]}      activePlayers  仍在手中(未 fold)的玩家 id
 * @property {number}        cursor         已 reduce 到的 actionLog 下标(训练=末尾,复盘可任意)
 * @property {boolean}       isHeadsUp      翻后是否已收敛为两人(仅两人时才进入翻后 GTO 训练)
 */

/**
 * 一个合法动作(LegalAction)。UI 据此渲染动作栏,evaluator 据此对齐 GTO 动作。
 * @typedef {Object} LegalAction
 * @property {ActionType} type
 * @property {number}     [min]    可变额动作的下限(如最小加注 to)
 * @property {number}     [max]    上限(如全下额)
 * @property {number}     [amount] 定额动作的额度(如跟注需补齐额)
 */

/**
 * DecisionNode = deriveDecisionNode(GameState)。训练与复盘产出的结构**完全一致**。
 * GtoPolicy.query(node) 只认这一个入参;翻前/翻后差异由 policy 内部消化。
 * @typedef {Object} DecisionNode
 * @property {string}        playerId      轮到行动的玩家
 * @property {boolean}       isHero        是否 hero 决策点(决定是否给反馈)
 * @property {Street}        street        供 GtoPolicy 分派:preflop->查表,其余->引擎会话
 * @property {LegalAction[]} legalActions  合法动作集
 * @property {GameState}     state         该决策点的 GameState 快照(含 cursor)
 * @property {NodePath}      [path]        翻后:自该街 root 到本节点的引擎导航路径(动作下标序列)
 * @property {RangeAssignment} [ranges]    翻后求解所需的双方范围(翻前表续牌范围喂入,UI 可见可覆盖)
 */

/**
 * 翻后引擎导航路径:自该街 root 起的动作下标序列,对应 apply_history(&[usize])。
 * 也是求解缓存身份的一部分(见 ARCHITECTURE.md 内容可寻址复用)。
 * @typedef {number[]} NodePath
 */

// ═══════════════════════════ 范围与策略输出 ═══════════════════════════

/**
 * 范围指派 —— 翻后求解的入参来源。由翻前 PreflopChartPolicy 的续牌范围填充,
 * 必须显式挂在 GameState / DecisionNode 上,UI 可见、用户可覆盖(注入的标准范围假设)。
 * @typedef {Object} RangeAssignment
 * @property {string} oopRange  OOP 方范围字符串(引擎 Range 语法,如 "88-22,AJs-A8s,...")
 * @property {string} ipRange   IP 方范围字符串
 * @property {string} source    来源标注,如 "preflop-chart:100bb-HU" / "showdown" / "manual"
 */

/**
 * 单个动作的 GTO 策略条目(NodeStrategy.actions 元素)。
 * @typedef {Object} ActionStrategy
 * @property {string}     label      动作标签,如 "Check" / "Bet(28)" / "AllIn(100)"
 * @property {ActionType} type
 * @property {number}     [amount]   下注/加注总额
 * @property {number}     frequency  GTO 选此动作的整体频率 0~1(overall_freq)
 * @property {number}     ev         此动作对当前行动方的期望值(引擎 expected_values)
 * @property {boolean}    inSupport  是否在 GTO 支撑集内(freq > 阈值),避免误伤合法混合打法
 */

/**
 * GtoPolicy.query(node) 的统一返回。翻前查表与翻后会话产出同一形状。
 * DeviationEvaluator 只消费这一结构,不关心它来自表还是引擎。
 * @typedef {Object} NodeStrategy
 * @property {Street}           street
 * @property {ActionStrategy[]} actions   各合法动作的频率/EV(与 DecisionNode.legalActions 对齐)
 * @property {string}           source    'preflop-chart' | 'postflop-solver'
 * @property {boolean}          approximate 是否为近似/降级来源(翻前表 / 多人)=> UI 须标注非权威
 * @property {Object}           [raw]      底层原始数据(翻后为 NodeResult),按需透传给 UI
 */

// ═══════════════════════════ 会话 API 出参(solver-wasm) ═══════════════════════════

/**
 * open_spot 的入参 —— 描述一个待求解的两人翻后局面。
 * @typedef {Object} OpenSpotRequest
 * @property {string} oopRange
 * @property {string} ipRange
 * @property {string} flop            三张,如 "Qs7h2c"
 * @property {string} [turn]          空串表示未发
 * @property {string} [river]         空串表示未发
 * @property {number} startingPot     该街起始底池
 * @property {number} effectiveStack  有效筹码
 * @property {string} betSizes        下注尺度描述(引擎 BetSizeOptions 语法,如 "50%")
 * @property {number} [maxIter]       CFR 迭代上限
 * @property {number} [targetExpl]    目标可利用度,单位 % of pot
 */

/**
 * query_node 沿 path 导航到某节点后的完整读数(纯读取,微秒~低毫秒)。旧 solve_spot 的
 * root 返回是其子集(SolveResult 仍用 snake_case,见 lib.rs,不走此 typedef)。
 * strategy 布局:strategy[a * numHands + h] = 手牌 h 选动作 a 的概率(a、h 均针对当前行动方)。
 * chance/terminal 节点无当前行动方:player=-1、策略/EV 相关数组为空,仅上下文字段有效。
 * @typedef {Object} NodeResult
 * @property {number}   player        行动方:0=OOP / 1=IP;-1 表示 chance/terminal
 * @property {boolean}  isTerminal    是否终局节点
 * @property {boolean}  isChance      是否发牌(turn/river)节点
 * @property {number}   numHands
 * @property {number}   numActions
 * @property {string[]} actions       动作标签,长度 numActions(terminal 空;chance 为可发牌)
 * @property {string[]} hands         手牌标签,长度 numHands
 * @property {number[]} strategy      长度 numActions * numHands
 * @property {number[]} equity        长度 numHands
 * @property {number[]} ev            长度 numHands(当前行动方按策略混合后的每手 EV)
 * @property {number[]} actionEv      长度 numActions,按权重加权的每个动作范围 EV(评估 EV 损失用)
 * @property {number[]} weights       长度 numHands(归一化权重)
 * @property {number[]} overallFreq   长度 numActions,按权重加权的整体动作频率
 * @property {string[]} board         当前公共牌(3~5 张)
 * @property {number}   pot           当前底池 = startingPot + 双方总投入
 * @property {number[]} totalBetAmount [OOP, IP] 各自总投入
 */

export {}
