use postflop_solver::*;

fn main() {
    // ===== 1. 配置一个 turn 局面(与 basic 相同)=====
    let oop_range = "66+,A8s+,A5s-A4s,AJo+,K9s+,KQo,QTs+,JTs,96s+,85s+,75s+,65s,54s";
    let ip_range = "QQ-22,AQs-A2s,ATo+,K5s+,KJo+,Q8s+,J8s+,T7s+,96s+,86s+,75s+,64s+,53s+";

    let card_config = CardConfig {
        range: [oop_range.parse().unwrap(), ip_range.parse().unwrap()],
        flop: flop_from_str("Td9d6h").unwrap(),
        turn: card_from_str("Qc").unwrap(),
        river: NOT_DEALT,
    };

    let bet_sizes = BetSizeOptions::try_from(("60%, e, a", "2.5x")).unwrap();
    let tree_config = TreeConfig {
        initial_state: BoardState::Turn,
        starting_pot: 200,
        effective_stack: 900,
        rake_rate: 0.0,
        rake_cap: 0.0,
        flop_bet_sizes: [bet_sizes.clone(), bet_sizes.clone()],
        turn_bet_sizes: [bet_sizes.clone(), bet_sizes.clone()],
        river_bet_sizes: [bet_sizes.clone(), bet_sizes],
        turn_donk_sizes: None,
        river_donk_sizes: Some(DonkSizeOptions::try_from("50%").unwrap()),
        add_allin_threshold: 1.5,
        force_allin_threshold: 0.15,
        merging_threshold: 0.1,
    };

    let action_tree = ActionTree::new(tree_config).unwrap();
    let mut game = PostFlopGame::with_config(card_config, action_tree).unwrap();
    game.allocate_memory(false);

    // ===== 2. 求解(第 4 个参数 false = 不打印每次迭代)=====
    let target = game.tree_config().starting_pot as f32 * 0.005;
    let exploitability = solve(&mut game, 1000, target, false);
    game.cache_normalized_weights();

    println!();
    println!("========== 局面 ==========");
    println!("牌面 : T♦ 9♦ 6♥  |  Q♣ (turn)");
    println!(
        "底池 : {}   有效筹码 : {}",
        game.tree_config().starting_pot,
        game.tree_config().effective_stack
    );
    println!("求解精度 exploitability : {:.3}", exploitability);
    println!();

    // ===== 3. 根节点 = 轮到 OOP 行动 =====
    let actions = game.available_actions();
    let cards = game.private_cards(0);
    let hand_strs = holes_to_strings(cards).unwrap();
    let strategy = game.strategy(); // 布局: strategy[action * num_hands + hand]
    let weights = game.normalized_weights(0);
    let equity = game.equity(0);
    let num_hands = hand_strs.len();
    let num_actions = actions.len();

    println!("轮到 OOP 行动,可选动作 : {:?}", actions);
    println!();

    // ---- 3a. 整体动作频率(按手牌权重加权)----
    let total: f32 = weights.iter().sum();
    println!("===== OOP 全范围整体策略 =====");
    for a in 0..num_actions {
        let freq: f32 = (0..num_hands)
            .map(|h| strategy[a * num_hands + h] * weights[h])
            .sum::<f32>()
            / total;
        println!("  {:<11} : {:5.1}%", format!("{:?}", actions[a]), 100.0 * freq);
    }
    println!();

    // ---- 3b. 按胜率排序,看强牌 vs 弱牌各自怎么打 ----
    let mut idx: Vec<usize> = (0..num_hands).filter(|&h| weights[h] > 0.001).collect();
    idx.sort_by(|&a, &b| equity[b].partial_cmp(&equity[a]).unwrap());

    println!("===== 最强的 10 手牌(按胜率)=====");
    print!("  {:<7}{:>8}", "Hand", "Equity");
    for a in 0..num_actions {
        print!("{:>13}", format!("{:?}", actions[a]));
    }
    println!();
    for &h in idx.iter().take(10) {
        print!("  {:<7}{:>7.1}%", hand_strs[h], 100.0 * equity[h]);
        for a in 0..num_actions {
            print!("{:>12.1}%", 100.0 * strategy[a * num_hands + h]);
        }
        println!();
    }
    println!();

    println!("===== 最弱的 8 手牌(按胜率)=====");
    print!("  {:<7}{:>8}", "Hand", "Equity");
    for a in 0..num_actions {
        print!("{:>13}", format!("{:?}", actions[a]));
    }
    println!();
    for &h in idx.iter().rev().take(8) {
        print!("  {:<7}{:>7.1}%", hand_strs[h], 100.0 * equity[h]);
        for a in 0..num_actions {
            print!("{:>12.1}%", 100.0 * strategy[a * num_hands + h]);
        }
        println!();
    }
    println!();
    println!("(每个动作下的百分比 = solver 建议使用该动作的频率;同一手牌可混合多个动作)");
}
