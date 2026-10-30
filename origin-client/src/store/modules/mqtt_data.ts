/**
 * MQTT 数据 Pinia Store
 * 基于 RoboMaster 2026 自定义客户端通信协议 V2.0.0
 * 管理所有通过 MQTT 接收的比赛数据
 */

import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import { showDanger, showWarning, dismissMessage } from './message_service'
import {
  CurrentStage,
  BaseStatus,
  OutpostStatus,
  EventId,
  BuffType,
  PenaltyType,
  SentinelPosture,
  RuneStatus,
  getCurrentStageName,
  getBaseStatusName,
  getOutpostStatusName
} from '../../utils/mqtt_protocol_constants'
import type {
  GameStatus,
  GlobalUnitStatus,
  GlobalLogisticsStatus,
  GlobalSpecialMechanism,
  Event,
  RobotStaticStatus,
  RobotDynamicStatus,
  RobotModuleStatus,
  RobotPosition,
  RobotInjuryStat,
  RobotRespawnStatus,
  Buff,
  PenaltyInfo,
  RadarInfoToClient,
  RaderInfoToClient,
  SentinelStatusSync,
  RuneStatusSync,
  CustomByteBlock,
  MessageType
} from '../../utils/mqtt_protocol'

// ==================== 常量定义 ====================

/** 最大保留的历史消息数 */
const MAX_MESSAGE_HISTORY = 80

/** 最大保留的事件数 */
const MAX_EVENT_HISTORY = 100

const RED_GLOBAL_UNIT_HEALTH_IDS = [1, 3, 4, 7]
const BLUE_GLOBAL_UNIT_HEALTH_IDS = [101, 103, 104, 107]

const mqttVerboseLogs =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  window.localStorage?.getItem('origin.mqtt.verbose') === '1'
const mqttHistoryEnabled =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  window.localStorage?.getItem('origin.mqtt.history') === '1'

function mqttDebugLog(...args: unknown[]): void {
  if (mqttVerboseLogs) {
    console.debug(...args)
  }
}

/**
 * 机器人类型名称到 ID 的映射表
 * 初始默认值，会在运行时从配置文件动态加载更新
 */
const ROBOT_TYPE_TO_ID: Record<string, number> = {
  红方1号重装: 1,
  蓝方1号重装: 101,
  红方3号步兵: 3,
  蓝方3号步兵: 103,
  红方4号步兵: 4,
  蓝方4号步兵: 104,
  红方7号哨兵: 7,
  蓝方7号哨兵: 107,
  红方8号飞镖: 8,
  蓝方8号飞镖: 108,
  红方9号雷达: 9,
  蓝方9号雷达: 109,
  红方空中系统: 6,
  蓝方空中系统: 106
}

/** 地面机器人展示顺序：1 重装、3/4 步兵、7 哨兵。 */
export const RED_ROSTER_IDS = [1, 3, 4, 7] as const
export const BLUE_ROSTER_IDS = [101, 103, 104, 107] as const

// ==================== 类型定义 ====================

/**
 * 完整的机器人数据（合并静态+动态+位置+模块）
 */
export interface RobotData {
  // 静态属性（由 RobotStaticStatus 消息提供）
  robotId: number
  robotType: number
  team: 'red' | 'blue'
  connectionState: number // 连接状态(0=未连接, 1=连接)
  fieldState: number // 上场状态(0=已上场,1=未上场)
  performanceSystemShooter: number // 性能体系-发射机构
  performanceSystemChassis: number // 性能体系-底盘

  // 动态状态
  currentHealth: number
  maxHealth: number // 由服务器提供
  currentHeat: number
  maxHeat: number // 由服务器提供
  heatCooldownRate: number // 热量冷却速率(每秒) - 由服务器提供
  currentChassisEnergy: number
  maxChassisEnergy: number // 由服务器提供
  currentBufferEnergy: number
  maxBufferEnergy: number // 由服务器提供
  maxPower: number // 最大功率 - 由服务器提供
  remainingAmmo: number
  level: number // 当前等级 - 由服务器提供
  currentExperience: number
  experienceForUpgrade: number // 升级所需经验

  // 位置
  x: number
  y: number
  z: number
  yaw: number

  // 模块状态
  moduleStatus: RobotModuleStatus | null

  // 其他状态
  isAlive: boolean
  isPendingRespawn: boolean
  isOutOfCombat: boolean
  outOfCombatCountdown: number // 脱战倒计时（秒）
  canRemoteHeal: boolean // 是否可以远程补血
  canRemoteAmmo: boolean // 是否可以远程补弹

  // 数据有效性（避免将初始化兜底值当成服务器真实数据展示）
  hasStaticStatus: boolean
  hasAmmoStatus: boolean

  // 时间戳
  lastUpdate: number
}

/**
 * 消息历史记录
 */
interface MessageHistoryItem {
  id: number
  topic: string
  type: MessageType
  timestamp: number
  data: unknown
}

/**
 * 连接状态
 */
interface ConnectionStats {
  isConnected: boolean
  totalMessages: number
  messagesPerSecond: number
  lastMessageTime: number
  reconnectCount: number
}

export type OutpostOwner = 'red' | 'blue' | 'neutral'

export interface OutpostState {
  /** 物理位置，永不随归属改变。 */
  position: 'red' | 'blue'
  /** 当前归属方。 */
  owner: OutpostOwner
  health: number
  maxHealth: number
  status: OutpostStatus
}

export type AirUnitState = 'READY' | 'CHARGING' | 'ACTIVE'

export interface AirUnit {
  /** 演示编号，不是官方机器人 ID。 */
  id: string
  state: AirUnitState
  health: number
  energy: number
}

export type ControlOwner = 'red' | 'blue' | 'neutral'
export type ControlState = 'COMPLETE' | 'TEMPORARY' | 'NEUTRAL'

export interface ControlPosition {
  owner: ControlOwner
  state: ControlState
}

export interface BattleControlState {
  redScore: number
  blueScore: number
  redRate: number
  blueRate: number
  redBase: ControlPosition
  blueBase: ControlPosition
  redOutpost: ControlPosition
  blueOutpost: ControlPosition
}

// ==================== Store 定义 ====================

