const elements = Object.fromEntries(
  [
    'broker-pill', 'video-pill', 'guide-mqtt', 'guide-client-id', 'guide-udp', 'guide-config',
    'broker-host', 'broker-port', 'broker-restart', 'client-count', 'client-list',
    'scenario-count', 'scenario-topics', 'scenario-start', 'scenario-stop',
    'demo-position', 'demo-owner', 'demo-base-position', 'demo-base-damage', 'demo-outpost-damage',
    'demo-outpost-destroy', 'demo-outpost-rebuild', 'demo-reset', 'demo-status',
    'demo-robot', 'demo-hangar', 'demo-motion', 'demo-motion-speed', 'motion-robot-list',
    'demo-air-1', 'demo-air-2', 'demo-air-3', 'demo-air-4',
    'demo-robot-apply', 'demo-air-apply', 'demo-air-status',
    'demo-position-x', 'demo-position-y', 'demo-position-apply', 'demo-positions-apply',
    'control-red-base-owner', 'control-red-base-state',
    'control-blue-base-owner', 'control-blue-base-state',
    'control-red-outpost-owner', 'control-red-outpost-state',
    'control-blue-outpost-owner', 'control-blue-outpost-state',
    'control-apply', 'control-status',
    'topic-select', 'message-meta', 'field-list', 'payload-editor', 'json-validation',
    'reset-preset', 'send-frequency', 'send-qos', 'publish-once', 'schedule-start', 'schedule-stop',
    'video-path', 'video-host', 'video-port', 'video-loop', 'video-save', 'video-width',
    'video-height', 'video-fps', 'video-bitrate', 'video-gop', 'video-fragment', 'video-loss',
    'video-start', 'video-stop', 'metric-fps', 'metric-bitrate', 'metric-frames',
    'metric-packets', 'metric-dropped', 'log-list', 'clear-logs', 'toast'
  ].map((id) => [id, document.getElementById(id)])
)

let messages = []
let state = null
let brokerFormInitialized = false
let videoFormInitialized = false
let toastTimer = null

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const payload = await response.json()
  if (!response.ok || payload.success === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}

function showToast(message, error = false) {
  clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.classList.toggle('error', error)
  elements.toast.classList.add('show')
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 3200)
}

const motionRows = new Map()

function renderMotionRobots(motion) {
  if (!motion?.robots || !elements['motion-robot-list']) return
  for (const robot of motion.robots) {
    let row = motionRows.get(robot.id)
    if (!row) {
      row = document.createElement('div')
      row.className = 'motion-robot-row'
      row.dataset.robot = String(robot.id)
      row.innerHTML = `
        <span class="robot-tag">${robot.id < 100 ? 'R' : 'B'}${robot.id % 100}</span>
        <label><input class="motion-enabled" type="checkbox" /> 移动</label>
        <input class="motion-speed" type="number" min="0.1" max="3" step="0.05" title="速度" />
        <select class="motion-direction" title="方向">
          <option value="1">正向</option>
          <option value="-1">反向</option>
        </select>
      `
      elements['motion-robot-list'].append(row)
      motionRows.set(robot.id, row)
    }
    const enabled = row.querySelector('.motion-enabled')
    const speed = row.querySelector('.motion-speed')
    const direction = row.querySelector('.motion-direction')
    if (document.activeElement !== enabled) enabled.checked = robot.enabled
    if (document.activeElement !== speed) speed.value = Number(robot.speed).toFixed(2)
    if (document.activeElement !== direction) direction.value = String(robot.direction)
  }
}

function setBusy(button, busy, label = '处理中…') {
  if (busy) {
    button.dataset.label = button.textContent
    button.textContent = label
    button.disabled = true
  } else {
    button.textContent = button.dataset.label ?? button.textContent
    button.disabled = false
  }
}

elements['motion-robot-list'].addEventListener('change', async (event) => {
  const row = event.target.closest('.motion-robot-row')
  if (!row) return
  const robotId = Number(row.dataset.robot)
  try {
    await api('/api/demo/motion', {
      method: 'POST',
      body: {
        robotId,
        enabled: row.querySelector('.motion-enabled').checked,
        speed: Number(row.querySelector('.motion-speed').value),
        direction: Number(row.querySelector('.motion-direction').value)
      }
    })
    showToast(`${robotId < 100 ? 'R' : 'B'}${robotId % 100} 独立运动参数已更新`)
  } catch (error) {
    showToast(error.message, true)
  }
})

function currentMessage() {
  return messages.find((message) => message.name === elements['topic-select'].value)
}

