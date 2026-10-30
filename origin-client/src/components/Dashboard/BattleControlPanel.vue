<template>
  <aside class="battle-control-panel" aria-label="战场控制度">
    <header class="control-header">
      <div>
        <span class="control-kicker">BATTLE CONTROL</span>
        <strong>战场控制度</strong>
      </div>
      <span class="control-diff" :class="diffClass">{{ diffText }}</span>
    </header>

    <div class="control-score-row">
      <div class="control-side red">
        <span>红方累计</span>
        <b>{{ battle.redScore }}</b>
        <em>+{{ battle.redRate }}/s</em>
      </div>
      <div class="control-side blue">
        <span>蓝方累计</span>
        <b>{{ battle.blueScore }}</b>
        <em>+{{ battle.blueRate }}/s</em>
      </div>
    </div>

    <div class="control-positions">
      <div v-for="position in positions" :key="position.key" class="control-position">
        <span class="position-name">{{ position.label }}</span>
        <span class="position-owner" :class="position.owner">{{ ownerLabel(position.owner) }}</span>
        <span class="position-state" :class="position.state">{{ stateLabel(position.state) }}</span>
      </div>
    </div>

    <div class="control-rule">
      全部 2 前哨 +1/s · 全部 2 基地 +3/s
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMqttDataStore } from '@/store'
import type { ControlOwner, ControlState } from '@/store/modules/mqtt_data'

const store = useMqttDataStore()
const battle = store.battleControl

const positions = computed(() => [
  { key: 'redBase', label: '红方基地', owner: battle.redBase.owner, state: battle.redBase.state },
  { key: 'blueBase', label: '蓝方基地', owner: battle.blueBase.owner, state: battle.blueBase.state },
  { key: 'redOutpost', label: '红方前哨', owner: battle.redOutpost.owner, state: battle.redOutpost.state },
  { key: 'blueOutpost', label: '蓝方前哨', owner: battle.blueOutpost.owner, state: battle.blueOutpost.state }
])

const diff = computed(() => battle.redScore - battle.blueScore)
const diffText = computed(() =>
  diff.value === 0 ? '持平' : `${diff.value > 0 ? '红方' : '蓝方'}领先 ${Math.abs(diff.value)}`
)
const diffClass = computed(() => (diff.value === 0 ? 'even' : diff.value > 0 ? 'red' : 'blue'))

function ownerLabel(owner: ControlOwner): string {
  return owner === 'red' ? '红方' : owner === 'blue' ? '蓝方' : '中立'
}

function stateLabel(state: ControlState): string {
  return state === 'COMPLETE' ? '完全控制' : state === 'TEMPORARY' ? '临时控制' : '未控制'
}
</script>

<style scoped>
.battle-control-panel {
  position: fixed;
  top: 214px;
  right: 22px;
  z-index: 56;
  width: 286px;
  padding: 12px 13px 10px;
  color: #e8f3ff;
  background: linear-gradient(180deg, rgba(7, 19, 32, 0.94), rgba(4, 12, 22, 0.96));
  border: 1px solid rgba(92, 180, 230, 0.28);
  border-radius: 12px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(10px);
  pointer-events: none;
  font-family: var(--font-tech-mono, monospace);
}

.control-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.control-kicker {
  display: block;
  color: #57bde5;
  font-size: 8px;
  letter-spacing: 0.14em;
  margin-bottom: 2px;
}

.control-header strong {
  font-size: 14px;
  letter-spacing: 0.06em;
}

.control-diff {
  padding: 3px 7px;
  border-radius: 4px;
  font-size: 10px;
  white-space: nowrap;
}
.control-diff.red { color: #ffb4b4; background: rgba(210, 42, 58, 0.24); }
.control-diff.blue { color: #a9d8ff; background: rgba(30, 120, 210, 0.24); }
.control-diff.even { color: #b9c7d5; background: rgba(150, 165, 180, 0.16); }

.control-score-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 9px 0;
}

.control-side {
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.control-side.red { background: linear-gradient(120deg, rgba(130, 18, 30, 0.34), rgba(20, 10, 14, 0.2)); }
.control-side.blue { background: linear-gradient(120deg, rgba(16, 72, 130, 0.34), rgba(8, 17, 30, 0.2)); }
.control-side span { display: block; color: #9db1c4; font-size: 9px; }
.control-side b { display: inline-block; margin-top: 2px; font-size: 22px; line-height: 1; }
.control-side em { margin-left: 4px; font-style: normal; font-size: 9px; color: #76d8a7; }

.control-positions {
  display: grid;
  gap: 4px;
  padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.control-position {
  display: grid;
  grid-template-columns: 1fr 44px 62px;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  padding: 2px 0;
}
.position-name { color: #b6c8d8; }
.position-owner { text-align: center; padding: 1px 0; border-radius: 3px; }
.position-owner.red { color: #ffb3b3; background: rgba(210, 42, 58, 0.2); }
.position-owner.blue { color: #a9d8ff; background: rgba(30, 120, 210, 0.2); }
.position-owner.neutral { color: #b9c7d5; background: rgba(150, 165, 180, 0.14); }
.position-state { text-align: right; color: #8fa6b9; }
.position-state.COMPLETE { color: #71d8a5; }
.position-state.TEMPORARY { color: #ffd177; }
.position-state.NEUTRAL { color: #8b9aaa; }

.control-rule {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  color: #7e93a5;
  font-size: 9px;
  text-align: right;
}
</style>
