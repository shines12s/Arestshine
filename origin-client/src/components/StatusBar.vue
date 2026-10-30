<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDashboardStore } from '@/store'
import { useMqttDataStore } from '@/store/modules/mqtt_data'
import { showDanger } from '@/store/modules/message_service'
import { CurrentStage } from '@/utils/mqtt_protocol_constants'
import { MechanismId } from '@/utils/mqtt_protocol'
import type { RobotData, OutpostOwner } from '@/store/modules/mqtt_data'

const dashboardStore = useDashboardStore()
const mqttStore = useMqttDataStore()

const localMatchTime = ref(0)
const lastTickTime = ref(0)
const displayNow = ref(Date.now())
let matchTimerInterval: ReturnType<typeof setInterval> | null = null

const isBluePerspective = computed(() => mqttStore.currentRobotId >= 100)
const globalStatus = computed(() => mqttStore.globalUnitStatus)

const redBaseHealth = computed(() =>
  isBluePerspective.value ? globalStatus.value.enemyBaseHealth : globalStatus.value.baseHealth
)
const blueBaseHealth = computed(() =>
  isBluePerspective.value ? globalStatus.value.baseHealth : globalStatus.value.enemyBaseHealth
)
const BASE_MAX_HEALTH = 10000
const OUTPOST_MAX_HEALTH = 1000
const redOutpost = computed(() => mqttStore.redOutpost)
const blueOutpost = computed(() => mqttStore.blueOutpost)
const redTotalDamage = computed(() =>
  isBluePerspective.value ? globalStatus.value.totalDamageEnemy : globalStatus.value.totalDamageAlly
)
const blueTotalDamage = computed(() =>
  isBluePerspective.value ? globalStatus.value.totalDamageAlly : globalStatus.value.totalDamageEnemy
)

function mechanismSeconds(mechanismId: MechanismId): number {
  const index = mqttStore.specialMechanisms.mechanismId.indexOf(mechanismId)
  return index >= 0 ? Math.max(0, mqttStore.specialMechanisms.mechanismTimeSec[index] ?? 0) : 0
}

const ownFortressSeconds = computed(() =>
  mechanismSeconds(MechanismId.OWN_FORTRESS_OCCUPIED)
)
const enemyFortressSeconds = computed(() =>
  mechanismSeconds(MechanismId.ENEMY_FORTRESS_OCCUPIED)
)
const isOwnFortressBeingOccupied = computed(() => ownFortressSeconds.value > 0)

const AIR_STATE_LABELS: Record<string, string> = {
  STANDBY: '待命',
  RECHARGING: '充能'
}

function airStateLabel(state: string): string {
  return AIR_STATE_LABELS[state] ?? state
}

function ownerLabel(owner: OutpostOwner): string {
  if (owner === 'blue') return '蓝方'
  if (owner === 'neutral') return '中立'
  return '红方'
}

function ownerClass(owner: OutpostOwner): string {
  return owner === 'blue' ? 'blue' : owner === 'neutral' ? 'neutral' : 'red'
}

function ratio(value: number, max: number): string {
  return `${Math.max(0, Math.min(100, (value / max) * 100)).toFixed(1)}%`
}

watch(isOwnFortressBeingOccupied, (isBeingOccupied, wasBeingOccupied) => {
  if (isBeingOccupied && !wasBeingOccupied) {
    showDanger('堡垒告警', '我方堡垒正在被占领！', 3000)
  }
})

type RobotSlot = {
  number: number
  robot: RobotData | null
}

const ROBOT_NUMBERS = [1, 3, 4, 7]

const redRobots = computed<RobotSlot[]>(() =>
  ROBOT_NUMBERS.map((number) => ({
    number,
    robot: mqttStore.redRobotList.find((item) => item.robotId === number) ?? null
  }))
)
const blueRobots = computed<RobotSlot[]>(() =>
  ROBOT_NUMBERS.map((number) => ({
    number,
    robot: mqttStore.blueRobotList.find((item) => item.robotId === number + 100) ?? null
  }))
)