function parseEditor() {
  try {
    const payload = JSON.parse(elements['payload-editor'].value)
    elements['json-validation'].textContent = 'JSON 有效；发送时将继续执行 Protobuf 类型校验'
    elements['json-validation'].classList.remove('error')
    return payload
  } catch (error) {
    elements['json-validation'].textContent = `JSON 无效：${error.message}`
    elements['json-validation'].classList.add('error')
    throw new Error(`JSON 无效：${error.message}`)
  }
}

function loadMessage(messageName) {
  const message = messages.find((entry) => entry.name === messageName) ?? messages[0]
  if (!message) return
  elements['topic-select'].value = message.name
  elements['payload-editor'].value = JSON.stringify(message.preset, null, 2)
  elements['send-frequency'].value = message.officialFrequencyHz ?? 1

  const direction = message.direction === 'server-to-client' ? '服务器 ↓ 客户端' : '客户端 ↑ 服务器'
  const frequency = message.frequencyDescription
  elements['message-meta'].replaceChildren(
    metaBox('方向', direction),
    metaBox('协议频率', frequency),
    metaBox('Topic', message.name),
    metaBox('字段数', String(message.fields.length))
  )

  const fields = message.fields.map((field) => {
    const row = document.createElement('div')
    row.className = 'field'
    const name = document.createElement('span')
    name.textContent = `${field.id}. ${field.name}`
    const type = document.createElement('em')
    type.textContent = `${field.repeated ? 'repeated ' : ''}${field.type}`
    row.append(name, type)
    return row
  })
  elements['field-list'].replaceChildren(...fields)
  parseEditor()
  renderState(state)
}

function metaBox(label, value) {
  const box = document.createElement('div')
  const name = document.createElement('span')
  name.textContent = label
  const content = document.createElement('strong')
  content.textContent = value
  box.append(name, content)
  return box
}

function populateTopics() {
  const downlink = document.createElement('optgroup')
  downlink.label = '服务器 → 自定义客户端'
  const uplink = document.createElement('optgroup')
  uplink.label = '自定义客户端 → 服务器（可用于反向注入测试）'

  for (const message of messages) {
    const option = document.createElement('option')
    option.value = message.name
    option.textContent = `${message.name} · ${message.frequencyDescription}`
    ;(message.direction === 'server-to-client' ? downlink : uplink).append(option)
  }
  elements['topic-select'].replaceChildren(downlink, uplink)
  loadMessage(messages.some((message) => message.name === 'GameStatus') ? 'GameStatus' : messages[0]?.name)
}

function renderClients(clients = []) {
  elements['client-count'].textContent = `${clients.length} 个`
  if (!clients.length) {
    const empty = document.createElement('span')
    empty.className = 'empty'
    empty.textContent = '等待 OriginClient 连接'
    elements['client-list'].replaceChildren(empty)
    return
  }
  elements['client-list'].replaceChildren(
    ...clients.map((clientId) => {
      const chip = document.createElement('span')
      chip.className = 'client-chip'
      chip.textContent = clientId
      return chip
    })
  )
}

function renderScenario(activeTopics) {
  const recommended = messages.filter((message) => message.recommended)
  const activeCount = recommended.filter((message) => activeTopics.has(message.name)).length
  elements['scenario-count'].textContent = `${activeCount} / ${recommended.length}`
  elements['scenario-topics'].replaceChildren(
    ...recommended.map((message) => {
      const chip = document.createElement('span')
      chip.className = `topic-chip${activeTopics.has(message.name) ? '' : ' inactive'}`
      chip.textContent = `${message.name} · ${message.officialFrequencyHz}Hz`
      return chip
    })
  )
}

function fillVideoForm(config) {
  elements['video-path'].value = config.videoPath ?? ''
  elements['video-host'].value = config.targetHost ?? '127.0.0.1'
  elements['video-port'].value = config.targetPort ?? 3334
  elements['video-loop'].checked = config.loop ?? true
  elements['video-width'].value = config.width ?? 1920
  elements['video-height'].value = config.height ?? 1080
  elements['video-fps'].value = config.fps ?? 60
  elements['video-bitrate'].value = config.bitrateKbps ?? 4000
  elements['video-gop'].value = config.gop ?? 60
  elements['video-fragment'].value = config.fragmentPayloadBytes ?? 1392
  elements['video-loss'].value = config.packetLossPercent ?? 0
}

