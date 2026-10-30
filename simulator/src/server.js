import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { loadConfig, saveConfig, SIMULATOR_DIR } from './config.js'
import { MockMqttBroker } from './mqtt-broker.js'
import {
  OFFICIAL_FREQUENCY_HZ,
  ProtocolRegistry,
  RECOMMENDED_SCENARIO_TOPICS
} from './protocol.js'
import { VideoSender } from './video-sender.js'

const PUBLIC_DIR = path.join(SIMULATOR_DIR, 'public')
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_LOG_ENTRIES = 300

class EventStream {
  constructor() {
    this.clients = new Set()
  }

  add(response) {
    this.clients.add(response)
    response.write(': connected\n\n')
    return () => this.clients.delete(response)
  }

  send(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const response of this.clients) {
      try {
        response.write(chunk)
      } catch {
        this.clients.delete(response)
      }
    }
  }

  close() {
    for (const response of this.clients) response.end()
    this.clients.clear()
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  response.end(body)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw new Error('请求体超过 2 MiB 限制')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function contentType(filePath) {
  switch (path.extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

function serveStatic(requestPath, response) {
  const requested = requestPath === '/' ? 'index.html' : decodeURIComponent(requestPath.slice(1))
  const filePath = path.resolve(PUBLIC_DIR, requested)
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) || !fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    json(response, 404, { success: false, error: 'Not found' })
    return
  }
  const body = fs.readFileSync(filePath)
  response.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Content-Length': body.length,
    'Cache-Control': 'no-cache'
  })
  response.end(body)
}

function portNumber(value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} 必须是 1 到 65535 的整数`)
  }
  return parsed
}

function numberInRange(value, name, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须在 ${min} 到 ${max} 之间`)
  }
  return parsed
}

function mergeVideoConfig(base, body) {
  return {
    videoPath: String(body.videoPath ?? base.videoPath),
    loop: Boolean(body.loop ?? base.loop),
    startOnLaunch: Boolean(body.startOnLaunch ?? base.startOnLaunch),
    targetHost: String(body.targetHost ?? base.targetHost),
    targetPort: portNumber(body.targetPort ?? base.targetPort, 'targetPort'),
    width: numberInRange(body.width ?? base.width, 'width', 160, 7680),
    height: numberInRange(body.height ?? base.height, 'height', 120, 4320),
    fps: numberInRange(body.fps ?? base.fps, 'fps', 1, 120),
    bitrateKbps: numberInRange(body.bitrateKbps ?? base.bitrateKbps, 'bitrateKbps', 100, 100000),
    gop: numberInRange(body.gop ?? base.gop, 'gop', 1, 600),
    fragmentPayloadBytes: numberInRange(
      body.fragmentPayloadBytes ?? base.fragmentPayloadBytes,
      'fragmentPayloadBytes',
      1,
      1392
    ),
    packetLossPercent: numberInRange(
      body.packetLossPercent ?? base.packetLossPercent,
      'packetLossPercent',
      0,
      100
    )
  }
}

