<script setup lang="ts">
/**
 * RobotActionHint - 机器人特殊操作提示组件
 * 2026 阵容：
 * - 1 号重装：装配菜单（原装配功能迁移）
 * - 3/4 号步兵：激活能量机关
 * - 6 号空中系统：机库与 4 个演示单元状态
 * - 7 号哨兵：无
 * - 8 号飞镖系统：飞镖瞄准/发射
 * - 9 号雷达系统：无
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useMqttDataStore } from '@/store/modules/mqtt_data'

const mqttStore = useMqttDataStore()

const emit = defineEmits<{
  (e: 'action', action: string, params?: Record<string, unknown>): void
}>()

// 当前机器人 ID
const currentRobotId = computed(() => mqttStore.currentRobotId)

// 机器人类型（1=重装, 3/4=步兵, 6=空中系统, 7=哨兵, 8=飞镖, 9=雷达）
const robotType = computed(() => {
  const id = currentRobotId.value
  if (id <= 0) return 0
  return id < 100 ? id : id - 100
})

// 机器人类型名称
const robotTypeName = computed(() => {
  const typeMap: Record<number, string> = {
    1: '重装',
    3: '步兵',
    4: '步兵',
    6: '空中',
    7: '哨兵',
    8: '飞镖',
    9: '雷达'
  }
  return typeMap[robotType.value] || '未知'
})

// ==================== 重装装配状态 ====================
const isAssemblyMenuOpen = ref(false)
const selectedDifficulty = ref<1 | 2 | 3 | 4>(2)
const isAssembling = ref(false)

// ==================== 空中系统 / 飞镖系统 ====================
const isAirPanelOpen = ref(false)
const isDartTargeting = ref(false)
// 飞镖目标（与 MQTT 协议 DartTarget 一致）
const dartTargets = [
  { id: 1, name: '前哨站' },
  { id: 2, name: '基地(固定)' },
  { id: 3, name: '基地(随机固定)' },
  { id: 4, name: '基地(随机移动)' },
  { id: 5, name: '基地(结束移动)' }
]
const selectedDartTarget = ref(0)

function airStateLabel(state: string): string {
  return state === 'STANDBY' ? '待命' : state === 'RECHARGING' ? '充能' : state
}

// K 键功能描述
const kKeyDescription = computed(() => {
  switch (robotType.value) {
    case 1:
      return isAssemblyMenuOpen.value ? '关闭装配菜单' : '打开装配菜单'
    case 3:
    case 4:
      return '激活能量机关'
    case 6:
      return isAirPanelOpen.value ? '关闭空中系统' : '查看空中系统'
    case 8:
      if (isDartTargeting.value) {
        return `发射飞镖 → ${dartTargets[selectedDartTarget.value].name}`
      }
      return '开启飞镖'
    default:
      return ''
  }
})

// 是否显示 K 键提示
const showKKeyHint = computed(() => {
  return [1, 3, 4, 6, 8].includes(robotType.value)
})

// 处理 K 键按下
function handleKKeyPress(): void {
  switch (robotType.value) {
    case 1:
      isAssemblyMenuOpen.value = !isAssemblyMenuOpen.value
      emit('action', 'heavy-assembly-menu', { open: isAssemblyMenuOpen.value })
      console.log(`[RobotAction] 重装${isAssemblyMenuOpen.value ? '打开' : '关闭'}装配菜单`)
      break

    case 3:
    case 4:
      emit('action', 'infantry-power-rune')
      console.log('[RobotAction] 步兵激活能量机关')
      break

    case 6:
      isAirPanelOpen.value = !isAirPanelOpen.value
      console.log(`[RobotAction] 空中系统面板${isAirPanelOpen.value ? '打开' : '关闭'}`)
      break

    case 8:
      if (!isDartTargeting.value) {
        isDartTargeting.value = true
        emit('action', 'dart-open', { open: true })
        console.log('[RobotAction] 飞镖系统进入瞄准模式')
      } else {
        const target = dartTargets[selectedDartTarget.value]
        emit('action', 'dart-fire', { targetId: target.id, targetName: target.name })
        console.log(`[RobotAction] 飞镖发射 → ${target.name}`)
        isDartTargeting.value = false
      }
      break
  }
}

// 处理 F 键按下
function handleFKeyPress(): void {
  // 1 号重装：开始装配
  if (robotType.value === 1 && isAssemblyMenuOpen.value) {
    if (!isAssembling.value) {
      isAssembling.value = true
      isAssemblyMenuOpen.value = false
      emit('action', 'heavy-assembly-menu', { open: false })
      emit('action', 'heavy-start-assembly', { difficulty: selectedDifficulty.value })
      console.log(`[RobotAction] 重装开始装配 (难度: ${selectedDifficulty.value}级)，关闭菜单`)
    }
  }
}

// 切换飞镖目标（方向键或滚轮）
function cycleDartTarget(direction: 1 | -1): void {
  if (!isDartTargeting.value) return
  selectedDartTarget.value =
    (selectedDartTarget.value + direction + dartTargets.length) % dartTargets.length
}

// 取消装配
function cancelAssembly(): void {
  isAssembling.value = false
  emit('action', 'heavy-cancel-assembly')
  console.log('[RobotAction] 重装取消装配')
}

// 选择装配难度
function selectDifficulty(difficulty: 1 | 2 | 3 | 4): void {
  selectedDifficulty.value = difficulty
}

// 键盘事件处理
function handleKeyDown(event: KeyboardEvent): void {
  // 如果在输入框中，忽略
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
    return
  }

  const key = event.key.toLowerCase()

  if (key === 'k') {
    handleKKeyPress()
  } else if (key === 'f') {
    handleFKeyPress()
  } else if (isDartTargeting.value) {
    // 飞镖瞄准模式下的方向键
    if (key === 'arrowup' || key === 'arrowleft') {
      cycleDartTarget(-1)
    } else if (key === 'arrowdown' || key === 'arrowright') {
      cycleDartTarget(1)
    } else if (key === 'escape') {
      isDartTargeting.value = false
      emit('action', 'dart-open', { open: false })
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})

// 暴露方法
defineExpose({
  isAssemblyMenuOpen,
  isAirPanelOpen,
  isDartTargeting,
  cancelAssembly
})
</script>

<template>
  <!-- K 键功能提示 (底部) -->
  <Transition name="slide-up">
    <div v-if="showKKeyHint" class="robot-action-hint">
      <div class="action-badge" :class="robotTypeName">
        <span class="key-hint"> 按 <kbd>K</kbd> {{ kKeyDescription }} </span>

        <!-- 重装额外提示 -->
        <span v-if="robotType === 1 && isAssemblyMenuOpen" class="extra-hint">
          | 按 <kbd>F</kbd> 开始装配
        </span>

        <!-- 空中系统提示 -->
        <span v-if="robotType === 6" class="extra-hint">
          | 机库 {{ mqttStore.airHangarCount }} · 待命 {{ mqttStore.airReadyCount }}
        </span>
      </div>
    </div>
  </Transition>

  <!-- 重装装配菜单弹窗 -->
  <Transition name="modal-fade">
    <div v-if="robotType === 1 && isAssemblyMenuOpen" class="assembly-menu-backdrop">
      <div class="assembly-menu">
        <h3 class="menu-title">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
            ></path>
          </svg>
          装配设置
        </h3>

        <!-- 难度选择 -->
        <div class="difficulty-section">
          <span class="section-label">装配难度</span>
          <div class="difficulty-options">
            <button
              v-for="diff in [1, 2, 3, 4] as const"
              :key="diff"
              class="difficulty-btn"
              :class="{ selected: selectedDifficulty === diff }"
              @click="selectDifficulty(diff)"
            >
              {{ diff }}级
            </button>
          </div>
        </div>

        <!-- 取消装配按钮（装配进行中时可用） -->
        <div v-if="isAssembling" class="assembly-actions">
          <button class="cancel-btn" @click="cancelAssembly">取消装配</button>
        </div>

        <!-- 操作提示 -->
        <div class="menu-footer">
          <span v-if="!isAssembling">
            按 <kbd>F</kbd> 开始装配（关闭窗口） | 按 <kbd>K</kbd> 关闭菜单
          </span>
          <span v-else>装配进行中 | 按 <kbd>K</kbd> 打开菜单取消</span>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 空中系统：机库 + 4 个演示单元 -->
  <Transition name="fade">
    <div v-if="robotType === 6 && isAirPanelOpen" class="air-system-panel">
      <div class="air-system-inner">
        <div class="air-system-head">
          <div>
            <span class="air-kicker">AIR SYSTEM</span>
            <h4>空中系统 · 机库 {{ mqttStore.airHangarCount }}</h4>
          </div>
          <span class="air-state">{{ airStateLabel(mqttStore.airSystemStatus) }}</span>
        </div>
        <div class="air-unit-grid">
          <div
            v-for="unit in mqttStore.airUnits"
            :key="unit.id"
            class="air-unit"
            :class="unit.state.toLowerCase()"
          >
            <div class="air-unit-head">
              <b>{{ unit.id }}</b>
              <span>{{ unit.state }}</span>
            </div>
            <div class="air-unit-bar"><i :style="{ width: `${unit.energy}%` }"></i></div>
            <div class="air-unit-meta">
              <span>机体 {{ unit.health }}%</span>
              <span>能量 {{ unit.energy }}%</span>
            </div>
          </div>
        </div>
        <p class="air-system-hint">演示单元编号 AIR-01..04 仅用于本地展示，不是官方机器人 ID。</p>
      </div>
    </div>
  </Transition>

  <!-- 飞镖系统瞄准 UI -->
  <Transition name="fade">
    <div v-if="robotType === 8 && isDartTargeting" class="dart-targeting-ui">
      <div class="targeting-panel">
        <h4>飞镖目标选择</h4>
        <div class="target-list">
          <div
            v-for="(target, index) in dartTargets"
            :key="target.id"
            class="target-item"
            :class="{ selected: selectedDartTarget === index }"
            @click="selectedDartTarget = index"
          >
            {{ target.name }}
          </div>
        </div>
        <div class="targeting-hint">
          按 <kbd>↑</kbd><kbd>↓</kbd> 切换目标 | 按 <kbd>K</kbd> 发射 | 按 <kbd>ESC</kbd> 取消
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* K 键功能提示 */
.robot-action-hint {
  position: fixed;
  bottom: 50px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  pointer-events: none;
}