function renderState(nextState) {
  if (!nextState) return
  state = nextState
  const broker = nextState.broker
  const video = nextState.video
  const activeTopics = new Set(nextState.schedules.map((entry) => entry.topic))

  elements['broker-pill'].classList.toggle('online', broker.running)
  elements['broker-pill'].classList.toggle('offline', !broker.running)
  elements['broker-pill'].innerHTML = `<i></i>${broker.running ? 'MQTT 在线' : 'MQTT 离线'}`
  elements['video-pill'].classList.toggle('online', video.running)
  elements['video-pill'].classList.toggle('offline', !video.running)
  elements['video-pill'].innerHTML = `<i></i>${video.running ? '图传发送中' : '图传停止'}`

  if (!brokerFormInitialized) {
    elements['broker-host'].value = broker.host ?? nextState.config.mqtt.host
    elements['broker-port'].value = broker.port ?? nextState.config.mqtt.port
    brokerFormInitialized = true
  }
  if (!videoFormInitialized) {
    fillVideoForm(nextState.config.udpVideo)
    videoFormInitialized = true
  }

  elements['guide-mqtt'].textContent = `${broker.host ?? nextState.config.mqtt.host}:${broker.port ?? nextState.config.mqtt.port}`
  elements['guide-client-id'].textContent = nextState.config.expectedClientId || '机器人 ID'
  elements['guide-udp'].textContent = `0.0.0.0:${nextState.config.udpVideo.targetPort}`
  elements['guide-config'].textContent = nextState.config.configPath
  elements['guide-config'].title = nextState.config.configPath
  renderClients(broker.clients)
  renderScenario(activeTopics)

  const selected = currentMessage()?.name
  elements['schedule-stop'].disabled = !activeTopics.has(selected)
  elements['video-start'].disabled = video.running
  elements['video-stop'].disabled = !video.running
  if (video.stats) updateVideoStats(video.stats)
  if (nextState.motion) {
    elements['demo-motion'].checked = Boolean(nextState.motion.enabled)
    elements['demo-motion-speed'].value = nextState.motion.speed ?? 1
    renderMotionRobots(nextState.motion)
  }
  if (nextState.control) {
    const control = nextState.control
    const positions = control.positions
    const rates = {
      red:
        (positions.redOutpost.owner === 'red' && positions.blueOutpost.owner === 'red' ? 1 : 0) +
        (positions.redBase.owner === 'red' && positions.blueBase.owner === 'red' ? 3 : 0),
      blue:
        (positions.redOutpost.owner === 'blue' && positions.blueOutpost.owner === 'blue' ? 1 : 0) +
        (positions.redBase.owner === 'blue' && positions.blueBase.owner === 'blue' ? 3 : 0)
    }
    elements['control-status'].textContent =
      `控制度：红 ${control.redScore} · 蓝 ${control.blueScore} · 增长 +${rates.red} / +${rates.blue}`
  }
}

function updateVideoStats(stats) {
  elements['metric-fps'].textContent = Number(stats.actualFps ?? 0).toFixed(1)
  elements['metric-bitrate'].textContent = `${Number(stats.bitrateMbps ?? 0).toFixed(2)} Mbps`
  elements['metric-frames'].textContent = String(stats.frames ?? 0)
  elements['metric-packets'].textContent = String(stats.packets ?? 0)
  elements['metric-dropped'].textContent = String(stats.droppedPackets ?? 0)
}

function appendLog(entry) {
  const nearBottom = elements['log-list'].scrollHeight - elements['log-list'].scrollTop - elements['log-list'].clientHeight < 60
  const row = document.createElement('div')
  row.className = `log-entry ${entry.level ?? 'info'}`
  row.dataset.id = entry.id
  const time = document.createElement('time')
  time.textContent = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })
  const source = document.createElement('span')
  source.className = 'log-source'
  source.textContent = entry.source
  const message = document.createElement('div')
  message.className = 'log-message'
  message.textContent = entry.message
  if (entry.details) {
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = '查看解码数据'
    const pre = document.createElement('pre')
    pre.textContent = JSON.stringify(entry.details, null, 2)
    details.append(summary, pre)
    message.append(details)
  }
  row.append(time, source, message)
  elements['log-list'].append(row)
  while (elements['log-list'].children.length > 300) elements['log-list'].firstElementChild.remove()
  if (nearBottom) elements['log-list'].scrollTop = elements['log-list'].scrollHeight
}

function videoPayload() {
  return {
    videoPath: elements['video-path'].value.trim(),
    targetHost: elements['video-host'].value.trim(),
    targetPort: Number(elements['video-port'].value),
    loop: elements['video-loop'].checked,
    width: Number(elements['video-width'].value),
    height: Number(elements['video-height'].value),
    fps: Number(elements['video-fps'].value),
    bitrateKbps: Number(elements['video-bitrate'].value),
    gop: Number(elements['video-gop'].value),
    fragmentPayloadBytes: Number(elements['video-fragment'].value),
    packetLossPercent: Number(elements['video-loss'].value),
    saveToYaml: elements['video-save'].checked
  }
}

