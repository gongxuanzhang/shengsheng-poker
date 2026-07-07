<script setup>
import { ref, computed, watch } from 'vue'
import Term from '../Term.vue'

// hero 回合动作栏:按 getDecision().legalActions 渲染,提交 {type, amount}。
const props = defineProps({
  decision: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['act'])

const legal = computed(() => props.decision?.legalActions ?? [])
const pot = computed(() => props.decision?.state?.pot ?? 0)

const find = (t) => legal.value.find((a) => a.type === t) || null
const foldA = computed(() => find('fold'))
const checkA = computed(() => find('check'))
const callA = computed(() => find('call'))
const allinA = computed(() => find('allin'))
// bet 与 raise 互斥(同一街只会出现其一)
const sizer = computed(() => find('bet') || find('raise'))

const amount = ref(0)
// 每次决策节点变化,把下注额重置到最小合法值。
watch(
  sizer,
  (s) => { if (s) amount.value = s.min },
  { immediate: true },
)

const min = computed(() => sizer.value?.min ?? 0)
const max = computed(() => sizer.value?.max ?? 0)

// 快捷尺寸预设(全部夹在 [min,max] 内并去重,确保永远合法)。
const presets = computed(() => {
  const s = sizer.value
  if (!s) return []
  const raw = [
    { k: 'min', v: s.min },
    { k: '½ 池', v: Math.round(pot.value * 0.5) },
    { k: '¾ 池', v: Math.round(pot.value * 0.75) },
    { k: '池', v: pot.value },
    { k: 'max', v: s.max },
  ]
  const seen = new Set()
  const out = []
  for (const p of raw) {
    const v = Math.min(Math.max(p.v, s.min), s.max)
    if (!Number.isFinite(v) || seen.has(v)) continue
    seen.add(v)
    out.push({ k: p.k, v })
  }
  return out
})

function clampAmount() {
  let v = Math.round(Number(amount.value))
  if (!Number.isFinite(v)) v = min.value
  amount.value = Math.min(Math.max(v, min.value), max.value)
}

function act(type, amt) {
  if (props.disabled) return
  const payload = { type }
  if (amt != null) payload.amount = amt
  emit('act', payload)
}

function submitSizer() {
  clampAmount()
  act(sizer.value.type, amount.value)
}
</script>

<template>
  <div class="actionbar" :class="{ disabled }">
    <div class="btn-row">
      <button v-if="foldA" class="act fold" :disabled="disabled" @click="act('fold')">
        <Term id="fold" no-click>弃牌</Term>
      </button>
      <button v-if="checkA" class="act check" :disabled="disabled" @click="act('check')">
        <Term id="check" no-click>过牌</Term>
      </button>
      <button v-if="callA" class="act call" :disabled="disabled" @click="act('call', callA.amount)">
        <Term id="call" no-click>跟注</Term> {{ callA.amount }}
      </button>
      <button
        v-if="sizer"
        class="act raise"
        :disabled="disabled"
        @click="submitSizer"
      >
        <Term :id="sizer.type === 'bet' ? 'bet' : 'raise'" no-click>
          {{ sizer.type === 'bet' ? '下注' : '加注' }}
        </Term>
        到 {{ amount }}
      </button>
      <button v-if="allinA" class="act allin" :disabled="disabled" @click="act('allin', allinA.amount)">
        <Term id="allin" no-click>全下</Term> {{ allinA.amount }}
      </button>
    </div>

    <!-- 下注/加注尺寸控制 -->
    <div v-if="sizer" class="sizer">
      <div class="presets">
        <button
          v-for="p in presets"
          :key="p.k"
          class="preset"
          :class="{ on: amount === p.v }"
          :disabled="disabled"
          @click="amount = p.v"
        >{{ p.k }}</button>
      </div>
      <div class="slider-row">
        <input
          class="slider"
          type="range"
          :min="min"
          :max="max"
          step="1"
          v-model.number="amount"
          :disabled="disabled"
        />
        <input
          class="num"
          type="number"
          :min="min"
          :max="max"
          v-model.number="amount"
          :disabled="disabled"
          @change="clampAmount"
        />
      </div>
      <div class="range-hint">合法区间 {{ min }} – {{ max }}</div>
    </div>
  </div>
</template>

<style scoped>
.actionbar {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.actionbar.disabled { opacity: 0.55; pointer-events: none; }
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.act {
  flex: 1 1 auto;
  min-width: 92px;
  padding: 13px 16px;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: #fff;
  box-shadow: 0 5px 14px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.18);
  transition: transform 0.1s, filter 0.12s;
}
.act:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.08); }
.act:active:not(:disabled) { transform: translateY(0); }
.act:disabled { cursor: default; opacity: 0.6; }
.act.fold { background: linear-gradient(180deg, #6b7078, #4c5158); }
.act.check,
.act.call { background: linear-gradient(180deg, #3fae63, #2c8a4a); }
.act.raise { background: linear-gradient(180deg, #f2b845, #d99a2b); color: #2a2410; }
.act.allin { background: linear-gradient(180deg, #b8352c, #8b1a12); }

.sizer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 12px;
  background: var(--field, rgba(0, 0, 0, 0.3));
  border: 1px solid var(--line, rgba(255, 255, 255, 0.1));
}
.presets { display: flex; flex-wrap: wrap; gap: 6px; }
.preset {
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.14));
  background: rgba(0, 0, 0, 0.25);
  color: var(--ink-dim, #a9c2b1);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.12s;
}
.preset:hover:not(:disabled) { border-color: var(--gold, #e7c667); color: var(--ink, #ecf4ee); }
.preset.on {
  background: rgba(231, 198, 103, 0.18);
  border-color: var(--gold, #e7c667);
  color: var(--gold, #e7c667);
}
.slider-row { display: flex; align-items: center; gap: 12px; }
.slider { flex: 1; accent-color: var(--gold, #e7c667); }
.num {
  width: 88px;
  box-sizing: border-box;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.14));
  background: rgba(0, 0, 0, 0.35);
  color: var(--ink, #ecf4ee);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  outline: none;
}
.num:focus { border-color: var(--gold, #e7c667); }
.range-hint {
  font-size: 11px;
  color: var(--ink-dim, #a9c2b1);
  font-variant-numeric: tabular-nums;
}
</style>
