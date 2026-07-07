<script setup>
import { ref } from 'vue'
import SolverView from './components/SolverView.vue'
import TrainerView from './components/train/TrainerView.vue'

// 顶部 Tab:单局面 Solver ↔ 训练对局 Trainer。
// 用 v-if 切换(而非 v-show):离开 Trainer 时卸载,触发其 onBeforeUnmount 释放 Worker 会话。
const tab = ref('trainer')
</script>

<template>
  <div class="app-shell">
    <nav class="tabs">
      <button :class="['tab', { on: tab === 'trainer' }]" @click="tab = 'trainer'">训练</button>
      <button :class="['tab', { on: tab === 'solver' }]" @click="tab = 'solver'">Solver</button>
    </nav>
    <TrainerView v-if="tab === 'trainer'" />
    <SolverView v-else />
  </div>
</template>

<style scoped>
.app-shell { position: relative; }
.tabs {
  position: fixed;
  top: 12px;
  right: 14px;
  z-index: 50;
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(8, 24, 15, 0.72);
  border: 1px solid rgba(231, 198, 103, 0.3);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(6px);
}
.tab {
  padding: 7px 20px;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.4px;
  color: #a9c2b1;
  background: transparent;
  transition: all 0.14s;
}
.tab:hover { color: #ecf4ee; }
.tab.on {
  color: #22331f;
  background: linear-gradient(180deg, #f2d879, #d3ac47);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.3);
}
</style>
