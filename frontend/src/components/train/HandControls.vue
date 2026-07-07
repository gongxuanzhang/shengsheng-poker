<script setup>
import { computed } from 'vue'

// 手数 / 新一手 / 弱点统计。
const props = defineProps({
  handCount: { type: Number, default: 0 },
  handOver: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  stats: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['new-hand'])

const s = computed(() => props.stats || {})
const total = computed(() => s.value.decisions || 0)
const bad = computed(() => s.value.deviations || 0)
const accRate = computed(() => (total.value ? Math.round(((total.value - bad.value) / total.value) * 100) : null))
</script>

<template>
  <div class="hand-controls">
    <div class="hc-left">
      <div class="stat">
        <span class="stat-lbl">手数</span>
        <span class="stat-val">{{ handCount }}</span>
      </div>
      <div class="stat">
        <span class="stat-lbl">决策</span>
        <span class="stat-val">{{ total }}</span>
      </div>
      <div class="stat">
        <span class="stat-lbl">偏离</span>
        <span class="stat-val warn">{{ bad }}</span>
      </div>
      <div class="stat" v-if="accRate !== null">
        <span class="stat-lbl">达标率</span>
        <span class="stat-val ok">{{ accRate }}%</span>
      </div>
    </div>
    <button class="new-btn" :disabled="busy" @click="emit('new-hand')">
      {{ handCount === 0 ? '开始训练' : handOver ? '下一手' : '重开一手' }}
    </button>
  </div>
</template>

<style scoped>
.hand-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.hc-left { display: flex; gap: 10px; flex-wrap: wrap; }
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 56px;
  padding: 6px 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.26);
  border: 1px solid var(--line, rgba(255, 255, 255, 0.1));
}
.stat-lbl { font-size: 10px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--ink-dim, #a9c2b1); }
.stat-val { font-size: 17px; font-weight: 800; color: var(--ink, #ecf4ee); font-variant-numeric: tabular-nums; }
.stat-val.warn { color: #f5b169; }
.stat-val.ok { color: #7ee29a; }

.new-btn {
  padding: 11px 26px;
  border: none;
  border-radius: 11px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.4px;
  color: #22331f;
  background: linear-gradient(180deg, #f2d879 0%, #e7c667 55%, #d3ac47 100%);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.5);
  transition: transform 0.12s, filter 0.12s;
}
.new-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.05); }
.new-btn:disabled { cursor: default; opacity: 0.6; filter: saturate(0.6); }
</style>
