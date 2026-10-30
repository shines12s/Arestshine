import path from 'node:path'
import { fileURLToPath } from 'node:url'

import protobuf from 'protobufjs'

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROTO_PATH = path.resolve(CURRENT_DIR, '../proto/messages.proto')

export const UPLINK_TOPICS = new Set([
  'KeyboardMouseControl',
  'CustomControl',
  'MapClickCmd',
  'AssemblyCommand',
  'RobotPerformanceSelectionCommand',
  'CommonCommand',
  'HeroDeployModeEventCommand',
  'RuneActivateCommand',
  'DartCommand',
  'SentryCtrlCommand',
  'AirSupportCommand'
])

const NON_TOPIC_MESSAGES = new Set(['RadarSingleRobotInfo'])

export const OFFICIAL_FREQUENCY_HZ = Object.freeze({
  KeyboardMouseControl: 75,
  CustomControl: 75,
  GameStatus: 5,
  GlobalUnitStatus: 1,
  GlobalLogisticsStatus: 1,
  GlobalSpecialMechanism: 1,
  RobotInjuryStat: 1,
  RobotRespawnStatus: 1,
  RobotStaticStatus: 1,
  RobotDynamicStatus: 10,
  RobotModuleStatus: 1,
  RobotPosition: 1,
  Buff: 1,
  CustomByteBlock: 50,
  TechCoreMotionStateSync: 1,
  RobotPerformanceSelectionSync: 1,
  DeployModeStatusSync: 1,
  RuneStatusSync: 1,
  SentryStatusSync: 1,
  DartSelectTargetStatusSync: 1,
  AirSupportStatusSync: 1
})

const TRIGGERED_TOPICS = new Set([
  'Event',
  'Buff',
  'PenaltyInfo',
  'RobotPathPlanInfo',
  'MapClickInfo',
  'MapClickCmd',
  'RadarInfoToClient',
  'AssemblyCommand',
  'RobotPerformanceSelectionCommand',
  'CommonCommand',
  'HeroDeployModeEventCommand',
  'RuneActivateCommand',
  'DartCommand',
  'SentryCtrlCommand',
  'SentryCtrlResult',
  'AirSupportCommand'
])

export const RECOMMENDED_SCENARIO_TOPICS = Object.freeze([
  'GameStatus',
  'GlobalUnitStatus',
  'GlobalLogisticsStatus',
  'RobotStaticStatus',
  'RobotDynamicStatus',
  'RobotModuleStatus',
  'RobotPosition',
  'SentryStatusSync'
])

