use wasm_bindgen::prelude::*;
use postflop_solver::*;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

/// 旧 `solve_spot` 的返回形状(SolverView 依赖,保持字段与命名**完全不变**)。
/// strategy 布局: strategy[action_index * num_hands + hand_index] = 该手牌选该动作的概率。
#[derive(Serialize)]
struct SolveResult {
    exploitability: f32,
    memory_bytes: f64,
    num_hands: usize,
    num_actions: usize,
    actions: Vec<String>,   // 如 ["Check", "Bet(28)", "AllIn(100)"]
    hands: Vec<String>,     // 如 ["AsAh", "AsKs", ...],长度 num_hands
    strategy: Vec<f32>,     // 长度 num_actions * num_hands
    equity: Vec<f32>,       // 长度 num_hands
    ev: Vec<f32>,           // 长度 num_hands
    weights: Vec<f32>,      // 长度 num_hands(归一化权重)
    overall_freq: Vec<f32>, // 长度 num_actions,全范围按权重加权的整体动作频率
}

/// `open_spot` 的入参 —— 描述一个待求解的两人翻后局面。
/// 与 `frontend/src/domain/types.js` 的 `OpenSpotRequest`(camelCase)对齐,经 JSON 传入。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenSpotRequest {
    oop_range: String,
    ip_range: String,
    flop: String,
    #[serde(default)]
    turn: String, // 空串表示未发
    #[serde(default)]
    river: String, // 空串表示未发
    starting_pot: i32,
    effective_stack: i32,
    bet_sizes: String, // 引擎 BetSizeOptions 语法,如 "50%"
    #[serde(default = "default_max_iter")]
    max_iter: u32,
    #[serde(default = "default_target_expl")]
    target_expl: f32, // 目标可利用度,单位 % of pot
}

fn default_max_iter() -> u32 {
    1000
}
fn default_target_expl() -> f32 {
    0.5
}

/// `query_node` 的返回 —— 某个节点的完整读数(camelCase,见 types.js 的 `NodeResult`)。
/// 是一次 solve 之后对任意节点的**纯读取**结果;action 节点含策略/EV,chance/terminal 只含上下文。
/// strategy 布局:strategy[a * numHands + h] = 手牌 h 选动作 a 的概率(a、h 均针对当前行动方)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeResult {
    player: i32,    // 0=OOP / 1=IP;-1 表示 chance/terminal(无当前行动方)
    is_terminal: bool,
    is_chance: bool,
    num_hands: usize,
    num_actions: usize,
    actions: Vec<String>,   // 动作标签,长度 numActions(terminal 为空,chance 为可发牌)
    hands: Vec<String>,     // 当前行动方手牌,长度 numHands
    strategy: Vec<f32>,     // 长度 numActions * numHands
    equity: Vec<f32>,       // 长度 numHands
    ev: Vec<f32>,           // 长度 numHands(当前行动方按策略混合后的每手 EV)
    action_ev: Vec<f32>,    // 长度 numActions,按权重加权的每个动作的范围 EV(供偏差评估算 EV 损失)
    weights: Vec<f32>,      // 长度 numHands(归一化权重)
    overall_freq: Vec<f32>, // 长度 numActions,按权重加权的整体动作频率
    board: Vec<String>,     // 当前公共牌(3~5 张)
    pot: i32,               // 当前底池 = startingPot + 双方总投入
    total_bet_amount: [i32; 2], // [OOP, IP] 各自的总投入
}

/// 一次会话:一个已 solve 的 game + 元数据,常驻 Worker 跨节点复用。
struct Session {
    game: PostFlopGame,
    exploitability: f32,
    memory_bytes: f64,
}

thread_local! {
    /// 会话表:句柄(u32)= 下标;None 为已释放的空槽,可被复用。
    /// wasm 单线程,thread_local + RefCell 即可,无需锁。
    static SESSIONS: RefCell<Vec<Option<Session>>> = RefCell::new(Vec::new());
}