.action-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: rgba(25, 28, 38, 0.85);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 25px;
  font-size: 14px;
  color: #e2e8f0;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

.action-badge.步兵 {
  border-color: rgba(59, 130, 246, 0.5);
  box-shadow: 0 4px 20px rgba(59, 130, 246, 0.2);
}

.action-badge.重装 {
  border-color: rgba(255, 153, 51, 0.55);
  box-shadow: 0 4px 20px rgba(255, 153, 51, 0.22);
}

.action-badge.空中 {
  border-color: rgba(92, 225, 255, 0.55);
  box-shadow: 0 4px 20px rgba(92, 225, 255, 0.22);
}

.action-badge.飞镖 {
  border-color: rgba(168, 85, 247, 0.55);
  box-shadow: 0 4px 20px rgba(168, 85, 247, 0.22);
}

.key-hint kbd,
.extra-hint kbd,
.menu-footer kbd,
.targeting-hint kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  margin: 0 3px;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: #f1f5f9;
}

.extra-hint {
  opacity: 0.7;
  padding-left: 8px;
  border-left: 1px solid rgba(255, 255, 255, 0.2);
}

/* 重装装配菜单 */
.assembly-menu-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.assembly-menu {
  background: rgba(25, 28, 38, 0.95);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 24px;
  min-width: 320px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.menu-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 20px 0;
  font-size: 18px;
  font-weight: 600;
  color: #fbbf24;
}

