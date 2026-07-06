use wasm_bindgen::prelude::*;
use postflop_solver::*;
use serde::Serialize;

/// 求解结果,序列化成 JSON 返回给前端。
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

fn err(msg: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&msg.to_string())
}

/// 模块加载时装 panic hook,让 Rust panic 文案进浏览器 console
/// (否则 panic 在浏览器只是无信息的 RuntimeError)。
#[wasm_bindgen(start)]
pub fn on_start() {
    console_error_panic_hook::set_once();
}

/// 求解一个翻后局面,返回 root(先行动方 OOP)的 GTO 策略(JSON 字符串)。
/// turn / river 传空串 "" 表示该街未发。
/// target_exploitability 单位是 % of pot(如 0.5 表示底池的 0.5%)。
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
    // ---- 解析范围 ----
    let oop: Range = oop_range.parse().map_err(|e| err(format!("OOP 范围解析失败: {}", e)))?;
    let ip: Range = ip_range.parse().map_err(|e| err(format!("IP 范围解析失败: {}", e)))?;

    // ---- 解析牌面 ----
    let flop_cards = flop_from_str(flop).map_err(|e| err(format!("flop 解析失败: {}", e)))?;
    let turn_card = if turn.is_empty() {
        NOT_DEALT
    } else {
        card_from_str(turn).map_err(|e| err(format!("turn 解析失败: {}", e)))?
    };
    let river_card = if river.is_empty() {
        NOT_DEALT
    } else {
        card_from_str(river).map_err(|e| err(format!("river 解析失败: {}", e)))?
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
    let bet = BetSizeOptions::try_from((bet_size, ""))
        .map_err(|e| err(format!("bet size 解析失败: {}", e)))?;

    let tree_config = TreeConfig {
        initial_state,
        starting_pot,
        effective_stack,
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
    let target = starting_pot as f32 * target_exploitability / 100.0;
    let exploitability = solve(&mut game, max_iter, target, false);
    game.cache_normalized_weights();

    // ---- 读取 root 结果 ----
    let actions: Vec<String> = game
        .available_actions()
        .iter()
        .map(|a| format!("{:?}", a))
        .collect();
    let hands = holes_to_strings(game.private_cards(0))
        .map_err(|e| err(format!("手牌转换失败: {}", e)))?;
    let strategy = game.strategy();
    let equity = game.equity(0);
    let ev = game.expected_values(0);
    let weights: Vec<f32> = game.normalized_weights(0).to_vec();
    let num_hands = hands.len();
    let num_actions = actions.len();

    // 整体动作频率(按手牌权重加权)
    let total: f32 = weights.iter().sum();
    let mut overall_freq = vec![0.0f32; num_actions];
    if total > 0.0 {
        for a in 0..num_actions {
            let mut s = 0.0f32;
            for h in 0..num_hands {
                s += strategy[a * num_hands + h] * weights[h];
            }
            overall_freq[a] = s / total;
        }
    }

    let result = SolveResult {
        exploitability,
        memory_bytes: mem_uncompressed as f64,
        num_hands,
        num_actions,
        actions,
        hands,
        strategy,
        equity,
        ev,
        weights,
        overall_freq,
    };

    serde_json::to_string(&result).map_err(|e| err(format!("结果序列化失败: {}", e)))
}