const PRESET_OVERRIDES = Object.freeze({
  GameStatus: {
    currentRound: 1,
    totalRounds: 3,
    redScore: 0,
    blueScore: 0,
    currentStage: 4,
    stageCountdownSec: 420,
    stageElapsedSec: 0,
    isPaused: false,
    gameResult: 255,
    endReason: 255
  },
  GlobalUnitStatus: {
    baseHealth: 10000,
    baseStatus: 0,
    baseShield: 10000,
    outpostHealth: 1000,
    outpostStatus: 0,
    enemyBaseHealth: 10000,
    enemyBaseStatus: 0,
    enemyBaseShield: 10000,
    enemyOutpostHealth: 1000,
    enemyOutpostStatus: 0,
    // 顺序：己方 1/3/4/7 + 敌方 1/3/4/7；比赛开始时双方全满。
    robotHealth: [600, 400, 400, 600, 600, 400, 400, 600],
    robotBullets: [100, 100, 100, 100, 100, 100, 100, 100],
    totalDamageAlly: 0,
    totalDamageEnemy: 0
  },
  GlobalLogisticsStatus: {
    remainingEconomy: 300,
    totalEconomyObtained: '300',
    techLevel: 1,
    encryptionLevel: 1
  },
  GlobalSpecialMechanism: {
    mechanismId: [],
    mechanismTimeSec: []
  },
  Event: {
    eventId: 1,
    param: 'local simulator event'
  },
  RobotRespawnStatus: {
    isPendingRespawn: false,
    totalRespawnProgress: 10,
    currentRespawnProgress: 0,
    canFreeRespawn: false,
    goldCostForRespawn: 200,
    canPayForRespawn: true
  },
  RobotStaticStatus: {
    connectionState: 1,
    fieldState: 1,
    aliveState: 1,
    robotId: 1,
    robotType: 3,
    performanceSystemShooter: 1,
    performanceSystemChassis: 1,
    level: 1,
    maxHealth: 600,
    maxHeat: 200,
    heatCooldownRate: 20,
    maxPower: 80,
    maxBufferEnergy: 60,
    maxChassisEnergy: 100
  },
  RobotDynamicStatus: {
    currentHealth: 600,
    currentHeat: 30,
    lastProjectileFireRate: 0,
    currentChassisEnergy: 100,
    currentBufferEnergy: 60,
    currentExperience: 0,
    experienceForUpgrade: 100,
    totalProjectilesFired: 0,
    remainingAmmo: 100,
    isOutOfCombat: false,
    outOfCombatCountdown: 0,
    canRemoteHeal: true,
    canRemoteAmmo: true
  },
  RobotModuleStatus: {
    powerManager: 1,
    rfid: 1,
    lightStrip: 1,
    smallShooter: 1,
    bigShooter: 1,
    uwb: 1,
    armor: 1,
    videoTransmission: 1,
    capacitor: 1,
    mainController: 1,
    laserDetectionModule: 1
  },
  RobotPosition: {
    x: 14.2,
    y: 7.5,
    z: 0,
    yaw: 0,
    robotId: 1
  },
  Buff: {
    robotId: 1,
    buffType: 1,
    buffLevel: 1,
    buffMaxTime: 30,
    buffLeftTime: 30
  },
  PenaltyInfo: {
    penaltyType: 1,
    penaltyEffectSec: 10,
    totalPenaltyNum: 1
  },
  RobotPathPlanInfo: {
    intention: 1,
    startPosX: 1420,
    startPosY: 750,
    offsetX: [10, 10, 0],
    offsetY: [0, 10, 10],
    senderId: 1
  },
  RadarInfoToClient: {
    RadarSingleRobotInfo: [
      { targetPosX: 1200, targetPosY: 600, isHighLight: 1 },
      { targetPosX: 1600, targetPosY: 900, isHighLight: 0 }
    ]
  },
  CustomByteBlock: {
    // 150 字节演示数据，供 CustomData 页面显示原始内容。
    data: Buffer.from(Array.from({ length: 150 }, (_, index) => index & 0xff)).toString('base64')
  },
  TechCoreMotionStateSync: {
    maximumDifficultyLevel: 3,
    basicState: 1,
    putinState: 0,
    moveState: 0,
    rotateState: 0,
    enemyCoreStatus: 0,
    remainTimeAll: 60,
    remainTimeStep: 10
  },
  RobotPerformanceSelectionSync: {
    shooter: 1,
    chassis: 1,
    sentryControl: 0
  },
  DeployModeStatusSync: { status: 0 },
  RuneStatusSync: { runeStatus: 1, activatedArms: 0, averageRings: 0 },
  SentryStatusSync: { postureId: 3, isWeakened: false, isPowered: false },
  DartSelectTargetStatusSync: { targetId: 1, open: 0 },
  SentryCtrlResult: { commandId: 1, resultCode: 0 },
  AirSupportStatusSync: {
    airsupportStatus: 0,
    leftTime: 0,
    costCoins: 0,
    isBeingTargeted: 0,
    shooterStatus: 1
  }
})

const PRESET_ID_FIELDS = Object.freeze({
  RobotStaticStatus: 'robotId',
  RobotPosition: 'robotId',
  Buff: 'robotId',
  RobotPathPlanInfo: 'senderId'
})

function scalarSample(field) {
  if (field.repeated) return []

  switch (field.type) {
    case 'bool':
      return false
    case 'string':
      return ''
    case 'bytes':
      return ''
    case 'float':
    case 'double':
    case 'int32':
    case 'sint32':
    case 'sfixed32':
    case 'uint32':
    case 'fixed32':
      return 0
    case 'int64':
    case 'sint64':
    case 'sfixed64':
    case 'uint64':
    case 'fixed64':
      return '0'
    default:
      return null
  }
}