.menu-title svg {
  stroke: #fbbf24;
}

.difficulty-section {
  margin-bottom: 20px;
}

.section-label {
  display: block;
  margin-bottom: 10px;
  font-size: 13px;
  color: #94a3b8;
}

.difficulty-options {
  display: flex;
  gap: 10px;
}

.difficulty-btn {
  flex: 1;
  padding: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #e2e8f0;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.difficulty-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.difficulty-btn.selected {
  background: rgba(251, 191, 36, 0.2);
  border-color: #fbbf24;
  color: #fbbf24;
}

.assembly-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  margin-bottom: 16px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #fbbf24;
}

.status-indicator.assembling svg {
  animation: spin 2s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.assembly-actions {
  display: flex;
  justify-content: center;
  padding: 12px 0;
  margin-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.cancel-btn {
  padding: 6px 12px;
  background: rgba(239, 68, 68, 0.2);
  border: 1px solid rgba(239, 68, 68, 0.5);
  border-radius: 6px;
  color: #ef4444;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.cancel-btn:hover {
  background: rgba(239, 68, 68, 0.3);
}

.menu-footer {
  text-align: center;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;
  color: #64748b;
}

/* 空中系统 */
.air-system-panel {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(5px);
}

.air-system-inner {
  width: min(720px, calc(100vw - 48px));
  padding: 22px;
  border: 1px solid rgba(96, 220, 255, 0.35);
  border-radius: 14px;
  background: linear-gradient(160deg, rgba(8, 24, 36, 0.98), rgba(4, 12, 20, 0.98));
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
}

.air-system-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.air-kicker {
  color: #5ce1ff;
  font: 700 9px var(--font-tech-mono);
  letter-spacing: 0.16em;
}

.air-system-head h4 {
  margin: 4px 0 0;
  color: #ecfbff;
  font-size: 18px;
}

.air-state {
  padding: 5px 9px;
  border: 1px solid rgba(92, 225, 255, 0.4);
  color: #5ce1ff;
  font: 700 10px var(--font-tech-mono);
}

.air-unit-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.air-unit {
  padding: 10px;
  border: 1px solid rgba(92, 225, 255, 0.18);
  background: rgba(255, 255, 255, 0.03);
}

.air-unit.charging {
  border-color: rgba(255, 198, 92, 0.3);
}

.air-unit-head {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font: 700 10px var(--font-tech-mono);
}

.air-unit-head b { color: #eafaff; }
.air-unit-head span { color: #5ce1ff; }
.air-unit.charging .air-unit-head span { color: #ffc65c; }

.air-unit-bar {
  height: 5px;
  margin: 8px 0 6px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.08);
}

.air-unit-bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #2bb7ff, #8de7ff);
}

.air-unit-meta {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  color: #7592a4;
  font: 600 9px var(--font-tech-mono);
}

.air-system-hint {
  margin: 14px 0 0;
  color: #6f8b9c;
  font-size: 11px;
  line-height: 1.5;
}

/* 飞镖系统瞄准 */
.dart-targeting-ui {
  position: fixed;
  top: 50%;
  right: 50px;
  transform: translateY(-50%);
  z-index: 500;
}

.targeting-panel {
  background: rgba(25, 28, 38, 0.95);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(168, 85, 247, 0.3);
  border-radius: 12px;
  padding: 16px;
  min-width: 200px;
  box-shadow: 0 0 30px rgba(168, 85, 247, 0.3);
}

.targeting-panel h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 600;
  color: #a855f7;
  text-align: center;
}

.target-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.target-item {
  padding: 10px 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #e2e8f0;
  font-size: 14px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.target-item:hover {
  background: rgba(168, 85, 247, 0.15);
}

.target-item.selected {
  background: rgba(168, 85, 247, 0.3);
  border-color: #a855f7;
  color: #fff;
  box-shadow: 0 0 15px rgba(168, 85, 247, 0.3);
}

.targeting-hint {
  text-align: center;
  font-size: 11px;
  color: #64748b;
}

/* 过渡动画 */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}

.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.2s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