export const useMqttDataStore = defineStore('mqttData', () => {
  // ==================== 比赛状态 ====================

  /** 比赛全局状态 */
  const gameStatus = ref<GameStatus>({
    currentRound: 1,
    totalRounds: 3,
    redScore: 0,
    blueScore: 0,
    currentStage: CurrentStage.NOT_STARTED,
    stageCountdownSec: 0,
    stageElapsedSec: 0,
    isPaused: false,
    gameResult: 255,
    endReason: 255
  })

  /** 全局单位状态 */
  const globalUnitStatus = ref<GlobalUnitStatus>({
    baseHealth: 10000,
    baseStatus: BaseStatus.INVINCIBLE,
    baseShield: 10000,
    outpostHealth: 1000,
    outpostStatus: OutpostStatus.INVINCIBLE,
    enemyBaseHealth: 10000,
    enemyBaseStatus: BaseStatus.INVINCIBLE,
    enemyBaseShield: 10000,
    enemyOutpostHealth: 1000,
    enemyOutpostStatus: OutpostStatus.INVINCIBLE,
    robotHealth: [],
    robotBullets: [],
    totalDamageAlly: 0,
    totalDamageEnemy: 0,
    totalDamageRed: 0,
    totalDamageBlue: 0
  })

  // ==================== 前哨站：位置与归属分离 ====================
  const redOutpost = reactive<OutpostState>({
    position: 'red',
    owner: 'red',
    health: 1000,
    maxHealth: 1000,
    status: OutpostStatus.INVINCIBLE
  })
  const blueOutpost = reactive<OutpostState>({
    position: 'blue',
    owner: 'blue',
    health: 1000,
    maxHealth: 1000,
    status: OutpostStatus.INVINCIBLE
  })

  // ==================== 空中系统（机库 + 4 个演示单元） ====================
  // 演示数据由模拟器 Event 的 air:... 参数发送；客户端不预置机库/单元状态。
  const airHangarCount = ref(0)
  const airUnits = ref<AirUnit[]>([])
  const airReadyCount = computed(() => airUnits.value.filter((unit) => unit.state === 'READY').length)
  const airSystemStatus = computed(() => (airReadyCount.value > 0 ? 'STANDBY' : 'RECHARGING'))

  /** 空中单元只做演示状态更新；编号不进入官方 robot_id 空间。 */
  function updateAirUnits(
    units: Array<Partial<AirUnit>>,
    hangarCount = airHangarCount.value
  ): void {
    // 首次收到模拟器事件时建立 4 个演示单元；之后只更新状态。
    const base =
      airUnits.value.length > 0
        ? airUnits.value
        : Array.from({ length: 4 }, (_, index) => ({
            id: `AIR-0${index + 1}`,
            state: 'CHARGING' as AirUnitState,
            health: 100,
            energy: 0
          }))
    airUnits.value = base.map((unit, index) => ({
      ...unit,
      ...(units[index] ?? {}),
      id: unit.id
    }))
    if (Number.isFinite(hangarCount)) {
      airHangarCount.value = Math.max(0, Math.min(8, Math.round(hangarCount)))
    }
  }

  // ==================== 战场控制度（模拟器 Event 驱动） ====================
  const battleControl = reactive<BattleControlState>({
    redScore: 0,
    blueScore: 0,
    redRate: 0,
    blueRate: 0,
    redBase: { owner: 'red', state: 'COMPLETE' },
    blueBase: { owner: 'blue', state: 'COMPLETE' },
    redOutpost: { owner: 'red', state: 'COMPLETE' },
    blueOutpost: { owner: 'blue', state: 'COMPLETE' }
  })
  const controlDiff = computed(() => battleControl.redScore - battleControl.blueScore)

  function updateBattleControl(state: Partial<BattleControlState>): void {
    if (!state) return
    if (Number.isFinite(Number(state.redScore))) battleControl.redScore = Number(state.redScore)
    if (Number.isFinite(Number(state.blueScore))) battleControl.blueScore = Number(state.blueScore)
    if (Number.isFinite(Number(state.redRate))) battleControl.redRate = Number(state.redRate)
    if (Number.isFinite(Number(state.blueRate))) battleControl.blueRate = Number(state.blueRate)
    for (const key of ['redBase', 'blueBase', 'redOutpost', 'blueOutpost'] as const) {
      const next = state[key]
      if (next) battleControl[key] = { owner: next.owner, state: next.state }
    }
  }

  function resetBattleControl(): void {
    updateBattleControl({
      redScore: 0,
      blueScore: 0,
      redRate: 0,
      blueRate: 0,
      redBase: { owner: 'red', state: 'COMPLETE' },
      blueBase: { owner: 'blue', state: 'COMPLETE' },
      redOutpost: { owner: 'red', state: 'COMPLETE' },
      blueOutpost: { owner: 'blue', state: 'COMPLETE' }
    })
  }

  function setOutpostState(
    position: 'red' | 'blue',
    owner: OutpostOwner,
    health = position === 'red' ? redOutpost.health : blueOutpost.health
  ): void {
    const target = position === 'red' ? redOutpost : blueOutpost
    target.owner = owner
    target.health = Math.max(0, Math.min(target.maxHealth, health))
    target.status =
      target.health <= 0
        ? OutpostStatus.DESTROYED_CAN_REBUILD
        : OutpostStatus.ALIVE_ROTATING
  }

  /** 后勤状态 */
  const logisticsStatus = ref<GlobalLogisticsStatus>({
    remainingEconomy: 0,
    totalEconomyObtained: BigInt(0),
    techLevel: 0,
    encryptionLevel: 0
  })

  /** 特殊机制 */
  const specialMechanisms = ref<GlobalSpecialMechanism>({
    mechanismId: [],
    mechanismTimeSec: []
  })

  // ==================== 机器人数据 ====================

  /** 红队机器人数据 Map (robotId -> RobotData) */
  const redRobots = reactive<Map<number, RobotData>>(new Map())

  /** 蓝队机器人数据 Map (robotId -> RobotData) */
  const blueRobots = reactive<Map<number, RobotData>>(new Map())

  /** 机器人受伤统计 Map (robotId -> RobotInjuryStat) */
  const injuryStats = reactive<Map<number, RobotInjuryStat>>(new Map())

  /** 机器人复活状态 Map (robotId -> RobotRespawnStatus) */
  const respawnStatus = reactive<Map<number, RobotRespawnStatus>>(new Map())

  /** 根据血量 0 -> >=100 推断的买活无敌结束时间（robotId -> Unix 毫秒） */
  const buybackInvincibleUntil = reactive<Map<number, number>>(new Map())
  /** 本局比赛中已经明确观测到战亡的机器人，防止首帧正常血量被误判为买活。 */
  const observedDeadRobotIds = new Set<number>()

  /** 当前选中的机器人类型名称 */
  const currentRobotType = ref<string>('')
  const serverSelectedRobotId = ref<number>(0)

  /** ID 不匹配警告状态（避免重复弹窗） */
  const idMismatchWarned = ref<boolean>(false)

  /** 当前选中机器人的 ID */
  const currentRobotId = computed(() => {
    if (serverSelectedRobotId.value > 0) return serverSelectedRobotId.value
    if (!currentRobotType.value) return 0
    return ROBOT_TYPE_TO_ID[currentRobotType.value] || 0
  })

  type RobotIdMapping = {
    id?: number
  }

  function findRobotNameById(robotId: number): string | null {
    const match = Object.entries(ROBOT_TYPE_TO_ID).find(([, id]) => id === robotId)
    return match?.[0] ?? null
  }

  /**
   * 从配置文件加载 ID 映射
   * 异步加载，更新 ROBOT_TYPE_TO_ID 映射表
   */
  async function loadRobotIdMappings(): Promise<void> {
    try {
      if (window.api?.getRobotConfig) {
        const config = await window.api.getRobotConfig()
        if (config?.robotMappings) {
          // 更新映射表
          for (const [name, mapping] of Object.entries(
            config.robotMappings as Record<string, RobotIdMapping>
          )) {
            if (mapping.id !== undefined) {
              ROBOT_TYPE_TO_ID[name] = mapping.id
            }
          }
          console.log('[MQTT Store] 已从配置文件加载机器人 ID 映射')
        }
      }
    } catch (error) {
      console.error('[MQTT Store] 加载机器人 ID 映射失败:', error)
    }
  }

  /**
   * 清除所有机器人数据（切换 ID 时调用）
   */
  function clearAllRobotData(): void {
    customDataEpoch += 1
    pendingCustomByteBlocks.clear()
    // 清除红队数据
    redRobots.clear()
    // 清除蓝队数据
    blueRobots.clear()
    // 清除受伤统计
    injuryStats.clear()
    // 清除复活状态
    respawnStatus.clear()
    buybackInvincibleUntil.clear()
    observedDeadRobotIds.clear()
    // 清除自定义数据
    customData.clear()
    // 重置 ID 不匹配警告状态
    idMismatchWarned.value = false

    console.log('[MQTT Store] 已清除所有机器人数据')
  }

  /** ID 不匹配警告消息的 ID（用于关闭弹窗） */
  let idMismatchMessageId: string | null = null

  function dismissIdMismatchWarning(): void {
    if (idMismatchMessageId) {
      dismissMessage(idMismatchMessageId)
      idMismatchMessageId = null
    }
    idMismatchWarned.value = false
  }

  function applyServerRobotName(robotId: number, robotName: string): void {
    if (currentRobotType.value !== robotName) {
      currentRobotType.value = robotName
      void loadRobotProtoConfig(robotName)
    }

    getOrCreateRobot(robotId, getRobotTeam(robotId))
  }

  function selectCurrentRobotFromServerId(serverRobotId: number): void {
    const robotId = Math.trunc(Number(serverRobotId))
    if (!Number.isFinite(robotId) || robotId <= 0) return

    const selectionChanged = serverSelectedRobotId.value !== robotId
    if (selectionChanged) {
      serverSelectedRobotId.value = robotId
      dismissIdMismatchWarning()
    }

    const robotName = findRobotNameById(robotId)
    if (robotName) {
      applyServerRobotName(robotId, robotName)
      if (selectionChanged) {
        console.log(`[MQTT Store] Auto-selected robot from server: ${robotName} (ID: ${robotId})`)
      }
      return
    }

    getOrCreateRobot(robotId, getRobotTeam(robotId))
    if (selectionChanged) {
      console.warn(`[MQTT Store] Server robot ID ${robotId} has no local robot name mapping`)
      void loadRobotIdMappings().then(() => {
        const mappedName = findRobotNameById(robotId)
        if (mappedName && serverSelectedRobotId.value === robotId) {
          applyServerRobotName(robotId, mappedName)
          console.log(
            `[MQTT Store] Auto-selected robot from loaded mapping: ${mappedName} (ID: ${robotId})`
          )
        }
      })
    }
  }

  /**
   * 检测服务器 ID 与本地 ID 是否匹配
   * @param serverRobotId 服务器返回的机器人 ID
   * @returns 是否匹配
   */
  function checkRobotIdMatch(serverRobotId: number): boolean {
    const localId = currentRobotId.value
    if (localId === 0) return true // 本地未选择机器人，不检测

    // 检查服务器 ID 是否与本地选择的 ID 匹配
    if (serverRobotId !== localId) {
      // 仅在未警告过时弹出消息
      if (!idMismatchWarned.value) {
        idMismatchWarned.value = true

        // 使用全局消息服务显示警告
          idMismatchMessageId = showWarning(
            '机器人 ID 不匹配',
            `服务器端和本地机器人配置不匹配，请检查 ID 设置是否正确。\n本地 ID: ${localId}，服务器 ID: ${serverRobotId}`,
            0 // 不自动关闭
          )

        console.warn(
          `[MQTT Store] ⚠️ 机器人 ID 不匹配! 本地 ID: ${localId}, 服务器 ID: ${serverRobotId}`
        )
      }
      return false
    }

    // ID 匹配，如果之前有警告弹窗则关闭它
    if (idMismatchWarned.value && idMismatchMessageId) {
        if (idMismatchMessageId) {
          dismissMessage(idMismatchMessageId)
          idMismatchMessageId = null
        }
      idMismatchWarned.value = false
      console.log('[MQTT Store] ✓ ID 匹配成功，关闭警告弹窗')
    }

    return true
  }

  /**
   * 初始化当前选中机器人的数据槽位
   *
   * MQTT 协议说明：
   * - ID 由用户预先与服务器协商确定
   * - 切换机器人类型时，清除所有旧数据，仅初始化新 ID 的数据槽位
   */
  function initializeCurrentRobot(robotTypeName: string): void {
    const robotId = ROBOT_TYPE_TO_ID[robotTypeName]
    if (!robotId) {
      console.warn(`[MQTT Store] 未知的机器人类型: ${robotTypeName}`)
      return
    }

    const team = robotId < 100 ? 'red' : 'blue'
    const robotMap = team === 'red' ? redRobots : blueRobots

    // 🔑 关键变更：清除所有机器人数据，仅保留当前选中的 ID
    clearAllRobotData()

    // 初始化当前机器人的数据槽位
    robotMap.set(robotId, {
      robotId,
      robotType: 0,
      team,
      // 连接和状态信息（等待服务器同步）
      connectionState: 0,
      fieldState: 1,
      performanceSystemShooter: 0,
      performanceSystemChassis: 0,
      // 动态状态
      currentHealth: 0,
      maxHealth: 600, // 服务器会更新
      currentHeat: 0,
      maxHeat: 240, // 服务器会更新
      heatCooldownRate: 10, // 服务器会更新
      currentChassisEnergy: 0,
      maxChassisEnergy: 150, // 服务器会更新
      currentBufferEnergy: 0,
      maxBufferEnergy: 60, // 服务器会更新
      maxPower: 45, // 服务器会更新
      remainingAmmo: 0,
      level: 1, // 服务器会更新
      currentExperience: 0,
      experienceForUpgrade: 100, // 默认升级所需经验
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      moduleStatus: {
        powerManager: 0,
        rfid: 0,
        lightStrip: 0,
        smallShooter: 0,
        bigShooter: 0,
        uwb: 0,
        armor: 0,
        videoTransmission: 0,
        capacitor: 0,
        mainController: 0,
        laserDetectionModule: 0
      },
      isAlive: false,
      isPendingRespawn: false,
      isOutOfCombat: false,
      outOfCombatCountdown: 0,
      canRemoteHeal: false,
      canRemoteAmmo: false,
      hasStaticStatus: false,
      hasAmmoStatus: false,
      lastUpdate: Date.now()
    })

    // 初始化受伤统计
    injuryStats.set(robotId, {
      totalDamage: 0,
      collisionDamage: 0,
      smallProjectileDamage: 0,
      largeProjectileDamage: 0,
      dartSplashDamage: 0,
      moduleOfflineDamage: 0,
      offlineDamage: 0,
      wifiOfflineDamage: 0,
      penaltyDamage: 0,
      serverKillDamage: 0,
      killerId: 0
    })

    // 初始化复活状态
    respawnStatus.set(robotId, {
      isPendingRespawn: false,
      totalRespawnProgress: 0,
      currentRespawnProgress: 0,
      canFreeRespawn: false,
      goldCostForRespawn: 0,
      canPayForRespawn: false
    })

    console.log(`[MQTT Store] 已切换到机器人: ${robotTypeName} (ID: ${robotId})`)
  }

  /**
   * 更新当前选中的机器人类型
   * 会清除所有旧数据并初始化新的数据槽位
   * @param robotTypeName 机器人类型名称（如"红方3号步兵"）
   * @param loadFromConfig 是否先从配置文件加载 ID 映射（默认 true）
   */
  async function updateCurrentRobotType(
    robotTypeName: string,
    loadFromConfig = true
  ): Promise<void> {
    if (currentRobotType.value === robotTypeName && serverSelectedRobotId.value === 0) return

    // 先从配置文件加载 ID 映射
    if (loadFromConfig) {
      await loadRobotIdMappings()
    }

    serverSelectedRobotId.value = 0
    dismissIdMismatchWarning()
    currentRobotType.value = robotTypeName
    initializeCurrentRobot(robotTypeName)
    console.log(`[MQTT Store] 切换机器人类型: ${robotTypeName}, 当前 ID: ${currentRobotId.value}`)
  }

  // 不自动初始化，等待 Dashboard 传递当前选中的机器人类型
  // 这样避免初始化不需要的数据

  /** 自定义数据 Map (robotId -> parsedData) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customData = reactive<Map<number, any>>(new Map())
  const pendingCustomByteBlocks = new Map<number, CustomByteBlock>()
  const parsingCustomByteBlocks = new Set<number>()
  let customDataEpoch = 0

  // ==================== Buff 和判罚 ====================

  /** 当前激活的 Buff 列表 */
  const activeBuffs = ref<Buff[]>([])

  /** 判罚信息列表 - 支持多个判罚同时生效 */
  const activePenalties = ref<Map<PenaltyType, PenaltyInfo & { startTime: number }>>(new Map())

  /** 兼容旧 API - 返回第一个判罚 */
  const penaltyInfo = computed<PenaltyInfo | null>(() => {
    if (activePenalties.value.size === 0) return null
    const first = activePenalties.value.values().next().value
    return first
      ? {
          penaltyType: first.penaltyType,
          penaltyEffectSec: first.penaltyEffectSec,
          totalPenaltyNum: first.totalPenaltyNum
        }
      : null
  })

  // ==================== 雷达和地图 ====================

  /** 雷达检测到的敌方机器人位置 */
  const radarDetections = ref<RaderInfoToClient[]>([])

  // ==================== 特殊单位状态 ====================

  /** 哨兵状态 */
  const sentinelStatus = ref<SentinelStatusSync | null>(null)

  /** 能量机关状态 */
  const runeStatus = ref<RuneStatusSync>({
    runeStatus: RuneStatus.NOT_ACTIVATED,
    activatedArms: 0,
    averageRings: 0
  })

  // ==================== 事件和消息 ====================

  /** 事件历史 */
  const eventHistory = ref<Event[]>([])

  /** 消息历史 */
  const messageHistory = ref<MessageHistoryItem[]>([])

  /** 消息计数器 */
  let messageIdCounter = 0

  // ==================== 连接状态 ====================

  /** 连接统计 */
  const connectionStats = ref<ConnectionStats>({
    isConnected: false,
    totalMessages: 0,
    messagesPerSecond: 0,
    lastMessageTime: 0,
    reconnectCount: 0
  })

  /** 每秒消息计数 */
  let messagesThisSecond = 0
  let totalMessagesReceived = 0
  let lastMessageTimestamp = 0

  /** MPS 统计定时器 */
  let mpsTimer: ReturnType<typeof setInterval> | null = null

  // ==================== 计算属性 ====================

  /** 比赛阶段名称 */
  const gameStageName = computed(() => getCurrentStageName(gameStatus.value.currentStage))

  /** 比赛是否进行中 */
  const isGameRunning = computed(() => gameStatus.value.currentStage === CurrentStage.FIGHTING)

  /** 基地状态名称 */
  const baseStatusName = computed(() => getBaseStatusName(globalUnitStatus.value.baseStatus))

  /** 前哨站状态名称 */
  const outpostStatusName = computed(() =>
    getOutpostStatusName(globalUnitStatus.value.outpostStatus)
  )

  /** 红队机器人列表 */
  const redRobotList = computed(() => Array.from(redRobots.values()))

  /** 蓝队机器人列表 */
  const blueRobotList = computed(() => Array.from(blueRobots.values()))

  /** 所有机器人列表 */
  const allRobots = computed(() => [...redRobotList.value, ...blueRobotList.value])

  const rosterRedRobots = computed(() =>
    RED_ROSTER_IDS.map((id) => redRobots.get(id)).filter((r): r is RobotData => Boolean(r))
  )
  const rosterBlueRobots = computed(() =>
    BLUE_ROSTER_IDS.map((id) => blueRobots.get(id)).filter((r): r is RobotData => Boolean(r))
  )

  /** 存活的红队地面机器人数量 */
  const aliveRedCount = computed(() => rosterRedRobots.value.filter((r) => r.isAlive).length)

  /** 存活的蓝队地面机器人数量 */
  const aliveBlueCount = computed(() => rosterBlueRobots.value.filter((r) => r.isAlive).length)

  /** 红队地面机器人总血量 */
  const redTotalHealth = computed(() =>
    rosterRedRobots.value.reduce((sum, r) => sum + r.currentHealth, 0)
  )

  /** 蓝队地面机器人总血量 */
  const blueTotalHealth = computed(() =>
    rosterBlueRobots.value.reduce((sum, r) => sum + r.currentHealth, 0)
  )

  /** 红队地面机器人总血量百分比 */
  const redHealthPercentage = computed(() => {
    const maxHealth = rosterRedRobots.value.reduce((sum, r) => sum + r.maxHealth, 0)
    return maxHealth > 0 ? (redTotalHealth.value / maxHealth) * 100 : 0
  })

  /** 蓝队地面机器人总血量百分比 */
  const blueHealthPercentage = computed(() => {
    const maxHealth = rosterBlueRobots.value.reduce((sum, r) => sum + r.maxHealth, 0)
    return maxHealth > 0 ? (blueTotalHealth.value / maxHealth) * 100 : 0
  })

  /** 当前激活的 Buff 数量 */
  const activeBuffCount = computed(() => activeBuffs.value.length)

  /** 最近的事件 */
  const recentEvents = computed(() => eventHistory.value.slice(0, 10))

  // ==================== 辅助函数 ====================

  /**
   * 获取或创建机器人数据
   */
  function getOrCreateRobot(robotId: number, team: 'red' | 'blue'): RobotData {
    const robotMap = team === 'red' ? redRobots : blueRobots
    let robot = robotMap.get(robotId)

    if (!robot) {
      robot = {
        robotId,
        robotType: 0,
        team,
        // 连接和状态信息（等待服务器同步）
        connectionState: 0,
        fieldState: 1,
        performanceSystemShooter: 0,
        performanceSystemChassis: 0,
        // 动态状态（默认值）
        currentHealth: 0,
        maxHealth: 600, // 服务器会更新
        currentHeat: 0,
        maxHeat: 240, // 服务器会更新
        heatCooldownRate: 10, // 服务器会更新
        currentChassisEnergy: 0,
        maxChassisEnergy: 150, // 服务器会更新
        currentBufferEnergy: 0,
        maxBufferEnergy: 60, // 服务器会更新
        maxPower: 45, // 服务器会更新
        remainingAmmo: 0,
        level: 1, // 服务器会更新
        currentExperience: 0,
        experienceForUpgrade: 100, // 默认升级所需经验
        // 位置
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        // 模块状态
        moduleStatus: null,
        // 其他状态
        isAlive: false,
        isPendingRespawn: false,
        isOutOfCombat: false,
        outOfCombatCountdown: 0,
        canRemoteHeal: false,
        canRemoteAmmo: false,
        hasStaticStatus: false,
        hasAmmoStatus: false,
        lastUpdate: Date.now()
      }
      robotMap.set(robotId, robot)
    }

    return robot
  }

  /**
   * 根据机器人 ID 判断队伍
   */
  function getRobotTeam(robotId: number): 'red' | 'blue' {
    // RoboMaster 规则: 1-7 红队, 101-107 蓝队
    return robotId < 100 ? 'red' : 'blue'
  }

  function getGlobalUnitHealthRobotIds(): number[] {
    if (currentRobotId.value >= 100) {
      return [...BLUE_GLOBAL_UNIT_HEALTH_IDS, ...RED_GLOBAL_UNIT_HEALTH_IDS]
    }

    return [...RED_GLOBAL_UNIT_HEALTH_IDS, ...BLUE_GLOBAL_UNIT_HEALTH_IDS]
  }

  function getOwnGlobalUnitRobotIds(): number[] {
    return currentRobotId.value >= 100 ? BLUE_GLOBAL_UNIT_HEALTH_IDS : RED_GLOBAL_UNIT_HEALTH_IDS
  }

  // ==================== 消息处理方法 ====================

  /**
   * 更新比赛状态
   */
  function updateGameStatus(status: GameStatus): void {
    gameStatus.value = status
    mqttDebugLog('[MQTT] 比赛状态更新:', gameStageName.value, status)
  }

  /**
   * 更新全局单位状态
   */
  function updateGlobalUnitStatus(status: GlobalUnitStatus): void {
    globalUnitStatus.value = status

    // 前哨站：联盟视角的 own/enemy 映射到固定物理位置，但归属单独保存。
    const ownIsBlue = currentRobotId.value >= 100
    const ownOutpost = ownIsBlue ? blueOutpost : redOutpost
    const enemyOutpost = ownIsBlue ? redOutpost : blueOutpost
    ownOutpost.health = status.outpostHealth
    ownOutpost.status = status.outpostStatus
    enemyOutpost.health = status.enemyOutpostHealth
    enemyOutpost.status = status.enemyOutpostStatus

    // 同步机器人血量到机器人数据
    const healthRobotIds = getGlobalUnitHealthRobotIds()
    status.robotHealth.forEach((hp, index) => {
      const robotId = healthRobotIds[index]
      if (!robotId) return
      const team = getRobotTeam(robotId)
      const robot = getOrCreateRobot(robotId, team)

      if (gameStatus.value.currentStage === CurrentStage.FIGHTING) {
        if (hp === 0) {
          observedDeadRobotIds.add(robotId)
          buybackInvincibleUntil.delete(robotId)
        } else if (observedDeadRobotIds.has(robotId)) {
          // 2026 规则：读条复活为上限血量的 10%（15~60），买活为满血（>=150）。
          // 仅在明确观测到 0 -> 正数的首帧使用 100 分界线，避免后续回血改变分类。
          if (hp >= 100) {
            buybackInvincibleUntil.set(robotId, Date.now() + 3000)
          }
          observedDeadRobotIds.delete(robotId)
        }
      }

      // 比赛开始时模拟器只发 GlobalUnitStatus；用已知车型上限补全血条。
      // 注意 RobotPosition 可能先创建了 maxHealth=600 的默认对象，必须按车型纠正。
      const maxByType: Record<number, number> = { 1: 600, 3: 400, 4: 400, 7: 600 }
      const typeMax = maxByType[robotId % 100]
      if (typeMax) {
        robot.maxHealth = Math.max(typeMax, hp)
        robot.hasStaticStatus = true
      }
      robot.currentHealth = hp
      robot.isAlive = hp > 0
    })

    // 协议中的 robot_bullets 只包含己方 1/2/3/4/7 号机器人，顺序与己方血量一致。
    const bulletRobotIds = getOwnGlobalUnitRobotIds()
    status.robotBullets.forEach((ammo, index) => {
      const robotId = bulletRobotIds[index]
      if (!robotId) return
      const robot = getOrCreateRobot(robotId, getRobotTeam(robotId))
      robot.remainingAmmo = ammo
      robot.hasAmmoStatus = true
    })

    mqttDebugLog('[MQTT] 全局单位状态更新:', status)
  }

  /**
   * 更新后勤状态
   */
  function updateLogisticsStatus(status: GlobalLogisticsStatus): void {
    logisticsStatus.value = status
    mqttDebugLog('[MQTT] 后勤状态更新:', status)
  }

  /**
   * 更新特殊机制
   */
  function updateSpecialMechanisms(mechanisms: GlobalSpecialMechanism): void {
    specialMechanisms.value = mechanisms
    mqttDebugLog('[MQTT] 特殊机制更新:', mechanisms)
  }

  /**
   * 添加事件
   */
  function addEvent(event: Event): void {
    eventHistory.value.unshift(event)
    if (eventHistory.value.length > MAX_EVENT_HISTORY) {
      eventHistory.value.pop()
    }

    // 2026 演示约定：前哨归属切换/重建由 Event 2 的 param 携带。
    // 例：outpost:red:blue:500 -> 红方位置前哨，当前归蓝方，血量 500。
    if (event.eventId === EventId.OUTPOST_DESTROYED && event.param.startsWith('outpost:')) {
      const [, position, owner, healthText] = event.param.split(':')
      if (position === 'red' || position === 'blue') {
        const ownerValue =
          owner === 'red' || owner === 'blue' || owner === 'neutral' ? owner : null
        if (ownerValue) setOutpostState(position, ownerValue, Number(healthText) || 0)
      }
    }

    // 空中系统演示状态：
    //   air:<机库数>:<READY,CHARGING,...>:<health,...>:<energy,...>
    // 兼容旧格式：air:READY,READY,CHARGING,CHARGING
    if (event.param.startsWith('air:')) {
      const parts = event.param.slice(4).split(':')
      const hasHangar = /^\d+$/.test(parts[0] ?? '')
      const hangar = hasHangar ? Number(parts[0]) : airHangarCount.value
      const statesPart = hasHangar ? (parts[1] ?? '') : (parts[0] ?? '')
      const healths = (hasHangar ? (parts[2] ?? '') : '').split(',').map(Number)
      const energies = (hasHangar ? (parts[3] ?? '') : '').split(',').map(Number)
      const states = statesPart.split(',')
      updateAirUnits(
        states.slice(0, 4).map((state, index) => ({
          state:
            state === 'READY' || state === 'CHARGING' || state === 'ACTIVE'
              ? state
              : 'READY',
          ...(Number.isFinite(healths[index]) ? { health: healths[index] } : {}),
          ...(Number.isFinite(energies[index]) ? { energy: energies[index] } : {})
        })),
        hangar
      )
    }

    // 地图已知坐标组：positions:1,4,3;3,6,5;...
    if (event.param.startsWith('positions:')) {
      for (const item of event.param.slice(10).split(';')) {
        const [idText, xText, yText] = item.split(',')
        const robotId = Number(idText)
        const x = Number(xText)
        const y = Number(yText)
        if (!Number.isInteger(robotId) || !Number.isFinite(x) || !Number.isFinite(y)) continue
        updateRobotPosition({ x, y, z: 0, yaw: 0, robotId } as RobotPosition, robotId)
      }
    }

    // 战场控制度演示：
    // control:redScore:blueScore:redRate:blueRate:redBaseOwner:redBaseState:blueBaseOwner:blueBaseState:redOutpostOwner:redOutpostState:blueOutpostOwner:blueOutpostState
    if (event.param.startsWith('control:')) {
      const [, redScore, blueScore, redRate, blueRate, rbOwner, rbState, bbOwner, bbState, roOwner, roState, boOwner, boState] =
        event.param.split(':')
      const owner = (value: string): ControlOwner =>
        value === 'red' || value === 'blue' || value === 'neutral' ? value : 'neutral'
      const state = (value: string): ControlState =>
        value === 'COMPLETE' || value === 'TEMPORARY' || value === 'NEUTRAL' ? value : 'NEUTRAL'
      updateBattleControl({
        redScore: Number(redScore),
        blueScore: Number(blueScore),
        redRate: Number(redRate),
        blueRate: Number(blueRate),
        redBase: { owner: owner(rbOwner), state: state(rbState) },
        blueBase: { owner: owner(bbOwner), state: state(bbState) },
        redOutpost: { owner: owner(roOwner), state: state(roState) },
        blueOutpost: { owner: owner(boOwner), state: state(boState) }
      })
    }

    if (event.eventId === EventId.ENEMY_DART_GATE_OPEN) {
      showDanger('飞镖告警', '敌方飞镖舱门已打开', 3000)
    }
    mqttDebugLog('[MQTT] 事件:', EventId[event.eventId], event.param)
  }

  /**
   * 更新机器人静态状态
   * 注意：机器人 ID 由服务器在此消息中提供，连接后以服务器 ID 作为当前机器人。
   */
  function updateRobotStaticStatus(status: RobotStaticStatus): void {
    selectCurrentRobotFromServerId(status.robotId)

    const robotId = Math.trunc(Number(status.robotId))
    if (robotId <= 0) return

    const team = getRobotTeam(robotId)
    const robot = getOrCreateRobot(robotId, team)

    // 连接和状态信息（服务器提供）
    robot.connectionState = status.connectionState
    robot.fieldState = status.fieldState
    robot.isAlive = status.aliveState === 1

    // 机器人基本信息（服务器提供）
    robot.robotType = status.robotType
    robot.level = status.level

    // 性能体系（服务器提供）
    robot.performanceSystemShooter = status.performanceSystemShooter
    robot.performanceSystemChassis = status.performanceSystemChassis

    // 最大值配置（服务器提供，不再从配置文件读取）
    robot.maxHealth = status.maxHealth
    robot.maxHeat = status.maxHeat
    robot.heatCooldownRate = status.heatCooldownRate
    robot.maxPower = status.maxPower
    robot.maxBufferEnergy = status.maxBufferEnergy
    robot.maxChassisEnergy = status.maxChassisEnergy
    robot.hasStaticStatus = true

    robot.lastUpdate = Date.now()

    mqttDebugLog(
      '[MQTT] 机器人静态状态更新 (ID:',
      robotId,
      ', 类型:',
      status.robotType,
      ', 等级:',
      status.level,
      ')'
    )
  }

  /**
   * 更新机器人动态状态
   */
  function updateRobotDynamicStatus(status: RobotDynamicStatus, robotId: number): void {
    const team = getRobotTeam(robotId)
    const robot = getOrCreateRobot(robotId, team)

    robot.currentHealth = status.currentHealth
    robot.currentHeat = status.currentHeat
    robot.currentChassisEnergy = status.currentChassisEnergy
    robot.currentBufferEnergy = status.currentBufferEnergy
    robot.remainingAmmo = status.remainingAmmo
    robot.hasAmmoStatus = true
    robot.currentExperience = status.currentExperience
    robot.experienceForUpgrade = status.experienceForUpgrade
    robot.isOutOfCombat = status.isOutOfCombat
    robot.outOfCombatCountdown = status.outOfCombatCountdown ?? 0
    robot.canRemoteHeal = status.canRemoteHeal ?? false
    robot.canRemoteAmmo = status.canRemoteAmmo ?? false
    robot.lastUpdate = Date.now()
  }

  /**
   * 更新机器人位置
   */
  function updateRobotPosition(position: RobotPosition, robotId: number): void {
    const team = getRobotTeam(robotId)
    const robot = getOrCreateRobot(robotId, team)

    robot.x = position.x
    robot.y = position.y
    robot.z = position.z
    robot.yaw = position.yaw
    robot.lastUpdate = Date.now()
  }

  /**
   * 更新机器人模块状态
   */
  function updateRobotModuleStatus(status: RobotModuleStatus, robotId: number): void {
    const team = getRobotTeam(robotId)
    const robot = getOrCreateRobot(robotId, team)

    robot.moduleStatus = status
    robot.lastUpdate = Date.now()
    mqttDebugLog(
      `[MQTT] 机器人模块状态更新 (ID: ${robotId}, 当前选中: ${currentRobotId.value})`,
      status
    )
  }

  /**
   * 更新机器人受伤统计
   */
  function updateRobotInjuryStat(stat: RobotInjuryStat, robotId: number): void {
    injuryStats.set(robotId, stat)
    mqttDebugLog('[MQTT] 机器人受伤统计:', robotId, stat)
  }

  /**
   * 更新机器人复活状态
   */
  function updateRobotRespawnStatus(status: RobotRespawnStatus, robotId: number): void {
    const team = getRobotTeam(robotId)
    const robot = getOrCreateRobot(robotId, team)

    robot.isPendingRespawn = status.isPendingRespawn
    respawnStatus.set(robotId, status)
  }

  /**
   * 添加或更新 Buff
   */
  function updateBuff(buff: Buff): void {
    // 查找是否已存在相同机器人和类型的 Buff
    const existingIndex = activeBuffs.value.findIndex(
      (b) => b.robotId === buff.robotId && b.buffType === buff.buffType
    )

    if (existingIndex >= 0) {
      // 更新现有 Buff
      activeBuffs.value[existingIndex] = buff
    } else {
      // 添加新 Buff
      activeBuffs.value.push(buff)
    }

    // 移除时间为 0 的 Buff
    activeBuffs.value = activeBuffs.value.filter((b) => b.buffLeftTime > 0)

    mqttDebugLog('[MQTT] Buff 更新:', BuffType[buff.buffType], buff)
  }

  /** 判罚倒计时定时器 */
  let penaltyCountdownTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 更新判罚信息
   * 支持多个判罚同时生效，按类型存储
   */
  function updatePenaltyInfo(penalty: PenaltyInfo): void {
    mqttDebugLog('[MQTT] 判罚:', PenaltyType[penalty.penaltyType], penalty)

    // 按类型存储判罚，更新或新增
    activePenalties.value.set(penalty.penaltyType, {
      ...penalty,
      startTime: Date.now()
    })

    // 启动全局倒计时（如果还没启动）
    if (!penaltyCountdownTimer) {
      penaltyCountdownTimer = setInterval(() => {
        let hasActive = false
        activePenalties.value.forEach((p, type) => {
          if (p.penaltyEffectSec > 0) {
            p.penaltyEffectSec -= 1
            hasActive = true
            if (p.penaltyEffectSec <= 0) {
              mqttDebugLog('[MQTT] 判罚倒计时结束:', PenaltyType[type])
              activePenalties.value.delete(type)
            }
          }
        })
        // 如果没有活动判罚，停止定时器
        if (!hasActive || activePenalties.value.size === 0) {
          if (penaltyCountdownTimer) {
            clearInterval(penaltyCountdownTimer)
            penaltyCountdownTimer = null
          }
        }
      }, 1000)
    }
  }

  /**
   * 更新雷达数据
   */
  function updateRadarData(data: RadarInfoToClient | RaderInfoToClient): void {
    if ('radarSingleRobotInfo' in data) {
      // 协议顺序固定为：对方 1/2/3/4/6/7，己方 1/2/3/4/6/7。
      const redIds = [1, 2, 3, 4, 6, 7]
      const blueIds = [101, 102, 103, 104, 106, 107]
      const ownIsBlue = currentRobotId.value >= 100
      const robotIds = ownIsBlue ? [...redIds, ...blueIds] : [...blueIds, ...redIds]
      radarDetections.value = data.radarSingleRobotInfo.map((robot, index) => ({
        ...robot,
        targetRobotId: robotIds[index] ?? 0
      }))
      return
    }

    // 查找是否已存在该机器人的雷达数据
    const existingIndex = radarDetections.value.findIndex(
      (r) => r.targetRobotId === data.targetRobotId
    )

    if (existingIndex >= 0) {
      radarDetections.value[existingIndex] = data
    } else {
      radarDetections.value.push(data)
    }
  }

  /**
   * 更新哨兵状态
   */
  function updateSentinelStatus(status: SentinelStatusSync): void {
    sentinelStatus.value = status
    mqttDebugLog('[MQTT] 哨兵状态:', SentinelPosture[status.postureId], status)
  }

  /**
   * 更新能量机关状态
   */
  function updateRuneStatus(status: RuneStatusSync): void {
    runeStatus.value = status
    mqttDebugLog('[MQTT] 能量机关状态:', RuneStatus[status.runeStatus], status)
  }

  /** 机器人配置缓存类型 */
  interface RobotConfigCacheType {
    robotTypes: Record<string, { customDataProto?: string }>
    robotMappings: Record<string, { type: string; team: string; number: number; id?: number }>
  }

  /** 机器人配置缓存 */
  let robotConfigCache: RobotConfigCacheType | null = null

  /** 当前加载的 Proto 配置 */
  let currentProtoConfig: { robotName: string; robotType: string; protoPath: string } | null = null

  /**
   * 预加载机器人 Proto 配置
   * @param robotName 机器人名称（如 "蓝方3号步兵"）
   */
  async function loadRobotProtoConfig(robotName: string): Promise<void> {
    console.log(`[MQTT] 开始加载机器人 Proto 配置: "${robotName}"`)

    // 1. 获取配置
    if (!robotConfigCache) {
      try {
        robotConfigCache = await window.api.getRobotConfig()
      } catch (e) {
        console.error('[MQTT] 获取机器人配置失败:', e)
        return
      }
    }

    if (!robotConfigCache) {
      console.error('[MQTT] 机器人配置缓存为空')
      return
    }

    // 2. 查找机器人映射
    const mapping = robotConfigCache.robotMappings[robotName]
    if (!mapping) {
      console.warn(`[MQTT] 未找到机器人 "${robotName}" 的配置映射`)
      currentProtoConfig = null
      return
    }

    const robotType = mapping.type

    // 3. 获取 Proto 路径
    const typeConfig = robotConfigCache.robotTypes[robotType]
    if (!typeConfig || !typeConfig.customDataProto) {
      console.warn(`[MQTT] 机器人类型 "${robotType}" 没有配置 customDataProto`)
      currentProtoConfig = null
      return
    }

    // 4. 保存配置
    currentProtoConfig = {
      robotName,
      robotType,
      protoPath: typeConfig.customDataProto
    }

    console.log(
      `[MQTT] Proto 配置加载成功: 机器人="${robotName}", 类型="${robotType}", 文件="${typeConfig.customDataProto}"`
    )
  }

  /**
   * 处理自定义数据块
   */
  function handleCustomByteBlock(data: CustomByteBlock, robotId: number): void {
    pendingCustomByteBlocks.set(robotId, data)
    if (!parsingCustomByteBlocks.has(robotId)) {
      void drainCustomByteBlock(robotId, customDataEpoch)
    }
  }

  async function drainCustomByteBlock(robotId: number, epoch: number): Promise<void> {
    parsingCustomByteBlocks.add(robotId)

    try {
      while (pendingCustomByteBlocks.has(robotId) && epoch === customDataEpoch) {
        const data = pendingCustomByteBlocks.get(robotId)
        pendingCustomByteBlocks.delete(robotId)
        if (data) {
          await parseCustomByteBlock(data, robotId, epoch)
        }
      }
    } finally {
      parsingCustomByteBlocks.delete(robotId)
      if (pendingCustomByteBlocks.has(robotId) && epoch === customDataEpoch) {
        void drainCustomByteBlock(robotId, epoch)
      }
    }
  }

  async function parseCustomByteBlock(
    data: CustomByteBlock,
    robotId: number,
    epoch: number
  ): Promise<void> {
    // data.data 可能是数组（bytes: Array）或 Uint8Array
    const rawData = data.data
    const dataLength = Array.isArray(rawData) ? rawData.length : (rawData?.length ?? 0)
    mqttDebugLog(
      `[MQTT] 收到 CustomByteBlock: Robot ID=${robotId}, 数据长度=${dataLength}, 类型=${typeof rawData}, isArray=${Array.isArray(rawData)}`
    )

    // 检查是否已加载 Proto 配置
    if (!currentProtoConfig) {
      console.warn('[MQTT] 未加载 Proto 配置，请先选择机器人')
      return
    }

    if (dataLength === 0) {
      console.warn('[MQTT] CustomByteBlock 数据为空')
      return
    }

    mqttDebugLog(
      `[MQTT] 使用预加载的 Proto 配置: 机器人="${currentProtoConfig.robotName}", 类型="${currentProtoConfig.robotType}", 文件="${currentProtoConfig.protoPath}"`
    )

    // 解析数据 - 确保转换为 Uint8Array
    try {
      const buffer = Array.isArray(rawData) ? new Uint8Array(rawData) : rawData
      const parsed = await window.api.parseCustomData(currentProtoConfig.protoPath, buffer)
      if (epoch !== customDataEpoch) return

      // 更新状态
      customData.set(robotId, parsed)
      mqttDebugLog(`[MQTT] CustomByteBlock 解析成功:`, parsed)
    } catch (e) {
      console.error(
        `[MQTT] 解析自定义数据失败 (Robot ${robotId}, Type ${currentProtoConfig.robotType}):`,
        e
      )
    }
  }

  /**
   * 通用消息处理
   */
  function handleMessage(topic: string, type: MessageType, data: unknown): void {
    mqttDebugLog(`[MQTT Store] 收到消息: topic=${topic}, type=${type}`)

    // 更新统计
    totalMessagesReceived++
    lastMessageTimestamp = Date.now()
    messagesThisSecond++

    if (mqttHistoryEnabled) {
      messageHistory.value.unshift({
        id: ++messageIdCounter,
        topic,
        type,
        timestamp: Date.now(),
        data
      })

      if (messageHistory.value.length > MAX_MESSAGE_HISTORY) {
        messageHistory.value.pop()
      }
    }

    // 根据类型分发处理
    switch (type) {
      case 'game_status':
        updateGameStatus(data as GameStatus)
        break
      case 'global_unit_status':
        updateGlobalUnitStatus(data as GlobalUnitStatus)
        break
      case 'global_logistics_status':
        updateLogisticsStatus(data as GlobalLogisticsStatus)
        break
      case 'global_special_mechanism':
        updateSpecialMechanisms(data as GlobalSpecialMechanism)
        break
      case 'event':
        addEvent(data as Event)
        break
      case 'robot_static_status':
        // RobotStaticStatus 消息自带 robotId，用于 ID 匹配检测
        updateRobotStaticStatus(data as RobotStaticStatus)
        break
      // ==================== 以下消息都是当前机器人的数据（一对一通信） ====================
      case 'robot_dynamic_status':
        if (currentRobotId.value > 0) {
          updateRobotDynamicStatus(data as RobotDynamicStatus, currentRobotId.value)
        }
        break
      case 'robot_position':
        {
          const position = data as RobotPosition
          const robotId = position.robotId > 0 ? position.robotId : currentRobotId.value
          if (robotId > 0) {
            updateRobotPosition(position, robotId)
          }
        }
        break
      case 'custom_byte_block':
        if (currentRobotId.value > 0) {
          handleCustomByteBlock(data as CustomByteBlock, currentRobotId.value)
        }
        break
      case 'robot_module_status':
        if (currentRobotId.value > 0) {
          updateRobotModuleStatus(data as RobotModuleStatus, currentRobotId.value)
        }
        break
      case 'robot_injury_stat':
        if (currentRobotId.value > 0) {
          updateRobotInjuryStat(data as RobotInjuryStat, currentRobotId.value)
        }
        break
      case 'robot_respawn_status':
        if (currentRobotId.value > 0) {
          updateRobotRespawnStatus(data as RobotRespawnStatus, currentRobotId.value)
        }
        break
      // ==================== 结束：当前机器人消息 ====================
      case 'buff':
        updateBuff(data as Buff)
        break
      case 'penalty_info':
        updatePenaltyInfo(data as PenaltyInfo)
        break
      case 'rader_info_to_client':
        updateRadarData(data as RadarInfoToClient)
        break
      case 'sentinel_status_sync':
        updateSentinelStatus(data as SentinelStatusSync)
        break
      case 'rune_status_sync':
        updateRuneStatus(data as RuneStatusSync)
        break
      default:
        mqttDebugLog('[MQTT] 未处理的消息类型:', type, topic)
    }
  }

  // ==================== 工具方法 ====================

  /**
   * 获取指定机器人数据
   */
  function getRobot(robotId: number): RobotData | undefined {
    const team = getRobotTeam(robotId)
    const robotMap = team === 'red' ? redRobots : blueRobots
    return robotMap.get(robotId)
  }

  /**
   * 获取机器人受伤统计
   */
  function getRobotInjuryStat(robotId: number): RobotInjuryStat | undefined {
    return injuryStats.get(robotId)
  }

  /**
   * 获取机器人复活状态
   */
  function getRobotRespawnStatus(robotId: number): RobotRespawnStatus | undefined {
    return respawnStatus.get(robotId)
  }

  /**
   * 清空所有数据
   */
  function clearAll(): void {
    // 重置比赛状态
    gameStatus.value = {
      currentRound: 1,
      totalRounds: 3,
      redScore: 0,
      blueScore: 0,
      currentStage: CurrentStage.NOT_STARTED,
      stageCountdownSec: 0,
      stageElapsedSec: 0,
      isPaused: false,
      gameResult: 255,
      endReason: 255
    }

    // 重置全局状态
    globalUnitStatus.value = {
      baseHealth: 10000,
      baseStatus: BaseStatus.INVINCIBLE,
      baseShield: 10000,
      outpostHealth: 1000,
      outpostStatus: OutpostStatus.INVINCIBLE,
      enemyBaseHealth: 10000,
      enemyBaseStatus: BaseStatus.INVINCIBLE,
      enemyBaseShield: 10000,
      enemyOutpostHealth: 1000,
      enemyOutpostStatus: OutpostStatus.INVINCIBLE,
      robotHealth: [],
      robotBullets: [],
      totalDamageAlly: 0,
      totalDamageEnemy: 0,
      totalDamageRed: 0,
      totalDamageBlue: 0
    }

    redOutpost.owner = 'red'
    redOutpost.health = 1000
    redOutpost.maxHealth = 1000
    redOutpost.status = OutpostStatus.INVINCIBLE
    blueOutpost.owner = 'blue'
    blueOutpost.health = 1000
    blueOutpost.maxHealth = 1000
    blueOutpost.status = OutpostStatus.INVINCIBLE
    // 空中状态不在客户端重置，等待模拟器重新发送 air 事件。
    airHangarCount.value = 0
    airUnits.value = []
    resetBattleControl()

    // 清空机器人数据
    redRobots.clear()
    blueRobots.clear()
    injuryStats.clear()
    respawnStatus.clear()
    buybackInvincibleUntil.clear()
    observedDeadRobotIds.clear()

    // 清空其他数据
    activeBuffs.value = []
    activePenalties.value.clear()
    radarDetections.value = []
    eventHistory.value = []
    messageHistory.value = []

    // 重置连接状态
    connectionStats.value.totalMessages = 0
    connectionStats.value.messagesPerSecond = 0
    totalMessagesReceived = 0
    lastMessageTimestamp = 0

    console.log('[MQTT] 已清空所有数据')
  }

  /**
   * 启动 MPS 统计
   */
  function startMpsCounter(): void {
    if (mpsTimer) return

    mpsTimer = setInterval(() => {
      connectionStats.value.totalMessages = totalMessagesReceived
      connectionStats.value.lastMessageTime = lastMessageTimestamp
      connectionStats.value.messagesPerSecond = messagesThisSecond
      messagesThisSecond = 0

      // 更新 Buff 剩余时间（简单递减，实际应由服务器更新）
      activeBuffs.value = activeBuffs.value
        .map((buff) => ({
          ...buff,
          buffLeftTime: Math.max(0, buff.buffLeftTime - 1)
        }))
        .filter((buff) => buff.buffLeftTime > 0)
    }, 1000)
  }

  /**
   * 停止 MPS 统计
   */
  function stopMpsCounter(): void {
    if (mpsTimer) {
      clearInterval(mpsTimer)
      mpsTimer = null
    }
  }

  /**
   * 设置连接状态
   */
  function setConnectionStatus(connected: boolean): void {
    connectionStats.value.isConnected = connected
    if (connected) {
      startMpsCounter()
    } else {
      stopMpsCounter()
      serverSelectedRobotId.value = 0
      dismissIdMismatchWarning()
    }
  }

  // ==================== 返回 ====================

  return {
    // 比赛状态
    gameStatus,
    globalUnitStatus,
    logisticsStatus,
    specialMechanisms,

    // 机器人数据
    redRobots,
    blueRobots,
    injuryStats,
    respawnStatus,
    buybackInvincibleUntil,
    customData,

    // Buff 和判罚
    activeBuffs,
    activePenalties,
    penaltyInfo, // 兼容旧 API

    // 雷达和地图
    radarDetections,

    // 特殊单位
    sentinelStatus,
    runeStatus,

    // 前哨站（位置与归属分开）与空中系统
    redOutpost,
    blueOutpost,
    setOutpostState,
    airHangarCount,
    airUnits,
    airReadyCount,
    airSystemStatus,
    updateAirUnits,
    battleControl,
    controlDiff,
    updateBattleControl,
    resetBattleControl,

    // 事件和消息
    eventHistory,
    messageHistory,

    // 连接状态
    connectionStats,

    // 计算属性
    gameStageName,
    isGameRunning,
    baseStatusName,
    outpostStatusName,
    redRobotList,
    blueRobotList,
    allRobots,
    aliveRedCount,
    aliveBlueCount,
    redTotalHealth,
    blueTotalHealth,
    redHealthPercentage,
    blueHealthPercentage,
    activeBuffCount,
    recentEvents,

    // 方法
    handleMessage,
    getRobot,
    getRobotInjuryStat,
    getRobotRespawnStatus,
    clearAll,
    setConnectionStatus,
    startMpsCounter,
    stopMpsCounter,
    loadRobotProtoConfig,
    updateCurrentRobotType,
    loadRobotIdMappings,
    clearAllRobotData,
    checkRobotIdMatch,
    selectCurrentRobotFromServerId,

    // 当前机器人状态
    currentRobotType,
    currentRobotId,
    serverSelectedRobotId,
    idMismatchWarned
  }
})