elements['topic-select'].addEventListener('change', () => loadMessage(elements['topic-select'].value))
elements['payload-editor'].addEventListener('input', () => {
  try { parseEditor() } catch { /* Validation label already updated. */ }
})
elements['reset-preset'].addEventListener('click', () => loadMessage(currentMessage()?.name))

elements['publish-once'].addEventListener('click', async () => {
  try {
    setBusy(elements['publish-once'], true, '发送中…')
    await api('/api/mqtt/publish', {
      method: 'POST',
      body: { topic: currentMessage().name, payload: parseEditor(), qos: Number(elements['send-qos'].value) }
    })
    showToast(`${currentMessage().name} 已发送`)
  } catch (error) {
    showToast(error.message, true)
  } finally {
    setBusy(elements['publish-once'], false)
  }
})

elements['schedule-start'].addEventListener('click', async () => {
  try {
    setBusy(elements['schedule-start'], true, '启动中…')
    const result = await api('/api/mqtt/schedule/start', {
      method: 'POST',
      body: {
        topic: currentMessage().name,
        payload: parseEditor(),
        frequencyHz: Number(elements['send-frequency'].value),
        qos: Number(elements['send-qos'].value)
      }
    })
    renderState({ ...state, schedules: result.schedules })
    showToast(`${currentMessage().name} 定时发送已启动`)
  } catch (error) {
    showToast(error.message, true)
  } finally {
    setBusy(elements['schedule-start'], false)
  }
})

elements['schedule-stop'].addEventListener('click', async () => {
  try {
    await api('/api/mqtt/schedule/stop', { method: 'POST', body: { topic: currentMessage().name } })
    showToast(`${currentMessage().name} 已停止`)
  } catch (error) {
    showToast(error.message, true)
  }
})

elements['scenario-start'].addEventListener('click', async () => {
  try {
    setBusy(elements['scenario-start'], true, '启动场景中…')
    for (const message of messages.filter((entry) => entry.recommended)) {
      await api('/api/mqtt/schedule/start', {
        method: 'POST',
        body: {
          topic: message.name,
          payload: message.preset,
          frequencyHz: message.officialFrequencyHz,
          qos: 1
        }
      })
    }
    showToast('推荐状态流已启动')
  } catch (error) {
    showToast(error.message, true)
  } finally {
    setBusy(elements['scenario-start'], false)
  }
})

elements['scenario-stop'].addEventListener('click', async () => {
  try {
    await api('/api/mqtt/schedule/stop-all', { method: 'POST' })
    showToast('全部定时消息已停止')
  } catch (error) {
    showToast(error.message, true)
  }
})

async function runDemo(path, body, successText, statusElement = elements['demo-status']) {
  try {
    const result = await api(path, { method: 'POST', body })
    statusElement.textContent = `${successText} · ${JSON.stringify(result).slice(0, 180)}`
    showToast(successText)
  } catch (error) {
    statusElement.textContent = `失败：${error.message}`
    showToast(error.message, true)
  }
}

elements['demo-base-damage'].addEventListener('click', () =>
  runDemo(
    '/api/demo/base',
    { position: elements['demo-base-position'].value, action: 'damage', damage: 2000 },
    '基地扣血 2000'
  )
)

elements['demo-outpost-damage'].addEventListener('click', () =>
  runDemo(
    '/api/demo/outpost',
    { position: elements['demo-position'].value, action: 'damage', damage: 300 },
    '前哨扣血 300'
  )
)

elements['demo-outpost-destroy'].addEventListener('click', () =>
  runDemo(
    '/api/demo/outpost',
    { position: elements['demo-position'].value, action: 'destroy' },
    '前哨击毁'
  )
)

elements['demo-outpost-rebuild'].addEventListener('click', () =>
  runDemo(
    '/api/demo/outpost',
    {
      position: elements['demo-position'].value,
      action: 'rebuild',
      owner: elements['demo-owner'].value,
      health: 500
    },
    '前哨重建 + 归属切换'
  )
)

elements['demo-reset'].addEventListener('click', () =>
  runDemo('/api/demo/reset', {}, '比赛重置：阵容 / 10000 / 1000 / 空中系统')
)

elements['demo-robot-apply'].addEventListener('click', () =>
  runDemo(
    '/api/demo/robot',
    { robotId: Number(elements['demo-robot'].value) },
    '当前机器人已切换',
    elements['demo-air-status']
  )
)