function createSample(type, stack = new Set()) {
  if (stack.has(type.fullName)) return {}
  const nextStack = new Set(stack).add(type.fullName)
  const sample = {}

  for (const field of type.fieldsArray) {
    if (field.resolvedType && field.resolvedType.fieldsArray) {
      const nested = createSample(field.resolvedType, nextStack)
      sample[field.name] = field.repeated ? [nested] : nested
      continue
    }
    sample[field.name] = scalarSample(field)
  }
  return sample
}

function describeField(field) {
  return {
    name: field.name,
    id: field.id,
    type: field.resolvedType?.name ?? field.type,
    repeated: field.repeated,
    optional: field.optional
  }
}

export class ProtocolRegistry {
  constructor(root, protoPath, { robotId = 1 } = {}) {
    this.root = root
    this.protoPath = protoPath
    this.robotId = robotId
    this.package = root.lookup('robomaster')
    this.types = new Map()

    for (const value of Object.values(this.package.nested ?? {})) {
      if (!(value instanceof protobuf.Type) || NON_TOPIC_MESSAGES.has(value.name)) continue
      this.types.set(value.name, value)
    }
  }

  static async load(protoPath = process.env.SIMULATOR_PROTO_PATH || DEFAULT_PROTO_PATH, options = {}) {
    const root = await protobuf.load(protoPath)
    root.resolveAll()
    return new ProtocolRegistry(root, protoPath, options)
  }

  hasTopic(topic) {
    return this.types.has(topic)
  }

  getType(topic) {
    const type = this.types.get(topic)
    if (!type) throw new Error(`未知 MQTT topic：${topic}`)
    return type
  }

  createPreset(topic) {
    const type = this.getType(topic)
    const preset = structuredClone(PRESET_OVERRIDES[topic] ?? createSample(type))
    const idField = PRESET_ID_FIELDS[topic]
    if (idField) preset[idField] = this.robotId

    // 2026 阵容血量上限：3/4 号步兵 400，其余地面机器人 600。
    const baseId = this.robotId % 100
    const maxHealth = baseId === 3 || baseId === 4 ? 400 : 600
    if (topic === 'RobotStaticStatus') {
      preset.maxHealth = maxHealth
    } else if (topic === 'RobotDynamicStatus') {
      preset.currentHealth = maxHealth
    }
    return preset
  }

  describe() {
    return [...this.types.entries()]
      .map(([name, type]) => ({
        name,
        direction: UPLINK_TOPICS.has(name) ? 'client-to-server' : 'server-to-client',
        officialFrequencyHz: OFFICIAL_FREQUENCY_HZ[name] ?? null,
        triggered: TRIGGERED_TOPICS.has(name),
        frequencyDescription:
          name === 'Buff'
            ? '获得时触发，随后 1Hz'
            : TRIGGERED_TOPICS.has(name)
              ? '触发式'
              : `${OFFICIAL_FREQUENCY_HZ[name]} Hz`,
        recommended: RECOMMENDED_SCENARIO_TOPICS.includes(name),
        fields: type.fieldsArray.map(describeField),
        preset: this.createPreset(name)
      }))
      .sort((a, b) => {
        if (a.direction !== b.direction) return a.direction.localeCompare(b.direction)
        return a.name.localeCompare(b.name)
      })
  }

  encode(topic, payload) {
    const type = this.getType(topic)
    let message
    try {
      message = type.fromObject(payload)
    } catch (error) {
      throw new Error(`${topic} 数据无法转换为 Protobuf：${error.message}`)
    }
    const verificationError = type.verify(message)
    if (verificationError) throw new Error(`${topic} 数据不符合 Protobuf：${verificationError}`)
    return Buffer.from(type.encode(message).finish())
  }

  decode(topic, payload) {
    const type = this.getType(topic)
    const decoded = type.decode(payload)
    return type.toObject(decoded, {
      longs: String,
      enums: String,
      bytes: String,
      defaults: true,
      arrays: true,
      objects: true
    })
  }
}
