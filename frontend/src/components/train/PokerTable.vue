<script setup>
import { computed } from 'vue'
import Card from '../Card.vue'

// 军绿牌桌:渲染 TrainingSession.getViewState()。9 座位绕椭圆,hero 固定底部中央。
const props = defineProps({
  view: { type: Object, default: null },
})

// 物理顺时针座位环(与 domain/positions.js 的 CLOCKWISE 对齐):SB 紧跟按钮,BTN 最后行动。
const RING = ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN']

// 9 个椭圆槽位(容器百分比坐标),槽 0 = 底部中央(hero),顺时针一圈。
const SLOTS = [
  { left: 50, top: 90 }, // 0 底部中央 = hero
  { left: 19, top: 84 }, // 1
  { left: 5, top: 57 }, // 2
  { left: 11, top: 27 }, // 3
  { left: 33, top: 11 }, // 4
  { left: 67, top: 11 }, // 5
  { left: 89, top: 27 }, // 6
  { left: 95, top: 57 }, // 7
  { left: 81, top: 84 }, // 8
]

const heroPos = computed(() => {
  const h = (props.view?.players ?? []).find((p) => p.isHero)
  return h?.position ?? 'BTN'
})

// 把每个座位映射到一个椭圆槽位:以 hero 为底部锚点旋转。
const seats = computed(() => {
  const players = props.view?.players ?? []
  const hi = RING.indexOf(heroPos.value)
  return players.map((p) => {
    const ri = RING.indexOf(p.position)
    const slot = ri < 0 ? 0 : (ri - hi + RING.length) % RING.length
    return { ...p, slot, pos: SLOTS[slot] ?? SLOTS[0] }
  })
})

const board = computed(() => {
  const b = props.view?.board ?? []
  const slots = []
  for (let i = 0; i < 5; i++) slots.push(b[i] || '')
  return slots
})

const isActor = (p) => props.view?.toActId != null && p.id === props.view.toActId
</script>

<template>
  <div class="table-wrap">
    <div class="felt-oval">
      <!-- 中央:公共牌 + 底池 -->
      <div class="center">
        <div class="board-cards">
          <Card
            v-for="(c, i) in board"
            :key="i"
            :card="c"
            :placeholder="!c"
            size="sm"
            :class="{ street: i >= 3 }"
          />
        </div>
        <div class="pot-chip">
          <span class="pot-lbl">POT</span>
          <span class="pot-val">{{ view?.pot ?? 0 }}</span>
        </div>
      </div>

      <!-- 座位 -->
      <div
        v-for="p in seats"
        :key="p.id"
        class="seat"
        :class="{ hero: p.isHero, folded: p.folded, actor: isActor(p) }"
        :style="{ left: p.pos.left + '%', top: p.pos.top + '%' }"
      >
        <div class="seat-cards">
          <template v-if="p.holeCards">
            <Card :card="p.holeCards[0]" size="sm" />
            <Card :card="p.holeCards[1]" size="sm" />
          </template>
          <template v-else-if="!p.folded">
            <span class="cardback" /><span class="cardback" />
          </template>
        </div>
        <div class="seat-info">
          <span class="seat-pos">
            {{ p.position }}
            <span v-if="p.isHero" class="tag hero-tag">你</span>
            <span v-if="p.allin" class="tag allin-tag">ALLIN</span>
            <span v-if="p.folded" class="tag fold-tag">弃</span>
          </span>
          <span class="seat-stack">{{ p.stack }}</span>
        </div>
        <div v-if="p.streetCommitted > 0" class="seat-bet">{{ p.streetCommitted }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.table-wrap {
  display: flex;
  justify-content: center;
  padding: 8px 0 4px;
}
.felt-oval {
  position: relative;
  width: 100%;
  max-width: 760px;
  aspect-ratio: 16 / 10;
  border-radius: 46% / 46%;
  border: 10px solid #2b1d12;
  background:
    radial-gradient(ellipse 78% 120% at 50% 42%, rgba(89, 133, 98, 0.55) 0%, rgba(31, 56, 39, 0.4) 58%, rgba(20, 42, 29, 0.85) 100%),
    #1d3626;
  box-shadow:
    inset 0 0 0 2px rgba(231, 198, 103, 0.28),
    inset 0 0 60px rgba(0, 0, 0, 0.45),
    0 16px 40px rgba(0, 0, 0, 0.4);
}
.felt-oval::before {
  content: '';
  position: absolute;
  inset: 22px;
  border-radius: 46% / 46%;
  border: 2px dashed rgba(231, 198, 103, 0.16);
  pointer-events: none;
}

/* 中央公共牌 + 底池 */
.center {
  position: absolute;
  left: 50%;
  top: 42%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: min(70%, 420px);
}
.board-cards {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
}
.board-cards .street { margin-left: 6px; }
.pot-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  padding: 4px 14px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.42);
  border: 1px solid rgba(231, 198, 103, 0.35);
  color: var(--ink, #ecf4ee);
}
.pot-lbl { font-size: 10px; letter-spacing: 1.5px; color: var(--gold, #e7c667); }
.pot-val { font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; }

/* 座位 */
.seat {
  position: absolute;
  transform: translate(-50%, -50%);
  width: clamp(74px, 15vw, 104px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  transition: filter 0.18s;
}
.seat.folded { filter: grayscale(1) opacity(0.42); }
.seat-cards {
  display: flex;
  gap: 3px;
  min-height: 8px;
}
.seat-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 4px 8px;
  min-width: 60px;
  border-radius: 9px;
  background: rgba(8, 24, 15, 0.82);
  border: 1px solid var(--line, rgba(255, 255, 255, 0.1));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
.seat.hero .seat-info {
  border-color: var(--gold, #e7c667);
  background: rgba(20, 42, 30, 0.92);
}
.seat.actor .seat-info {
  border-color: #f9d976;
  box-shadow: 0 0 0 2px rgba(249, 217, 118, 0.55), 0 0 16px rgba(249, 217, 118, 0.4);
}
.seat-pos {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.4px;
  color: var(--ink, #ecf4ee);
}
.seat-stack {
  font-size: 13px;
  font-weight: 800;
  color: var(--gold, #e7c667);
  font-variant-numeric: tabular-nums;
}
.tag {
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.3px;
  padding: 1px 4px;
  border-radius: 4px;
  line-height: 1.3;
}
.hero-tag { background: var(--gold, #e7c667); color: #22331f; }
.allin-tag { background: #8b1a12; color: #ffd9d3; }
.fold-tag { background: rgba(255, 255, 255, 0.14); color: var(--ink-dim, #a9c2b1); }

.seat-bet {
  position: absolute;
  bottom: -18px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(231, 198, 103, 0.4);
  color: #ffe9a8;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* 面朝下的对手牌 */
.cardback {
  width: clamp(20px, 5vw, 28px);
  aspect-ratio: 5 / 7;
  border-radius: 4px;
  background:
    repeating-linear-gradient(45deg, rgba(231, 198, 103, 0.18) 0 4px, rgba(20, 42, 30, 0.9) 4px 8px),
    #143024;
  border: 1px solid rgba(231, 198, 103, 0.32);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.45);
}

@media (max-width: 560px) {
  .felt-oval { aspect-ratio: 3 / 4; }
  .seat { width: clamp(60px, 22vw, 88px); }
}
</style>