const formattedMatchTime = computed(() => {
  const seconds = Math.max(0, localMatchTime.value)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60)
    .toString()
    .padStart(2, '0')}`
})

function startLocalTimer(): void {
  if (matchTimerInterval) return
  lastTickTime.value = Date.now()
  matchTimerInterval = setInterval(() => {
    displayNow.value = Date.now()
    if (mqttStore.gameStatus.isPaused || localMatchTime.value <= 0) return
    const now = Date.now()
    if (now - lastTickTime.value >= 1000) {
      localMatchTime.value = Math.max(0, localMatchTime.value - 1)
      lastTickTime.value = now
    }
  }, 100)
}

function stopLocalTimer(): void {
  if (!matchTimerInterval) return
  clearInterval(matchTimerInterval)
  matchTimerInterval = null
}

watch(
  () => mqttStore.gameStatus.currentStage,
  (stage) => {
    if (stage === CurrentStage.FIGHTING) {
      localMatchTime.value = Math.floor(mqttStore.gameStatus.stageCountdownSec)
      startLocalTimer()
    } else {
      stopLocalTimer()
      localMatchTime.value = Math.floor(mqttStore.gameStatus.stageCountdownSec)
    }
  },
  { immediate: true }
)

watch(
  () => mqttStore.gameStatus.stageCountdownSec,
  (seconds) => {
    localMatchTime.value = Math.floor(seconds)
    lastTickTime.value = Date.now()
  }
)

function robotName(number: number): string {
  const names: Record<number, string> = {
    1: '重装',
    3: '步兵',
    4: '步兵',
    7: '哨兵'
  }
  return names[number] ?? '未知'
}

function healthPercent(robot: RobotData | null): number {
  if (!robot?.hasStaticStatus || robot.maxHealth <= 0) return 0
  return Math.max(0, Math.min(100, (robot.currentHealth / robot.maxHealth) * 100))
}

function buybackInvincibleSeconds(robot: RobotData | null): number {
  if (!robot) return 0
  const expiresAt = mqttStore.buybackInvincibleUntil.get(robot.robotId) ?? 0
  return Math.max(0, (expiresAt - displayNow.value) / 1000)
}

function isBuybackInvincible(robot: RobotData | null): boolean {
  return buybackInvincibleSeconds(robot) > 0
}

function formatBuybackInvincibleSeconds(robot: RobotData | null): string {
  return buybackInvincibleSeconds(robot).toFixed(1)
}

onMounted(() => {
  if (mqttStore.gameStatus.currentStage === CurrentStage.FIGHTING) startLocalTimer()
})

onUnmounted(() => {
  stopLocalTimer()
  dashboardStore.stopMatchTimer()
})

defineExpose({
  setMatchStatus: dashboardStore.setMatchStatus,
  updateScore: dashboardStore.updateScore,
  resetScore: dashboardStore.resetScore
})
</script>

<template>
  <div class="battle-hud" aria-label="比赛状态总览">
    <div class="objectives-row">
      <div
        class="objective edge-left outpost-objective"
        :class="ownerClass(redOutpost.owner)"
        :title="`物理位置：红方前哨站；当前归属：${ownerLabel(redOutpost.owner)}`"
      >
        <span class="objective-label">{{ ownerLabel(redOutpost.owner) }}前哨站</span>
        <strong>{{ redOutpost.health }}</strong>
        <span class="objective-bar"><i :style="{ width: ratio(redOutpost.health, OUTPOST_MAX_HEALTH) }"></i></span>
        <small class="objective-max">/{{ OUTPOST_MAX_HEALTH }}</small>
      </div>
      <div class="objective red" :title="`红方基地上限 ${BASE_MAX_HEALTH}`">
        <span class="objective-label">红方基地</span>
        <strong>{{ redBaseHealth }}</strong>
        <span class="objective-bar"><i :style="{ width: ratio(redBaseHealth, BASE_MAX_HEALTH) }"></i></span>
        <small class="objective-max">/{{ BASE_MAX_HEALTH }}</small>
      </div>

      <div class="match-clock" :class="{ paused: mqttStore.gameStatus.isPaused }">
        <span class="clock-label">剩余时间</span>
        <strong>{{ formattedMatchTime }}</strong>
        <span v-if="mqttStore.gameStatus.isPaused" class="pause-label">暂停</span>
      </div>

      <div class="objective blue" :title="`蓝方基地上限 ${BASE_MAX_HEALTH}`">
        <span class="objective-label">蓝方基地</span>
        <strong>{{ blueBaseHealth }}</strong>
        <span class="objective-bar"><i :style="{ width: ratio(blueBaseHealth, BASE_MAX_HEALTH) }"></i></span>
        <small class="objective-max">/{{ BASE_MAX_HEALTH }}</small>
      </div>
      <div
        class="objective edge-right outpost-objective"
        :class="ownerClass(blueOutpost.owner)"
        :title="`物理位置：蓝方前哨站；当前归属：${ownerLabel(blueOutpost.owner)}`"
      >
        <span class="objective-label">{{ ownerLabel(blueOutpost.owner) }}前哨站</span>
        <strong>{{ blueOutpost.health }}</strong>
        <span class="objective-bar"><i :style="{ width: ratio(blueOutpost.health, OUTPOST_MAX_HEALTH) }"></i></span>
        <small class="objective-max">/{{ OUTPOST_MAX_HEALTH }}</small>
      </div>
    </div>

    <div class="robots-row">
      <template v-for="team in ['red', 'blue'] as const" :key="team">
        <div v-if="team === 'blue'" class="roster-divider" aria-hidden="true"></div>
        <section class="team-roster" :aria-label="team === 'red' ? '红方机器人' : '蓝方机器人'">
          <article
            v-for="slot in team === 'red' ? redRobots : blueRobots"
            :key="slot.number"
            class="robot-card"
            :class="[
              `${team}-card`,
              {
                defeated: slot.robot && slot.robot.currentHealth <= 0,
                offline: !slot.robot,
                'buyback-invincible': isBuybackInvincible(slot.robot)
              }
            ]"
          >
            <div class="robot-heading">
              <span class="robot-number">{{ slot.number }}</span>
              <span class="robot-name">{{ robotName(slot.number) }}</span>
              <span class="robot-level">LV.{{ slot.robot?.level ?? '--' }}</span>
            </div>

            <div v-if="isBuybackInvincible(slot.robot)" class="buyback-indicator">
              买活无敌 {{ formatBuybackInvincibleSeconds(slot.robot) }}s
            </div>

            <div class="primary-stats">
              <div class="primary-stat">
                <span class="stat-label">HP</span>
                <div class="stat-value">
                  <strong>{{ slot.robot?.currentHealth ?? '--' }}</strong>
                  <small>/<template v-if="slot.robot?.hasStaticStatus">{{ slot.robot.maxHealth }}</template><template v-else>--</template></small>
                </div>
              </div>
            </div>

            <div class="health-track" :class="{ unknown: !slot.robot?.hasStaticStatus }">
              <span class="health-fill" :style="{ width: `${healthPercent(slot.robot)}%` }"></span>
            </div>
          </article>
        </section>
      </template>
    </div>

    <div class="tactical-status-row" aria-label="己方与敌方堡垒、空中系统及己方经济状态">
      <div class="fortress-box own-fortress">
        <span class="fortress-label">占领敌方堡垒</span>
        <strong>{{ enemyFortressSeconds }}</strong>
        <small>秒</small>
      </div>
      <div class="drone-support-box own-air">
        <span class="drone-side">己方空中系统</span>
        <strong class="state-air">
          {{ mqttStore.airReadyCount }}/{{ mqttStore.airHangarCount }} · {{ airStateLabel(mqttStore.airSystemStatus) }}
        </strong>
      </div>
      <div class="economy-box" aria-label="己方目前剩余经济">
        <span class="economy-label">己方剩余经济</span>
        <strong>{{ mqttStore.logisticsStatus.remainingEconomy }}</strong>
      </div>
      <div class="drone-support-box enemy-air">
        <span class="drone-side">敌方空中系统</span>
        <strong class="state-air">4 单元</strong>
      </div>
      <div class="fortress-box enemy-fortress">
        <span class="fortress-label">我方堡垒被占领</span>
        <strong :class="{ 'occupation-alert': isOwnFortressBeingOccupied }">{{ ownFortressSeconds }}</strong>
        <small>秒</small>
      </div>
    </div>

    <div class="system-badges" aria-label="飞镖与雷达系统">
      <span class="system-badge"><b>8</b> 飞镖系统 · READY</span>
      <span class="system-badge"><b>9</b> 雷达系统 · ONLINE</span>
      <span class="system-badge air"><b>AIR</b> 机库 {{ mqttStore.airHangarCount }} · 待命 {{ mqttStore.airReadyCount }}</span>
    </div>

    <div class="damage-row" aria-label="红蓝双方累计总伤害">
      <div class="damage-box red-damage">
        <span>红方总伤害</span>
        <strong>{{ redTotalDamage }}</strong>
      </div>
      <div class="damage-center">累计伤害</div>
      <div class="damage-box blue-damage">
        <strong>{{ blueTotalDamage }}</strong>
        <span>蓝方总伤害</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.battle-hud {
  position: fixed;
  top: 8px;
  left: 50%;
  /* 与 Dashboard 内左下角机器人自身信息使用相同的 HUD 层级。 */
  z-index: 50;
  width: min(1500px, calc(100vw - 24px));
  transform: translateX(-50%);
  color: #f7fbff;
  font-family: var(--font-tech-cn);
  pointer-events: none;
  text-shadow: 0 2px 5px rgba(0, 0, 0, 0.65);
}

.objectives-row {
  display: grid;
  grid-template-columns: 1fr 1.35fr 150px 1.35fr 1fr;
  align-items: stretch;
  height: 54px;
}

.objective,
.match-clock {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px solid rgba(204, 225, 245, 0.25);
  background: rgba(10, 20, 33, 0.88);
  overflow: hidden;
}

.objective::after {
  position: absolute;
  inset: auto 0 0;
  height: 2px;
  content: '';
  opacity: 0.55;
}

.objective.red {
  background: linear-gradient(100deg, rgba(99, 11, 22, 0.94), rgba(40, 24, 37, 0.91));
}

.objective.red::after { background: linear-gradient(90deg, #b31325, #ff596b); }

.objective.blue {
  background: linear-gradient(100deg, rgba(24, 36, 54, 0.91), rgba(4, 68, 114, 0.94));
}

.objective.blue::after { background: linear-gradient(90deg, #37b4ff, #087ac5); }

.edge-left { clip-path: polygon(8% 0, 100% 0, 94% 100%, 0 100%); }
.edge-right { clip-path: polygon(0 0, 92% 0, 100% 100%, 6% 100%); }

.objective-label {
  color: rgba(235, 244, 255, 0.82);
  font-size: 13px;
  letter-spacing: 0.06em;
}

.objective strong {
  font-family: var(--font-tech-mono);
  font-size: 21px;
  font-variant-numeric: tabular-nums;
}

.objective-max {
  align-self: flex-end;
  margin-bottom: 5px;
  color: rgba(235, 244, 255, 0.48);
  font: 700 9px var(--font-tech-mono);
}

.objective-bar {
  position: absolute;
  right: 10px;
  bottom: 7px;
  left: 10px;
  height: 5px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.1);
  box-shadow: 0 0 8px rgba(0, 0, 0, 0.35);
}

.objective-bar i {
  display: block;
  height: 100%;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 0 8px currentColor;
  transition: width 220ms ease;
}

.objective.red .objective-bar i { background: linear-gradient(90deg, #b31325, #ff596b); }
.objective.blue .objective-bar i { background: linear-gradient(90deg, #37b4ff, #087ac5); }
.objective.neutral { background: linear-gradient(100deg, rgba(64, 70, 76, 0.92), rgba(28, 34, 40, 0.92)); }
.objective.neutral::after { background: linear-gradient(90deg, #8d99a5, #d1d9df); }
.objective.neutral .objective-bar i { background: #aab4bd; }

.system-badges {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 8px;
  pointer-events: none;
}

.system-badge {
  padding: 4px 9px;
  border: 1px solid rgba(120, 205, 255, 0.24);
  color: #9fc7db;
  background: rgba(8, 20, 31, 0.82);
  font: 700 9px var(--font-tech-mono);
  letter-spacing: 0.04em;
}

.system-badge b {
  margin-right: 4px;
  color: #e9fbff;
}

.system-badge.air {
  border-color: rgba(255, 198, 92, 0.3);
  color: #ffd485;
}

.drone-support-box strong.state-air {
  color: #6fe8ff;
}

.match-clock {
  z-index: 2;
  flex-direction: column;
  gap: 0;
  margin: -4px -8px;
  height: 62px;
  border-color: rgba(126, 224, 255, 0.55);
  border-radius: 0 0 14px 14px;
  background: linear-gradient(180deg, rgba(50, 76, 100, 0.97), rgba(17, 33, 48, 0.97));
  box-shadow: 0 0 18px rgba(81, 196, 235, 0.24);
}

.match-clock strong {
  font-family: var(--font-tech-mono);
  font-size: 25px;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0 10px rgba(133, 227, 255, 0.65);
}

.clock-label { color: #a9c3d5; font-size: 10px; letter-spacing: 0.14em; }
.pause-label { position: absolute; right: 7px; bottom: 5px; color: #ffcf65; font-size: 9px; }
.match-clock.paused { border-color: rgba(255, 188, 70, 0.75); }

.tactical-status-row {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 220px));
  justify-content: center;
  gap: 16px;
  margin-top: 12px;
  padding: 0 18px;
}

.fortress-box,
.drone-support-box {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 220px;
  height: 38px;
  padding: 0 16px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(10, 20, 31, 0.9);
  clip-path: polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
}

.fortress-label,
.drone-side {
  font: 800 12px var(--font-tech-cn);
  letter-spacing: 0.05em;
  white-space: nowrap;
}

.fortress-box strong,
.drone-support-box strong {
  margin-left: auto;
  font: 800 16px var(--font-tech-cn);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.05em;
  line-height: 1;
  text-align: right;
  white-space: nowrap;
}

.fortress-box strong.occupation-alert {
  color: #ff3b4f;
  animation: fortress-occupation-alert 0.7s ease-in-out infinite alternate;
}

@keyframes fortress-occupation-alert {
  from {
    opacity: 0.65;
    transform: scale(1);
    text-shadow: 0 0 4px rgba(255, 45, 68, 0.55);
  }
  to {
    opacity: 1;
    transform: scale(1.22);
    text-shadow: 0 0 12px rgba(255, 45, 68, 1);
  }
}

.fortress-box small { font-size: 9px; }

.own-fortress {
  border-color: rgba(50, 218, 174, 0.5);
  box-shadow: inset 0 -2px 0 rgba(38, 206, 161, 0.7);
}

.own-fortress .fortress-label,
.own-fortress strong,
.own-fortress small {
  color: #55e7bd;
}

.enemy-fortress {
  border-color: rgba(255, 166, 67, 0.52);
  box-shadow: inset 0 -2px 0 rgba(247, 141, 40, 0.75);
}

.enemy-fortress .fortress-label,
.enemy-fortress strong,
.enemy-fortress small {
  color: #ffb15d;
}

.economy-box {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  height: 38px;
  padding: 0 16px;
  border: 1px solid rgba(255, 214, 92, 0.5);
  background: linear-gradient(90deg, rgba(68, 48, 11, 0.9), rgba(20, 24, 28, 0.9));
  clip-path: polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
}

.economy-label {
  color: rgba(255, 239, 191, 0.82);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.economy-box strong {
  margin-left: auto;
  color: #ffd75f;
  font: 800 20px var(--font-tech-mono);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 0 9px rgba(255, 202, 55, 0.55);
}

.own-drone {
  border-color: rgba(50, 218, 174, 0.5);
  box-shadow: inset 0 -2px 0 rgba(38, 206, 161, 0.7);
}
.own-drone .drone-side { color: #55e7bd; }
.own-drone .state-idle { color: #55e7bd; }
.enemy-drone {
  border-color: rgba(255, 166, 67, 0.52);
  box-shadow: inset 0 -2px 0 rgba(247, 141, 40, 0.75);
}
.enemy-drone .drone-side { color: #ffb15d; }
.enemy-drone .state-idle { color: #ffb15d; }
.state-idle { color: #9fb0bc; }
.state-supporting {
  color: #52efbd;
  text-shadow: 0 0 9px rgba(45, 225, 170, 0.65);
}
.enemy-drone .state-supporting {
  color: #ffb15d;
  text-shadow: 0 0 9px rgba(255, 139, 50, 0.65);
}
.state-countered {
  color: #ff5268;
  animation: drone-countered-alert 0.75s ease-in-out infinite alternate;
}

@keyframes drone-countered-alert {
  from { opacity: 0.7; text-shadow: 0 0 4px rgba(255, 52, 79, 0.5); }
  to { opacity: 1; text-shadow: 0 0 12px rgba(255, 52, 79, 1); }
}

.robots-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 48px minmax(0, 1fr);
  align-items: stretch;
  margin-top: 16px;
  padding: 0 8px;
}

.team-roster {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  min-width: 0;
}

.robot-card {
  position: relative;
  min-width: 0;
  min-height: 72px;
  padding: 7px 7px 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 3px;
  background: linear-gradient(145deg, rgba(25, 36, 50, 0.94), rgba(9, 16, 26, 0.92));
  overflow: hidden;
  transition: opacity 0.2s ease;
}

.robot-card::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  content: '';
}

.red-card { border-color: rgba(220, 45, 65, 0.4); }
.red-card::before { background: #e33349; box-shadow: 0 0 10px #e33349; }
.blue-card { border-color: rgba(31, 145, 211, 0.42); }
.blue-card::before { background: #249edf; box-shadow: 0 0 10px #249edf; }
.robot-card.defeated { opacity: 0.42; filter: grayscale(0.8); }
.robot-card.offline { opacity: 0.62; }

.robot-card.buyback-invincible {
  border-color: #ffd34e;
  animation: buyback-card-alert 0.55s ease-in-out infinite alternate;
}

.robot-card.buyback-invincible .robot-heading,
.robot-card.buyback-invincible .stat-label,
.robot-card.buyback-invincible .stat-value strong,
.robot-card.buyback-invincible .stat-value small {
  color: #ffd75f;
  text-shadow: 0 0 10px rgba(255, 205, 54, 0.9);
}

.buyback-indicator {
  margin-top: 4px;
  color: #ffe173;
  font: 800 10px var(--font-tech-mono);
  letter-spacing: 0.03em;
  text-align: center;
  white-space: nowrap;
}

@keyframes buyback-card-alert {
  from {
    filter: brightness(0.82);
    transform: translateY(0) scale(1);
    box-shadow: 0 0 4px rgba(255, 205, 54, 0.45);
  }
  to {
    filter: brightness(1.2);
    transform: translateY(-2px) scale(1.035);
    box-shadow: 0 0 16px rgba(255, 205, 54, 0.95);
  }
}

.robot-heading {
  display: flex;
  align-items: baseline;
  white-space: nowrap;
}

.robot-heading { gap: 4px; padding-left: 2px; }
.robot-number { font: 800 18px var(--font-tech-display); line-height: 1; }
.robot-name { overflow: hidden; font-size: 11px; font-weight: 700; text-overflow: ellipsis; }
.robot-level { margin-left: auto; color: #ffda71; font: 700 8px var(--font-tech-mono); }

.primary-stats {
  display: block;
  margin-top: 6px;
}

.primary-stat {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.stat-label {
  margin-bottom: 1px;
  color: #9eafbd;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.stat-value {
  display: flex;
  align-items: baseline;
  min-width: 0;
  color: #fff;
  font-family: var(--font-tech-mono);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.stat-value strong {
  color: #fff;
  font: 800 16px var(--font-tech-mono);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-shadow: 0 0 7px rgba(255, 255, 255, 0.25);
}

.stat-value small {
  overflow: hidden;
  color: #a9b7c2;
  font-size: 8px;
  text-overflow: ellipsis;
}

.health-track {
  height: 6px;
  margin: 5px 1px 0;
  background: rgba(255, 255, 255, 0.13);
  transform: skewX(-12deg);
  overflow: hidden;
}

.roster-divider {
  position: relative;
}

.roster-divider::after {
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 50%;
  width: 1px;
  content: '';
  background: linear-gradient(transparent, rgba(151, 213, 239, 0.55), transparent);
}

.health-track.unknown {
  background: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.12) 0 5px, rgba(255, 255, 255, 0.04) 5px 10px);
}

.health-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #d82238, #ff6a78);
  box-shadow: 0 0 5px rgba(255, 58, 81, 0.7);
  transition: width 0.25s ease;
}

.blue-card .health-fill {
  background: linear-gradient(90deg, #087fc7, #49c3ff);
  box-shadow: 0 0 5px rgba(49, 177, 255, 0.7);
}

.damage-row {
  display: grid;
  grid-template-columns: 270px 90px 270px;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin: 7px 8px 0;
}

.damage-box {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 30px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(12, 20, 31, 0.86);
}

.damage-box span {
  color: rgba(235, 243, 250, 0.76);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.damage-box strong {
  font: 800 19px var(--font-tech-mono);
  font-variant-numeric: tabular-nums;
}

.red-damage {
  justify-content: flex-end;
  border-color: rgba(224, 48, 68, 0.42);
  background: linear-gradient(90deg, rgba(19, 24, 34, 0.8), rgba(103, 13, 27, 0.9));
}

.red-damage strong { color: #ff6576; text-shadow: 0 0 8px rgba(239, 53, 75, 0.45); }

.blue-damage {
  justify-content: flex-start;
  border-color: rgba(34, 151, 218, 0.44);
  background: linear-gradient(90deg, rgba(8, 67, 105, 0.9), rgba(19, 24, 34, 0.8));
}

.blue-damage strong { color: #55c2ff; text-shadow: 0 0 8px rgba(41, 164, 232, 0.45); }

.damage-center {
  color: rgba(210, 225, 236, 0.62);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-align: center;
}

@media (max-width: 900px) {
  .battle-hud { width: calc(100vw - 16px); }
  .objectives-row { grid-template-columns: 1fr 1fr 116px 1fr 1fr; }
  .objective { flex-direction: column; gap: 0; }
  .objective-label { font-size: 9px; }
  .objective strong { font-size: 16px; }
  .tactical-status-row {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 7px;
    padding-inline: 4px;
  }
  .fortress-box,
  .drone-support-box,
  .economy-box { min-width: 0; padding-inline: 6px; }
  .fortress-label,
  .drone-side,
  .economy-label { font-size: 9px; }
  .robots-row { grid-template-columns: minmax(0, 1fr) 24px minmax(0, 1fr); padding: 0; }
  .team-roster { gap: 3px; }
  .robot-card { min-height: 68px; padding: 6px 4px; }
  .robot-heading { gap: 3px; }
  .robot-number { font-size: 16px; }
  .robot-name { font-size: 10px; }
  .robot-level { font-size: 8px; }
  .primary-stats { margin-top: 5px; }
  .stat-label { font-size: 8px; }
  .stat-value strong { font-size: 15px; }
  .stat-value small { font-size: 8px; }
  .health-track { margin-top: 4px; }
  .damage-row { grid-template-columns: minmax(0, 220px) 70px minmax(0, 220px); gap: 5px; margin-inline: 0; }
  .damage-box { gap: 6px; padding: 0 7px; }
  .damage-box span { font-size: 9px; }
  .damage-box strong { font-size: 16px; }
  .damage-center { font-size: 8px; }
}
</style>