fn err(msg: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

/// 模块加载时装 panic hook,让 Rust panic 文案进浏览器 console
/// (否则 panic 在浏览器只是无信息的 RuntimeError)。
#[wasm_bindgen(start)]
pub fn on_start() {
    console_error_panic_hook::set_once();
}

/// 建局 + 内存护栏 + CFR 求解一次(唯一的「重活」),返回一个已 solve 的会话。
/// 供 `open_spot` 与旧 `solve_spot` 薄包装共用,保证两条路径的求解逻辑单一事实源。
fn build_and_solve(req: &OpenSpotRequest) -> Result<Session, JsValue> {
    // ---- 解析范围 ----
    let oop: Range = req
        .oop_range
        .parse()
        .map_err(|e| err(format!("OOP 范围解析失败: {}", e)))?;
    let ip: Range = req
        .ip_range
        .parse()
        .map_err(|e| err(format!("IP 范围解析失败: {}", e)))?;

    // ---- 解析牌面 ----
    let flop_cards = flop_from_str(&req.flop).map_err(|e| err(format!("flop 解析失败: {}", e)))?;
    let turn_card = if req.turn.is_empty() {
        NOT_DEALT
    } else {
        card_from_str(&req.turn).map_err(|e| err(format!("turn 解析失败: {}", e)))?
    };
    let river_card = if req.river.is_empty() {
        NOT_DEALT
    } else {
        card_from_str(&req.river).map_err(|e| err(format!("river 解析失败: {}", e)))?
    };

    let card_config = CardConfig {
        range: [oop, ip],
        flop: flop_cards,
        turn: turn_card,
        river: river_card,
    };

    // 由牌面推断求解起始街
    let initial_state = if river_card != NOT_DEALT {
        BoardState::River
    } else if turn_card != NOT_DEALT {
        BoardState::Turn
    } else {
        BoardState::Flop
    };

    // MVP: 单一下注尺度,无 raise(动作树最小)
    let bet = BetSizeOptions::try_from((req.bet_sizes.as_str(), ""))
        .map_err(|e| err(format!("bet size 解析失败: {}", e)))?;

    let tree_config = TreeConfig {
        initial_state,
        starting_pot: req.starting_pot,
        effective_stack: req.effective_stack,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [bet.clone(), bet.clone()],
        turn_bet_sizes: [bet.clone(), bet.clone()],
        river_bet_sizes: [bet.clone(), bet.clone()],
        turn_donk_sizes: None,
        river_donk_sizes: None,
        add_allin_threshold: 1.5,
        force_allin_threshold: 0.15,
        merging_threshold: 0.1,
    };

    let action_tree =
        ActionTree::new(tree_config).map_err(|e| err(format!("构建动作树失败: {}", e)))?;
    let mut game = PostFlopGame::with_config(card_config, action_tree)
        .map_err(|e| err(format!("构建 game 失败: {}", e)))?;

    // 内存护栏: 超上限直接报错,防用户输入大局面把浏览器 OOM
    let (mem_uncompressed, _mem_compressed) = game.memory_usage();
    const MEM_LIMIT: f64 = 800.0 * 1024.0 * 1024.0;
    if mem_uncompressed as f64 > MEM_LIMIT {
        return Err(err(format!(
            "内存预估 {}MB 超上限, 请收窄范围 / 降低有效筹码(SPR) / 减小下注尺度",
            (mem_uncompressed / 1_048_576) as u64
        )));
    }
    game.allocate_memory(false);

    // ---- 求解(target 语义: % of pot) ----
    let target = req.starting_pot as f32 * req.target_expl / 100.0;
    let exploitability = solve(&mut game, req.max_iter, target, false);

    Ok(Session {
        game,
        exploitability,
        memory_bytes: mem_uncompressed as f64,
    })
}

/// 读取 game **当前节点**的完整读数(不做导航,导航由调用方 apply_history 完成)。
/// 会先 `cache_normalized_weights`(对任意节点安全);action 节点读策略/EV,
/// chance/terminal 节点仅返回上下文(player=-1)。solve_spot 与 query_node 共用。
fn read_current_node(game: &mut PostFlopGame) -> Result<NodeResult, JsValue> {
    let is_terminal = game.is_terminal_node();
    let is_chance = game.is_chance_node();

    // ---- 节点上下文(任意节点都有效)----
    let board: Vec<String> = game
        .current_board()
        .iter()
        .map(|&c| card_to_string(c).unwrap_or_else(|_| "??".to_string()))
        .collect();
    let total_bet_amount = game.total_bet_amount();
    let starting_pot = game.tree_config().starting_pot;
    let pot = starting_pot + total_bet_amount[0] + total_bet_amount[1];

    // 可发牌 / 可选动作(terminal 为空;chance 为代表性发牌;action 为合法动作)
    let actions: Vec<String> = game
        .available_actions()
        .iter()
        .map(|a| format!("{:?}", a))
        .collect();

    // 归一化权重对任何节点都可安全缓存(供 equity/ev 使用)
    game.cache_normalized_weights();

    // chance / terminal 节点没有「当前行动方」的决策,只返回上下文
    if is_terminal || is_chance {
        return Ok(NodeResult {
            player: -1,
            is_terminal,
            is_chance,
            num_hands: 0,
            num_actions: actions.len(),
            actions,
            hands: Vec::new(),
            strategy: Vec::new(),
            equity: Vec::new(),
            ev: Vec::new(),
            action_ev: Vec::new(),
            weights: Vec::new(),
            overall_freq: Vec::new(),
            board,
            pot,
            total_bet_amount,
        });
    }

    // ---- action 节点:读当前行动方的策略/EV/权益 ----
    let player = game.current_player();
    let hands = holes_to_strings(game.private_cards(player))
        .map_err(|e| err(format!("手牌转换失败: {}", e)))?;
    let strategy = game.strategy();
    let equity = game.equity(player);
    let ev = game.expected_values(player);
    // 每 (动作, 手牌) 的 EV,布局同 strategy: detail[a * num_hands + h]
    let ev_detail = game.expected_values_detail(player);
    let weights: Vec<f32> = game.normalized_weights(player).to_vec();
    let num_hands = hands.len();
    let num_actions = actions.len();

    // 按手牌权重加权:整体动作频率 + 每个动作的范围 EV
    let total: f32 = weights.iter().sum();
    let mut overall_freq = vec![0.0f32; num_actions];
    let mut action_ev = vec![0.0f32; num_actions];
    if total > 0.0 {
        for a in 0..num_actions {
            let mut freq_sum = 0.0f32;
            let mut ev_sum = 0.0f32;
            for h in 0..num_hands {
                let w = weights[h];
                freq_sum += strategy[a * num_hands + h] * w;
                ev_sum += ev_detail[a * num_hands + h] * w;
            }
            overall_freq[a] = freq_sum / total;
            action_ev[a] = ev_sum / total;
        }
    }

    Ok(NodeResult {
        player: player as i32,
        is_terminal: false,
        is_chance: false,
        num_hands,
        num_actions,
        actions,
        hands,
        strategy,
        equity,
        ev,
        action_ev,
        weights,
        overall_freq,
        board,
        pot,
        total_bet_amount,
    })
}

/// 会话 API ①:建局 + 求解一次,把 solved game 留在 Worker,返回句柄(u32)。
/// 入参为 `OpenSpotRequest` 的 JSON 字符串(camelCase)。这是唯一的「重活」。
#[wasm_bindgen]
pub fn open_spot(req_json: &str) -> Result<u32, JsValue> {
    let req: OpenSpotRequest =
        serde_json::from_str(req_json).map_err(|e| err(format!("open_spot 入参解析失败: {}", e)))?;
    let session = build_and_solve(&req)?;
    let handle = SESSIONS.with(|s| {
        let mut v = s.borrow_mut();
        // 复用空槽,避免句柄无限增长
        if let Some(i) = v.iter().position(|slot| slot.is_none()) {
            v[i] = Some(session);
            i as u32
        } else {
            v.push(Some(session));
            (v.len() - 1) as u32
        }
    });
    Ok(handle)
}

/// 会话 API ②:从该街 root 沿 path(动作下标序列)导航到目标节点,读取该节点读数。
/// 纯读取,微秒~低毫秒级,可反复调用。path 语义同引擎 `apply_history`:
/// action 节点步为动作下标;chance 节点步为牌 ID(0xFFFFFFFF 表示自动取最小可发牌)。
/// 返回 `NodeResult` 的 JSON 字符串。
#[wasm_bindgen]
pub fn query_node(handle: u32, path: &[u32]) -> Result<String, JsValue> {
    SESSIONS.with(|s| -> Result<String, JsValue> {
        let mut v = s.borrow_mut();
        let session = v
            .get_mut(handle as usize)
            .and_then(|slot| slot.as_mut())
            .ok_or_else(|| err(format!("无效或已释放的句柄: {}", handle)))?;
        // usize::MAX(自动发牌哨兵)在 wasm32 上等于 u32::MAX,直接透传
        let history: Vec<usize> = path.iter().map(|&x| x as usize).collect();
        session.game.apply_history(&history);
        let result = read_current_node(&mut session.game)?;
        serde_json::to_string(&result).map_err(|e| err(format!("结果序列化失败: {}", e)))
    })
}

/// 会话 API ③:释放句柄对应的常驻 game,回收内存(会话生命周期结束时调用)。
#[wasm_bindgen]
pub fn close_spot(handle: u32) {
    SESSIONS.with(|s| {
        let mut v = s.borrow_mut();
        if let Some(slot) = v.get_mut(handle as usize) {
            *slot = None;
        }
    });
}

/// 旧接口:求解一个翻后局面,返回 root(先行动方 OOP)的 GTO 策略(JSON 字符串)。
/// turn / river 传空串 "" 表示该街未发。target_exploitability 单位是 % of pot。
///
/// 现降为 `open_spot + query_node(root) + close_spot` 的薄包装:签名与返回形状
/// (`SolveResult`)完全不变,SolverView 零改动。
#[wasm_bindgen]
pub fn solve_spot(
    oop_range: &str,
    ip_range: &str,
    flop: &str,
    turn: &str,
    river: &str,
    starting_pot: i32,
    effective_stack: i32,
    bet_size: &str,
    max_iter: u32,
    target_exploitability: f32,
) -> Result<String, JsValue> {
    let req = OpenSpotRequest {
        oop_range: oop_range.to_string(),
        ip_range: ip_range.to_string(),
        flop: flop.to_string(),
        turn: turn.to_string(),
        river: river.to_string(),
        starting_pot,
        effective_stack,
        bet_sizes: bet_size.to_string(),
        max_iter,
        target_expl: target_exploitability,
    };

    // open:建局 + 求解一次
    let mut session = build_and_solve(&req)?;
    // query(root):导航到该街 root(apply_history(&[]) 会 back_to_root)再读
    session.game.apply_history(&[]);
    let node = read_current_node(&mut session.game)?;
    // close:session 在函数结束时自动 drop,无需显式释放

    // 映射回旧 SolveResult 形状(保持字段与命名完全不变)
    let result = SolveResult {
        exploitability: session.exploitability,
        memory_bytes: session.memory_bytes,
        num_hands: node.num_hands,
        num_actions: node.num_actions,
        actions: node.actions,
        hands: node.hands,
        strategy: node.strategy,
        equity: node.equity,
        ev: node.ev,
        weights: node.weights,
        overall_freq: node.overall_freq,
    };

    serde_json::to_string(&result).map_err(|e| err(format!("结果序列化失败: {}", e)))
}
