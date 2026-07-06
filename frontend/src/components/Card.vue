<script setup>
import { computed } from 'vue'

// 独立扑克牌组件：纯 CSS + Unicode 花色绘制，零外部图片/字体/网络资源（可离线）。
// 用法：
//   <Card card="Qs" />              传单张牌字符串（rank + suit）
//   <Card rank="Q" suit="s" />      或分别传 rank / suit
//   <Card :card="null" />           空/非法输入（或 placeholder）-> 渲染占位空位
// 尺寸：默认响应式 clamp；可用 size='sm|md|lg' 预设，或父级用 CSS 变量 --card-w 覆盖。
const props = defineProps({
  card: { type: String, default: '' },            // 如 'Qs' 'Th'（rank+suit）
  rank: { type: String, default: '' },            // 可选：单独传 rank
  suit: { type: String, default: '' },            // 可选：单独传 suit
  size: { type: String, default: '' },            // '' | sm | md | lg
  placeholder: { type: Boolean, default: false }, // 强制占位（未发的 turn/river）
})

// suit 元数据：符号 + 颜色（s=♠黑桃 h=♥红桃 d=♦方块 c=♣梅花；红桃/方块红，黑桃/梅花黑）
const SUITS = {
  s: { sym: '♠', color: 'black' },
  h: { sym: '♥', color: 'red' },
  d: { sym: '♦', color: 'red' },
  c: { sym: '♣', color: 'black' },
}
// rank 显示：T 显示为 10，其余原样
const RANK_LABEL = { T: '10' }

const parsed = computed(() => {
  if (props.placeholder) return null
  let r = props.rank
  let s = props.suit
  if (!r || !s) {
    const c = (props.card || '').trim()
    if (c.length >= 2) { r = c[0]; s = c[1] }
  }
  r = (r || '').toUpperCase()
  s = (s || '').toLowerCase()
  const meta = SUITS[s]
  if (!meta || !r) return null
  return { rank: RANK_LABEL[r] || r, sym: meta.sym, color: meta.color }
})
</script>

<template>
  <div
    class="card"
    :class="[parsed ? parsed.color : 'empty', size ? 'size-' + size : '']"
  >
    <template v-if="parsed">
      <span class="corner tl">
        <span class="r">{{ parsed.rank }}</span>
        <span class="s">{{ parsed.sym }}</span>
      </span>
      <span class="pip">{{ parsed.sym }}</span>
      <span class="corner br">
        <span class="r">{{ parsed.rank }}</span>
        <span class="s">{{ parsed.sym }}</span>
      </span>
    </template>
    <span v-else class="ghost" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.card {
  position: relative;
  flex: 0 0 auto;
  /* 尺寸：父级可用 --card-w 覆盖；否则响应式默认 */
  width: var(--card-w, clamp(42px, 11.5vw, 60px));
  aspect-ratio: 5 / 7;
  border-radius: clamp(6px, 1.5vw, 9px);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: Georgia, 'Times New Roman', serif;
  line-height: 1;
  user-select: none;
  /* 精致白牌：柔和渐变 + 分层投影 + 极细内描边 */
  background: linear-gradient(157deg, #ffffff 0%, #f5f6f2 60%, #e8eae4 100%);
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.30),
    0 8px 18px rgba(0, 0, 0, 0.34),
    inset 0 0 0 1px rgba(0, 0, 0, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.95);
}
/* 预设尺寸（仍为响应式 clamp，避免窄屏溢出） */
.card.size-sm { --card-w: clamp(34px, 9vw, 46px); }
.card.size-md { --card-w: clamp(40px, 10.5vw, 56px); }
.card.size-lg { --card-w: clamp(46px, 12.5vw, 68px); }

.card.red { color: #d1362f; }
.card.black { color: #1a1c22; }

.pip {
  font-size: clamp(20px, 6.4vw, 36px);
  opacity: 0.95;
  filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.07));
}

.corner {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 0.9;
}
.corner .r {
  font-weight: 800;
  font-size: clamp(11px, 3vw, 16px);
  letter-spacing: -0.5px;
  font-variant-numeric: tabular-nums;
}
.corner .s {
  font-size: clamp(9px, 2.5vw, 14px);
  margin-top: 1px;
}
.corner.tl { top: clamp(4px, 1.1vw, 7px); left: clamp(5px, 1.2vw, 8px); }
.corner.br {
  bottom: clamp(4px, 1.1vw, 7px);
  right: clamp(5px, 1.2vw, 8px);
  transform: rotate(180deg);
}

/* 空位：虚线暗金描边 + 淡斜纹，提示未发的 turn/river */
.card.empty {
  background:
    repeating-linear-gradient(
      45deg,
      rgba(231, 198, 103, 0.06) 0 7px,
      rgba(231, 198, 103, 0.12) 7px 14px
    ),
    rgba(6, 20, 12, 0.28);
  border: 1.5px dashed rgba(231, 198, 103, 0.38);
  box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.38);
}
.card.empty .ghost {
  width: 30%;
  aspect-ratio: 1;
  border-radius: 50%;
  border: 2px dashed rgba(231, 198, 103, 0.30);
}
</style>