function openBrowser(url) {
  if (process.env.NO_BROWSER === '1') return
  let command
  let args
  if (process.platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (process.platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return
    command = 'xdg-open'
    args = [url]
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

async function main() {
  let config = loadConfig()
  process.env.SIMULATOR_PROTO_PATH = config.protocol.protoFile

  const protocol = await ProtocolRegistry.load(config.protocol.protoFile, { robotId: config.protocol.robotId })
  const broker = new MockMqttBroker({ protocol })
  const video = new VideoSender()
  const events = new EventStream()
  const schedules = new Map()
  const defaultAirUnits = () => [
    { id: 'AIR-01', state: 'READY', health: 100, energy: 100 },
    { id: 'AIR-02', state: 'READY', health: 100, energy: 84 },
    { id: 'AIR-03', state: 'CHARGING', health: 100, energy: 42 },
    { id: 'AIR-04', state: 'CHARGING', health: 100, energy: 18 }
  ]
  const airState = {
    hangarCount: 4,
    units: defaultAirUnits()
  }
  const defaultControlPositions = () => ({
    redBase: { owner: 'red', state: 'COMPLETE' },
    blueBase: { owner: 'blue', state: 'COMPLETE' },
    redOutpost: { owner: 'red', state: 'COMPLETE' },
    blueOutpost: { owner: 'blue', state: 'COMPLETE' }
  })
  const controlState = {
    redScore: 0,
    blueScore: 0,
    positions: defaultControlPositions()
  }
  let controlTimer = null
  const motionState = {
    enabled: true,
    robotId: 3,
    baseX: 14.2,
    baseY: 7.5,
    radiusX: 5.5,
    radiusY: 3.2,
    speed: 1.0,
    phase: 0
  }
  let motionTimer = null
  const motionRobots = [
    { id: 1, enabled: true, speed: 0.52, direction: 1, baseX: 5.2, baseY: 4.0, radiusX: 1.8, radiusY: 1.2, phase: 0.0 },
    { id: 3, enabled: true, speed: 0.47, direction: -1, baseX: 8.0, baseY: 7.2, radiusX: 2.0, radiusY: 1.4, phase: 1.1 },
    { id: 4, enabled: true, speed: 0.61, direction: 1, baseX: 10.5, baseY: 5.2, radiusX: 1.6, radiusY: 1.1, phase: 2.2 },
    { id: 7, enabled: true, speed: 0.38, direction: -1, baseX: 12.5, baseY: 9.0, radiusX: 2.2, radiusY: 1.2, phase: 3.3 },
    { id: 101, enabled: true, speed: 0.44, direction: 1, baseX: 22.8, baseY: 11.0, radiusX: 1.8, radiusY: 1.2, phase: 4.2 },
    { id: 103, enabled: true, speed: 0.58, direction: -1, baseX: 20.0, baseY: 7.8, radiusX: 2.0, radiusY: 1.3, phase: 5.1 },
    { id: 104, enabled: true, speed: 0.35, direction: 1, baseX: 17.5, baseY: 10.2, radiusX: 1.7, radiusY: 1.1, phase: 6.0 },
    { id: 107, enabled: true, speed: 0.66, direction: -1, baseX: 15.5, baseY: 5.6, radiusX: 2.0, radiusY: 1.2, phase: 7.1 }
  ]
  const logs = []
  const lastMessageLogAt = new Map()
  let logSequence = 0

  const addLog = ({ level = 'info', source = 'SYSTEM', message, details = null }) => {
    const entry = {
      id: ++logSequence,
      time: new Date().toISOString(),
      level,
      source,
      message,
      details
    }
    logs.push(entry)
    if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES)
    events.send('log', entry)
    const consoleMethod = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log
    consoleMethod(`[${entry.source}] ${entry.message}`)
    return entry
  }

  const broadcastState = () => events.send('state', getState())

  const getState = () => ({
    broker: broker.state,
    video: video.state,
    air: airState,
    control: controlState,
    motion: {
      ...motionState,
      robots: motionRobots.map(({ id, enabled, speed, direction, baseX, baseY, phase }) => ({
        id,
        enabled,
        speed,
        direction,
        baseX,
        baseY,
        phase
      }))
    },
    schedules: [...schedules.values()].map(({ timer: _timer, ...entry }) => entry),
    config: {
      configPath: config.configPath,
      expectedClientId: config.mqtt.expectedClientId,
      mqtt: config.mqtt,
      udpVideo: config.udpVideo,
      protocolFile: config.protocol.protoFile,
      robotId: config.protocol.robotId
    }
  })

  broker.on('log', addLog)
  broker.on('state', broadcastState)
  broker.on('client-change', (state) => {
    const expected = config.mqtt.expectedClientId.trim()
    if (expected) {
      for (const clientId of state.clients) {
        if (clientId !== expected) {
          addLog({
            level: 'warning',
            source: 'MQTT',
            message: `Client ID 为 ${clientId}，正式协议配置期望机器人 ID ${expected}`
          })
        }
      }
    }
    broadcastState()
  })
  broker.on('message', (entry) => {
    const key = `${entry.clientId}:${entry.topic}`
    const now = Date.now()
    // v2：下行状态流频率很高（10Hz/5Hz），日志只保留 5 秒一次的采样，
    // 上行控制指令保留 500ms，避免 GUI 日志被刷屏。
    const interval = entry.direction === 'client-to-server' ? 500 : 5000
    if (now - (lastMessageLogAt.get(key) ?? 0) < interval) return
    lastMessageLogAt.set(key, now)
    addLog({
      level: entry.decodeError ? 'error' : 'data',
      source: entry.direction === 'client-to-server' ? 'MQTT ↑' : 'MQTT ↓',
      message: `${entry.topic} · ${entry.bytes} B · QoS ${entry.qos} · ${entry.clientId}`,
      details: entry.decoded ?? { decodeError: entry.decodeError, rawHex: entry.rawHex }
    })
  })
  video.on('log', addLog)
  video.on('state', broadcastState)
  video.on('stats', (stats) => events.send('video-stats', stats))

  const startSchedule = async ({ topic, payload, frequencyHz, qos = config.mqtt.qos }) => {
    if (!protocol.hasTopic(topic)) throw new Error(`未知 topic：${topic}`)
    const hz = numberInRange(frequencyHz, 'frequencyHz', 0.1, 100)
    const selectedQos = numberInRange(qos, 'qos', 0, 1)
    const encodedCheck = protocol.encode(topic, payload)
    if (!encodedCheck.length && Object.keys(payload).length) {
      throw new Error(`${topic} 编码为空，请检查字段名`)
    }

    const existing = schedules.get(topic)
    if (existing) clearInterval(existing.timer)

    const publish = async () => {
      // 发布端短暂断线时跳过，等待 mqtt.js 自动重连；避免日志洪水。
      if (!broker.running) return
      try {
        await broker.publish(topic, payload, { qos: selectedQos })
      } catch (error) {
        addLog({ level: 'error', source: 'MQTT', message: `${topic} 定时发送失败：${error.message}` })
      }
    }
    await publish()
    const timer = setInterval(publish, Math.max(10, Math.round(1000 / hz)))
    schedules.set(topic, {
      topic,
      payload,
      frequencyHz: hz,
      qos: selectedQos,
      startedAt: new Date().toISOString(),
      timer
    })
    addLog({ level: 'success', source: 'MQTT', message: `${topic} 已开始按 ${hz} Hz 发送` })
    broadcastState()
  }

  const stopSchedule = (topic) => {
    const entry = schedules.get(topic)
    if (!entry) return false
    clearInterval(entry.timer)
    schedules.delete(topic)
    addLog({ level: 'info', source: 'MQTT', message: `${topic} 定时发送已停止` })
    broadcastState()
    return true
  }

  const stopAllSchedules = () => {
    stopControlLoop()
    stopMotionLoop()
    for (const entry of schedules.values()) clearInterval(entry.timer)
    schedules.clear()
    addLog({ level: 'info', source: 'MQTT', message: '所有定时消息已停止' })
    broadcastState()
  }

  // ==================== 2026 基地/前哨演示 ====================
  // 自动场景里的 GlobalUnitStatus 是普通对象；演示按钮通过“替换调度 payload”
  // 让后续 1Hz 帧持续发布新的血量/归属，而不是只发一次就被覆盖。
  function currentGlobalUnitPayload() {
    return schedules.get('GlobalUnitStatus')?.payload || protocol.createPreset('GlobalUnitStatus')
  }

  async function replaceGlobalUnitSchedule(patch, logMessage) {
    const payload = { ...currentGlobalUnitPayload(), ...patch }
    await startSchedule({
      topic: 'GlobalUnitStatus',
      payload,
      frequencyHz: OFFICIAL_FREQUENCY_HZ.GlobalUnitStatus ?? 1,
      qos: config.mqtt.qos
    })
    if (logMessage) addLog({ level: 'success', source: 'DEMO', message: logMessage })
    return payload
  }

  function airStateParam() {
    const states = airState.units.map((unit) => unit.state).join(',')
    const healths = airState.units.map((unit) => unit.health).join(',')
    const energies = airState.units.map((unit) => unit.energy).join(',')
    // air:<hangar>:<states>:<healths>:<energies>；状态是演示数据，不是官方 robot_id。
    return `air:${airState.hangarCount}:${states}:${healths}:${energies}`
  }

  async function replaceAirSchedule(logMessage = '') {
    await startSchedule({
      topic: 'Event',
      payload: { eventId: 0, param: airStateParam() },
      frequencyHz: 0.5,
      qos: config.mqtt.qos
    })
    if (logMessage) addLog({ level: 'success', source: 'DEMO', message: logMessage })
    return { hangarCount: airState.hangarCount, units: airState.units }
  }

  function applyAirState(body) {
    const nextHangar = Number(body.hangarCount)
    if (Number.isFinite(nextHangar)) {
      airState.hangarCount = Math.max(0, Math.min(8, Math.round(nextHangar)))
    }
    if (Array.isArray(body.units)) {
      airState.units = airState.units.map((unit, index) => {
        const input = body.units[index]
        if (!input) return unit
        const state = String(input.state ?? unit.state).toUpperCase()
        return {
          ...unit,
          state: ['READY', 'CHARGING', 'ACTIVE'].includes(state) ? state : unit.state,
          health: Math.max(0, Math.min(100, Number(input.health ?? unit.health))),
          energy: Math.max(0, Math.min(100, Number(input.energy ?? unit.energy)))
        }
      })
    }
    return airState
  }

  function controlRates() {
    const p = controlState.positions
    const redOutposts =
      p.redOutpost.owner === 'red' &&
      p.blueOutpost.owner === 'red' &&
      p.redOutpost.state !== 'NEUTRAL' &&
      p.blueOutpost.state !== 'NEUTRAL'
    const blueOutposts =
      p.redOutpost.owner === 'blue' &&
      p.blueOutpost.owner === 'blue' &&
      p.redOutpost.state !== 'NEUTRAL' &&
      p.blueOutpost.state !== 'NEUTRAL'
    const redBases =
      p.redBase.owner === 'red' &&
      p.blueBase.owner === 'red' &&
      p.redBase.state !== 'NEUTRAL' &&
      p.blueBase.state !== 'NEUTRAL'
    const blueBases =
      p.redBase.owner === 'blue' &&
      p.blueBase.owner === 'blue' &&
      p.redBase.state !== 'NEUTRAL' &&
      p.blueBase.state !== 'NEUTRAL'
    return {
      red: (redOutposts ? 1 : 0) + (redBases ? 3 : 0),
      blue: (blueOutposts ? 1 : 0) + (blueBases ? 3 : 0),
      redOutposts,
      blueOutposts,
      redBases,
      blueBases
    }
  }

  function controlParam() {
    const rates = controlRates()
    const p = controlState.positions
    const fields = [
      controlState.redScore,
      controlState.blueScore,
      rates.red,
      rates.blue,
      p.redBase.owner,
      p.redBase.state,
      p.blueBase.owner,
      p.blueBase.state,
      p.redOutpost.owner,
      p.redOutpost.state,
      p.blueOutpost.owner,
      p.blueOutpost.state
    ]
    return `control:${fields.join(':')}`
  }

  async function publishControlEvent() {
    if (!broker.running) return
    try {
      await broker.publish(
        'Event',
        { eventId: 0, param: controlParam() },
        { qos: config.mqtt.qos }
      )
    } catch (error) {
      addLog({ level: 'error', source: 'MQTT', message: `控制度状态发送失败：${error.message}` })
    }
  }

  function stopControlLoop() {
    if (controlTimer) clearInterval(controlTimer)
    controlTimer = null
  }

  async function startControlLoop() {
    stopControlLoop()
    const tick = async () => {
      const rates = controlRates()
      controlState.redScore += rates.red
      controlState.blueScore += rates.blue
      await publishControlEvent()
      broadcastState()
    }
    await tick()
    controlTimer = setInterval(() => {
      void tick()
    }, 1000)
  }

  function applyControlState(body) {
    if (body.reset === true) {
      controlState.redScore = 0
      controlState.blueScore = 0
      controlState.positions = defaultControlPositions()
      return controlState
    }
    if (body.positions && typeof body.positions === 'object') {
      for (const key of ['redBase', 'blueBase', 'redOutpost', 'blueOutpost']) {
        const next = body.positions[key]
        if (!next) continue
        const owner = ['red', 'blue', 'neutral'].includes(next.owner)
          ? next.owner
          : controlState.positions[key].owner
        const state = ['COMPLETE', 'TEMPORARY', 'NEUTRAL'].includes(next.state)
          ? next.state
          : controlState.positions[key].state
        controlState.positions[key] = { owner, state }
      }
    }
    if (Number.isFinite(Number(body.redScore))) controlState.redScore = Math.max(0, Number(body.redScore))
    if (Number.isFinite(Number(body.blueScore))) controlState.blueScore = Math.max(0, Number(body.blueScore))
    return controlState
  }

  async function demoPositionsAction(body) {
    motionState.enabled = false
    stopMotionLoop()
    const known =
      Array.isArray(body.positions) && body.positions.length
        ? body.positions
        : [
            { robotId: 1, x: 4.0, y: 3.0, yaw: 0 },
            { robotId: 3, x: 6.0, y: 5.0, yaw: 0.4 },
            { robotId: 4, x: 8.0, y: 4.0, yaw: -0.3 },
            { robotId: 7, x: 10.0, y: 6.0, yaw: 0.8 },
            { robotId: 101, x: 24.0, y: 12.0, yaw: 0 },
            { robotId: 103, x: 22.0, y: 10.0, yaw: 2.6 },
            { robotId: 104, x: 20.0, y: 11.0, yaw: 2.0 },
            { robotId: 107, x: 18.0, y: 9.0, yaw: 1.8 }
          ]
    const sent = []
    for (const item of known) {
      const robotId = Number(item.robotId)
      const x = Number(item.x)
      const y = Number(item.y)
      if (!Number.isInteger(robotId) || !Number.isFinite(x) || !Number.isFinite(y)) continue
      const payload = {
        ...protocol.createPreset('RobotPosition'),
        robotId,
        x,
        y,
        yaw: Number.isFinite(Number(item.yaw)) ? Number(item.yaw) : 0
      }
      await broker.publish('RobotPosition', payload, { qos: config.mqtt.qos })
      sent.push({ robotId, x, y })
      // 逐个发送，避免客户端在同一事件循环里只看到最后一帧。
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    if (sent.length) {
      // 同一条 Event 也带全量坐标，避免高频单点消息被客户端合并后只看到首尾。
      await broker.publish(
        'Event',
        {
          eventId: 0,
          param: `positions:${sent.map((item) => `${item.robotId},${item.x},${item.y}`).join(';')}`
        },
        { qos: config.mqtt.qos }
      )
    }
    addLog({ level: 'success', source: 'DEMO', message: `发送 ${sent.length} 个已知地图坐标` })
    return { positions: sent }
  }

  function stopMotionLoop() {
    if (motionTimer) clearInterval(motionTimer)
    motionTimer = null
  }

  function startMotionLoop() {
    stopMotionLoop()
    if (!motionState.enabled) return
    motionState.robotId = Number(config.protocol.robotId)
    // 自动移动时停掉固定 RobotPosition 调度，避免每秒被固定坐标拉回。
    const fixed = schedules.get('RobotPosition')
    if (fixed) {
      clearInterval(fixed.timer)
      schedules.delete('RobotPosition')
    }
    motionTimer = setInterval(async () => {
      if (!motionState.enabled || !broker.running) return
      motionState.phase += 0.1 * motionState.speed
      // 每台机器人有自己的 enabled/speed/direction/phase，互不联动。
      const positions = motionRobots.map((route) => {
        if (route.enabled) {
          route.phase += 0.1 * route.speed * route.direction * motionState.speed
          route.x = Math.max(
            0.6,
            Math.min(27.4, route.baseX + Math.sin(route.phase) * route.radiusX)
          )
          route.y = Math.max(
            0.6,
            Math.min(14.4, route.baseY + Math.cos(route.phase * 0.8) * route.radiusY)
          )
        } else {
          route.x = route.x ?? route.baseX
          route.y = route.y ?? route.baseY
        }
        return `${route.id},${route.x.toFixed(3)},${route.y.toFixed(3)}`
      })
      try {
        await broker.publish(
          'Event',
          { eventId: 0, param: `positions:${positions.join(';')}` },
          { qos: config.mqtt.qos }
        )
      } catch {
        // 发布端短暂断线时由下一个 tick 恢复。
      }
    }, 200)
  }

  async function applyMotion(body) {
    const route = body.robotId !== undefined
      ? motionRobots.find((item) => item.id === Number(body.robotId))
      : null
    if (body.robotId !== undefined && !route) throw new Error(`未知机器人 ID：${body.robotId}`)

    if (route) {
      if (body.enabled !== undefined) route.enabled = Boolean(body.enabled)
      if (body.direction !== undefined) route.direction = Number(body.direction) < 0 ? -1 : 1
      for (const key of ['baseX', 'baseY', 'radiusX', 'radiusY', 'speed']) {
        if (body[key] !== undefined && Number.isFinite(Number(body[key]))) {
          route[key] = Number(body[key])
        }
      }
    } else {
      if (body.enabled !== undefined) motionState.enabled = Boolean(body.enabled)
      if (body.robotId !== undefined) motionState.robotId = Number(body.robotId)
      for (const key of ['baseX', 'baseY', 'radiusX', 'radiusY', 'speed']) {
        if (body[key] !== undefined && Number.isFinite(Number(body[key]))) {
          motionState[key] = Number(body[key])
        }
      }
    }
    // 自动移动时停掉固定 RobotPosition 调度，避免每秒被固定坐标拉回。
    const fixed = schedules.get('RobotPosition')
    if (fixed) {
      clearInterval(fixed.timer)
      schedules.delete('RobotPosition')
    }
    startMotionLoop()
    return {
      ...motionState,
      robots: motionRobots.map(({ id, enabled, speed, direction, phase }) => ({
        id,
        enabled,
        speed,
        direction,
        phase
      }))
    }
  }

  async function demoPositionAction(body) {
    motionState.enabled = false
    stopMotionLoop()
    const x = Number(body.x)
    const y = Number(body.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('x / y 必须是数字')
    }
    const payload = {
      ...protocol.createPreset('RobotPosition'),
      x,
      y,
      yaw: Number.isFinite(Number(body.yaw)) ? Number(body.yaw) : 0,
      robotId: Number(config.protocol.robotId)
    }
    await startSchedule({
      topic: 'RobotPosition',
      payload,
      frequencyHz: OFFICIAL_FREQUENCY_HZ.RobotPosition ?? 1,
      qos: config.mqtt.qos
    })
    addLog({ level: 'success', source: 'DEMO', message: `机器人位置更新为 (${x}, ${y})` })
    return { x, y, yaw: payload.yaw, robotId: payload.robotId }
  }

  async function demoBaseAction(body) {
    const position = body.position === 'blue' ? 'blue' : 'red'
    const action = String(body.action || 'damage')
    const robotIsBlue = Number(config.protocol.robotId) >= 100
    const redHealthKey = robotIsBlue ? 'enemyBaseHealth' : 'baseHealth'
    const redShieldKey = robotIsBlue ? 'enemyBaseShield' : 'baseShield'
    const blueHealthKey = robotIsBlue ? 'baseHealth' : 'enemyBaseHealth'
    const blueShieldKey = robotIsBlue ? 'baseShield' : 'enemyBaseShield'
    const healthKey = position === 'red' ? redHealthKey : blueHealthKey
    const shieldKey = position === 'red' ? redShieldKey : blueShieldKey

    const current = currentGlobalUnitPayload()
    const currentHealth = Number(current[healthKey] ?? 10000)
    let health = currentHealth
    if (action === 'destroy') {
      health = 0
    } else if (action === 'reset') {
      health = 10000
    } else if (body.health !== undefined) {
      health = Number(body.health)
    } else {
      health = currentHealth - Number(body.damage ?? 2000)
    }
    health = Math.max(0, Math.min(10000, health))

    const patch = { [healthKey]: health, [shieldKey]: health }
    await replaceGlobalUnitSchedule(patch, `${position === 'red' ? '红方' : '蓝方'}基地血量更新为 ${health}`)
    return { position, health }
  }

  async function demoOutpostAction(body) {
    const position = body.position === 'blue' ? 'blue' : 'red'
    const action = String(body.action || 'damage')
    const robotIsBlue = Number(config.protocol.robotId) >= 100
    const redHealthKey = robotIsBlue ? 'enemyOutpostHealth' : 'outpostHealth'
    const redStatusKey = robotIsBlue ? 'enemyOutpostStatus' : 'outpostStatus'
    const blueHealthKey = robotIsBlue ? 'outpostHealth' : 'enemyOutpostHealth'
    const blueStatusKey = robotIsBlue ? 'outpostStatus' : 'enemyOutpostStatus'
    const healthKey = position === 'red' ? redHealthKey : blueHealthKey
    const statusKey = position === 'red' ? redStatusKey : blueStatusKey
    const current = currentGlobalUnitPayload()
    const currentHealth = Number(current[healthKey] ?? 1000)

    let health = currentHealth
    let status = 1
    let owner = position
    if (action === 'destroy') {
      health = 0
      status = 4
      owner = body.owner === 'blue' || body.owner === 'red' ? body.owner : position
    } else if (action === 'rebuild') {
      health = Number(body.health ?? 500)
      status = 1
      owner =
        body.owner === 'blue' || body.owner === 'red'
          ? body.owner
          : position === 'red'
            ? 'blue'
            : 'red'
    } else {
      health = Math.max(0, Number(body.health ?? Math.max(0, currentHealth - Number(body.damage ?? 250))))
      status = health <= 0 ? 4 : 1
      owner = body.owner === 'blue' || body.owner === 'red' ? body.owner : position
    }

    await replaceGlobalUnitSchedule(
      { [healthKey]: health, [statusKey]: status },
      `前哨演练 ${position} ${action} -> owner=${owner} hp=${health}`
    )

    // 归属/重建由 Event 2 的 param 传递；客户端单独保存位置和归属。
    await broker.publish(
      'Event',
      { eventId: 2, param: `outpost:${position}:${owner}:${health}` },
      { qos: config.mqtt.qos }
    )
    // 前哨阵地归属变化也要同步到战场控制度，面板/控制率不能停留在旧状态。
    const controlKey = position === 'red' ? 'redOutpost' : 'blueOutpost'
    controlState.positions[controlKey] = {
      owner,
      state: health > 0 ? 'COMPLETE' : 'NEUTRAL'
    }
    await publishControlEvent()
    broadcastState()
    return { position, owner, health, status }
  }

  async function demoRobotAction(body) {
    const robotId = Number(body.robotId)
    const baseId = robotId >= 100 ? robotId - 100 : robotId
    const valid =
      Number.isInteger(robotId) &&
      ((robotId >= 1 && robotId <= 9) || (robotId >= 101 && robotId <= 109)) &&
      [1, 3, 4, 6, 7, 8, 9].includes(baseId)
    if (!valid) throw new Error('robotId 必须是 1/3/4/6/7/8/9 或 101/103/104/106/107/108/109')

    protocol.robotId = robotId
    config = { ...config, protocol: { ...config.protocol, robotId } }

    const restartTopics = [
      'RobotStaticStatus',
      'RobotDynamicStatus',
      'RobotModuleStatus',
      'RobotPosition',
      'Buff',
      'RobotPathPlanInfo'
    ]
    for (const topic of restartTopics) {
      if (!schedules.has(topic)) continue
      await startSchedule({
        topic,
        payload: protocol.createPreset(topic),
        frequencyHz: OFFICIAL_FREQUENCY_HZ[topic] ?? 1,
        qos: config.mqtt.qos
      })
    }
    addLog({ level: 'success', source: 'DEMO', message: `当前机器人切换为 ${robotId}` })
    return { robotId }
  }

  async function startRecommendedScenario() {
    for (const topic of RECOMMENDED_SCENARIO_TOPICS) {
      try {
        await startSchedule({
          topic,
          payload: protocol.createPreset(topic),
          frequencyHz: OFFICIAL_FREQUENCY_HZ[topic] ?? 1,
          qos: config.mqtt.qos
        })
      } catch (error) {
        addLog({
          level: 'error',
          source: 'MQTT',
          message: `推荐场景 ${topic} 启动失败：${error.message}`
        })
      }
    }

    // CustomData 页面依赖 CustomByteBlock；默认 10Hz 发送 150 字节演示数据。
    if (!schedules.has('CustomByteBlock')) {
      try {
        await startSchedule({
          topic: 'CustomByteBlock',
          payload: protocol.createPreset('CustomByteBlock'),
          frequencyHz: 10,
          qos: config.mqtt.qos
        })
      } catch (error) {
        addLog({
          level: 'error',
          source: 'MQTT',
          message: `CustomByteBlock 启动失败：${error.message}`
        })
      }
    }

    // 空中系统演示状态也由模拟器周期发送，客户端只负责展示。
    await replaceAirSchedule()
    await startControlLoop()
    startMotionLoop()
  }

  const handleApi = async (request, response, pathname) => {
    if (request.method === 'GET' && pathname === '/api/protocol') {
      json(response, 200, {
        success: true,
        specification: {
          version: 'V2.0.0 (2026-06-26)',
          mqtt: { port: 3333, qosMax: 1, payload: 'Protobuf v3', topic: 'message name' },
          udp: {
            port: 3334,
            codec: 'HEVC/H.265 Annex-B',
            fps: 60,
            resolution: '1920x1080',
            headerBytes: 8,
            maxDatagramBytes: 1400,
            byteOrder: 'big-endian'
          }
        },
        messages: protocol.describe()
      })
      return
    }

    if (request.method === 'GET' && pathname === '/api/state') {
      json(response, 200, { success: true, state: getState(), logs })
      return
    }

    if (request.method === 'GET' && pathname === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      const remove = events.add(response)
      request.on('close', remove)
      return
    }

    const body = await readJson(request)

    if (request.method === 'POST' && pathname === '/api/broker/restart') {
      const mqttConfig = {
        host: String(body.host ?? config.mqtt.host),
        port: portNumber(body.port ?? config.mqtt.port, 'port')
      }
      stopAllSchedules()
      await broker.restart(mqttConfig)
      config = { ...config, mqtt: { ...config.mqtt, ...mqttConfig } }
      json(response, 200, { success: true, state: getState() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/mqtt/publish') {
      const result = await broker.publish(String(body.topic), body.payload ?? {}, {
        qos: Number(body.qos ?? config.mqtt.qos),
        retain: Boolean(body.retain)
      })
      addLog({ level: 'success', source: 'MQTT', message: `${result.topic} 手动发送成功（${result.bytes} B）` })
      json(response, 200, { success: true, result })
      return
    }

    if (request.method === 'POST' && pathname === '/api/mqtt/schedule/start') {
      await startSchedule(body)
      json(response, 200, { success: true, schedules: getState().schedules })
      return
    }

    if (request.method === 'POST' && pathname === '/api/mqtt/schedule/stop') {
      json(response, 200, { success: true, stopped: stopSchedule(String(body.topic)) })
      return
    }

    if (request.method === 'POST' && pathname === '/api/mqtt/schedule/stop-all') {
      stopAllSchedules()
      json(response, 200, { success: true })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/global-unit') {
      const patch = {
        ...(body.baseHealth !== undefined ? { baseHealth: Number(body.baseHealth) } : {}),
        ...(body.baseShield !== undefined ? { baseShield: Number(body.baseShield) } : {}),
        ...(body.outpostHealth !== undefined ? { outpostHealth: Number(body.outpostHealth) } : {}),
        ...(body.enemyBaseHealth !== undefined ? { enemyBaseHealth: Number(body.enemyBaseHealth) } : {}),
        ...(body.enemyBaseShield !== undefined ? { enemyBaseShield: Number(body.enemyBaseShield) } : {}),
        ...(body.enemyOutpostHealth !== undefined
          ? { enemyOutpostHealth: Number(body.enemyOutpostHealth) }
          : {})
      }
      const state = await replaceGlobalUnitSchedule(patch, '基地/前哨全局状态已更新')
      json(response, 200, { success: true, payload: state })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/motion') {
      const result = await applyMotion(body)
      json(response, 200, { success: true, motion: result })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/positions') {
      const result = await demoPositionsAction(body)
      json(response, 200, { success: true, ...result })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/position') {
      const result = await demoPositionAction(body)
      json(response, 200, { success: true, ...result })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/control') {
      applyControlState(body)
      await publishControlEvent()
      json(response, 200, { success: true, control: controlState, rates: controlRates() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/air') {
      applyAirState(body)
      const state = await replaceAirSchedule('空中系统演示状态已更新')
      json(response, 200, { success: true, ...state })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/base') {
      const result = await demoBaseAction(body)
      json(response, 200, { success: true, ...result })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/outpost') {
      const result = await demoOutpostAction(body)
      json(response, 200, { success: true, ...result })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/robot') {
      const result = await demoRobotAction(body)
      json(response, 200, { success: true, ...result })
      return
    }

    if (request.method === 'POST' && pathname === '/api/demo/reset') {
      await replaceGlobalUnitSchedule(
        {
          baseHealth: 10000,
          baseShield: 10000,
          outpostHealth: 1000,
          outpostStatus: 1,
          enemyBaseHealth: 10000,
          enemyBaseShield: 10000,
          enemyOutpostHealth: 1000,
          enemyOutpostStatus: 1,
          robotHealth: [600, 400, 400, 600, 600, 400, 400, 600],
          robotBullets: [100, 100, 100, 100, 100, 100, 100, 100]
        },
        '基地/前哨已重置为 10000/1000'
      )
      airState.hangarCount = 4
      airState.units = defaultAirUnits()
      applyControlState({ reset: true })
      await replaceAirSchedule('空中系统已重置为 4 机库 / 4 单元')
      await startControlLoop()
      await demoRobotAction({ robotId: 3 })
      motionState.enabled = true
      motionState.baseX = 14.2
      motionState.baseY = 7.5
      motionState.phase = 0
      motionRobots.forEach((route) => {
        route.phase = 0
        route.enabled = true
      })
      startMotionLoop()
      await broker.publish(
        'Event',
        { eventId: 2, param: 'outpost:red:red:1000' },
        { qos: config.mqtt.qos }
      )
      await broker.publish(
        'Event',
        { eventId: 2, param: 'outpost:blue:blue:1000' },
        { qos: config.mqtt.qos }
      )
      json(response, 200, {
        success: true,
        air: { hangarCount: airState.hangarCount, units: airState.units }
      })
      return
    }

    if (request.method === 'POST' && pathname === '/api/video/start') {
      const videoConfig = mergeVideoConfig(config.udpVideo, body)
      if (body.saveToYaml) {
        config = { ...config, udpVideo: videoConfig }
        saveConfig(config)
        addLog({ level: 'success', source: 'CONFIG', message: '视频参数已写入 config.yaml' })
      }
      const state = await video.start(videoConfig)
      json(response, 200, { success: true, state })
      return
    }

    if (request.method === 'POST' && pathname === '/api/video/stop') {
      json(response, 200, { success: true, state: await video.stop() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/logs/clear') {
      logs.length = 0
      events.send('logs-cleared', {})
      json(response, 200, { success: true })
      return
    }

    json(response, 404, { success: false, error: 'Unknown API endpoint' })
  }

  const webServer = http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        })
        response.end()
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url.pathname)
      } else {
        serveStatic(url.pathname, response)
      }
    } catch (error) {
      addLog({ level: 'error', source: 'HTTP', message: error.message })
      if (!response.headersSent) json(response, 400, { success: false, error: error.message })
      else response.end()
    }
  })

  await broker.start({ host: config.mqtt.host, port: config.mqtt.port })
  await new Promise((resolve, reject) => {
    webServer.once('error', reject)
    webServer.listen(config.web.port, config.web.host, resolve)
  })

  const guiUrl = `http://${config.web.host}:${config.web.port}`
  addLog({ level: 'success', source: 'GUI', message: `控制台已启动：${guiUrl}` })
  addLog({
    level: 'info',
    source: 'CONFIG',
    message: `独立配置：${config.configPath}`
  })
  if (config.web.openBrowser) openBrowser(guiUrl)

  if (config.udpVideo.startOnLaunch) {
    try {
      await video.start(config.udpVideo)
    } catch (error) {
      addLog({ level: 'error', source: 'UDP', message: `自动启动失败：${error.message}` })
    }
  }

  // v2：一键联调。启动后自动按官方频率发布推荐状态流。
  if (config.protocol.autoScenario) {
    await startRecommendedScenario()
  }

  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    addLog({ level: 'info', source: 'SYSTEM', message: `收到 ${signal}，正在停止模拟器……` })
    stopAllSchedules()
    await video.stop()
    await broker.stop()
    events.close()
    await new Promise((resolve) => webServer.close(resolve))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error(`协议模拟器启动失败：${error.stack ?? error.message}`)
  process.exit(1)
})