elements['demo-motion'].addEventListener('change', async () => {
  try {
    await api('/api/demo/motion', {
      method: 'POST',
      body: {
        enabled: elements['demo-motion'].checked,
        speed: Number(elements['demo-motion-speed'].value)
      }
    })
    showToast(elements['demo-motion'].checked ? '机器人自动移动已开启' : '机器人自动移动已停止')
  } catch (error) {
    showToast(error.message, true)
  }
})

elements['demo-air-apply'].addEventListener('click', () => {
  const units = [1, 2, 3, 4].map((index) => ({
    state: elements[`demo-air-${index}`].value
  }))
  return runDemo(
    '/api/demo/air',
    { hangarCount: Number(elements['demo-hangar'].value), units },
    '空中系统状态已发送',
    elements['demo-air-status']
  )
})

elements['demo-position-apply'].addEventListener('click', () =>
  runDemo(
    '/api/demo/position',
    {
      x: Number(elements['demo-position-x'].value),
      y: Number(elements['demo-position-y'].value),
      yaw: 0
    },
    '机器人地图位置已发送',
    elements['demo-air-status']
  )
)

elements['demo-positions-apply'].addEventListener('click', () =>
  runDemo(
    '/api/demo/positions',
    {},
    '已知地图坐标组已发送',
    elements['demo-air-status']
  )
)

elements['control-apply'].addEventListener('click', async () => {
  const positions = {
    redBase: {
      owner: elements['control-red-base-owner'].value,
      state: elements['control-red-base-state'].value
    },
    blueBase: {
      owner: elements['control-blue-base-owner'].value,
      state: elements['control-blue-base-state'].value
    },
    redOutpost: {
      owner: elements['control-red-outpost-owner'].value,
      state: elements['control-red-outpost-state'].value
    },
    blueOutpost: {
      owner: elements['control-blue-outpost-owner'].value,
      state: elements['control-blue-outpost-state'].value
    }
  }
  try {
    const result = await api('/api/demo/control', { method: 'POST', body: { positions } })
    elements['control-status'].textContent =
      `控制度：红 ${result.control.redScore} · 蓝 ${result.control.blueScore} · 增长 +${result.rates.red} / +${result.rates.blue}`
    showToast('阵地控制状态已更新')
  } catch (error) {
    elements['control-status'].textContent = `失败：${error.message}`
    showToast(error.message, true)
  }
})

elements['broker-restart'].addEventListener('click', async () => {
  try {
    setBusy(elements['broker-restart'], true, '重启中…')
    const result = await api('/api/broker/restart', {
      method: 'POST',
      body: { host: elements['broker-host'].value.trim(), port: Number(elements['broker-port'].value) }
    })
    renderState(result.state)
    showToast('MQTT Broker 已重启')
  } catch (error) {
    showToast(error.message, true)
  } finally {
    setBusy(elements['broker-restart'], false)
  }
})

elements['video-start'].addEventListener('click', async () => {
  try {
    setBusy(elements['video-start'], true, '启动编码器…')
    const result = await api('/api/video/start', { method: 'POST', body: videoPayload() })
    renderState({ ...state, video: result.state })
    showToast('循环 H.265 UDP 图传已启动')
  } catch (error) {
    showToast(error.message, true)
  } finally {
    setBusy(elements['video-start'], false)
    renderState(state)
  }
})

elements['video-stop'].addEventListener('click', async () => {
  try {
    await api('/api/video/stop', { method: 'POST' })
    showToast('UDP 图传已停止')
  } catch (error) {
    showToast(error.message, true)
  }
})

elements['clear-logs'].addEventListener('click', async () => {
  await api('/api/logs/clear', { method: 'POST' })
  elements['log-list'].replaceChildren()
})

async function initialize() {
  try {
    const [protocolResult, stateResult] = await Promise.all([api('/api/protocol'), api('/api/state')])
    messages = protocolResult.messages
    populateTopics()
    renderState(stateResult.state)
    elements['log-list'].replaceChildren()
    for (const entry of stateResult.logs) appendLog(entry)
    elements['log-list'].scrollTop = elements['log-list'].scrollHeight

    const stream = new EventSource('/api/events')
    stream.addEventListener('state', (event) => renderState(JSON.parse(event.data)))
    stream.addEventListener('log', (event) => appendLog(JSON.parse(event.data)))
    stream.addEventListener('video-stats', (event) => updateVideoStats(JSON.parse(event.data)))
    stream.addEventListener('logs-cleared', () => elements['log-list'].replaceChildren())
    stream.onerror = () => showToast('与模拟器后台的事件连接暂时中断，正在自动重连', true)
  } catch (error) {
    showToast(`初始化失败：${error.message}`, true)
  }
}

initialize()
