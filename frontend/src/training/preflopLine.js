/**
 * 翻前动作线 / 续牌范围推导(供训练编排显式喂给策略层)。
 *
 * P0 集成说明建议「翻前 line 最好显式传 node.preflopLine」;PreflopChartPolicy 自带启发式兜底,
 * 但本模块基于 actionLog 的加注计数给出更确定的 line,并在收敛两人时推导双方 continuation
 * (position/line/action),交 PreflopChartPolicy.deriveRanges 拼成翻后 solve 的双方范围。
 *
 * 简化(MVP,已在 integrationNotes 登记):
 *   · 加注计数 = 翻前 raise/bet/allin 动作数;0=RFI/limp,1=面对开池,≥2=3bet+ 场景。
 *   · limp/check 池无对应范围数据 → 近似用开池范围(RFI[pos]),够跑通不精确。
 */

/** 翻前抬注动作计数(raise/bet/allin;盲注不入 actionLog,故不计)。 */
export function preflopRaiseCount(actionLog) {
  return actionLog.filter(
    (a) => a.street === 'preflop' && (a.type === 'raise' || a.type === 'bet' || a.type === 'allin'),
  ).length
}

/** 翻前最后一个抬注者的 playerId(当前最具攻击性的一方),无则 undefined。 */
export function lastPreflopAggressor(actionLog) {
  for (let i = actionLog.length - 1; i >= 0; i--) {
    const a = actionLog[i]
    if (a.street === 'preflop' && (a.type === 'raise' || a.type === 'bet' || a.type === 'allin')) {
      return a.playerId
    }
  }
  return undefined
}

/**
 * 某玩家当前决策点的翻前动作线('rfi'|'bbOption'|'vsRfi'|'vs3bet')。
 * actionLog 为「至此为止」的历史,故其加注数正是该玩家面对的加注轮数。
 * @param {import('../domain/types.js').DomainAction[]} actionLog
 * @param {string} position 行动方位置
 * @returns {'rfi'|'bbOption'|'vsRfi'|'vs3bet'}
 */
export function computePreflopLine(actionLog, position) {
  const raises = preflopRaiseCount(actionLog)
  if (raises === 0) return position === 'BB' ? 'bbOption' : 'rfi'
  if (raises === 1) return 'vsRfi'
  return 'vs3bet'
}

/**
 * 收敛两人时双方的 continuation(交 PreflopChartPolicy.deriveRanges)。
 * 攻击方(最后抬注者)与另一方按加注轮数映射到 line/action。
 * @param {import('../domain/types.js').HandSetup} setup
 * @param {import('../domain/types.js').DomainAction[]} actionLog
 * @param {string} oopId
 * @param {string} ipId
 * @returns {{oop:{position:string,line:string,action:string}, ip:{position:string,line:string,action:string}}}
 */
export function deriveContinuation(setup, actionLog, oopId, ipId) {
  const posOf = {}
  for (const p of setup.players) posOf[p.id] = p.position
  const raises = preflopRaiseCount(actionLog)
  const aggressorId = lastPreflopAggressor(actionLog)

  const forId = (id) => {
    const position = posOf[id]
    const isAgg = id === aggressorId
    if (raises >= 2) {
      return { position, line: isAgg ? 'vsRfi' : 'vs3bet', action: isAgg ? 'threebet' : 'call' }
    }
    if (raises === 1) {
      return { position, line: isAgg ? 'rfi' : 'vsRfi', action: isAgg ? 'open' : 'call' }
    }
    return { position, line: 'rfi', action: 'open' } // limp/check 池近似
  }

  return { oop: forId(oopId), ip: forId(ipId) }
}
