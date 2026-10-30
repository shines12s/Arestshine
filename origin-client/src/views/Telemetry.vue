<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, onActivated, onDeactivated } from 'vue'
import HudPanel from '@/components/HudPanel.vue'
import { useMqttDataStore } from '@/store'

const mqttStore = useMqttDataStore()
const FIELD_WIDTH = 28
const FIELD_HEIGHT = 15
const clickedFieldPoint = ref<{ x: number; y: number } | null>(null)

type Team = 'red' | 'blue'
type Robot = {
  id: string
  team: Team
  x: number
  y: number
  hp: number
  // 渲染位置（用于插值）
  renderX?: number
  renderY?: number
  // 目标位置（实际逻辑位置）
  targetX?: number
  targetY?: number
}

const mapPanel = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null

const isBorderVisible = ref(false)
const isControlsModalVisible = ref(false)
// --- 新增: 边界框顶点和拖拽状态 ---
const handleRadius = 10 // 拖拽手柄的像素半径
const corners = reactive([
  { x: 0.1, y: 0.1 }, // 左上 (百分比)
  { x: 0.9, y: 0.1 }, // 右上
  { x: 0.9, y: 0.9 }, // 右下
  { x: 0.1, y: 0.9 } // 左下
])
const draggingCornerIndex = ref<number | null>(null)
// --- 结束 ---

const mapImage = ref<HTMLImageElement | null>(null)

// 插值参数：控制移动平滑度（0-1，越小越平滑但有延迟）
const LERP_FACTOR = 0.15

const robots = reactive<Robot[]>([])
const selectedId = ref<string | null>(null)
const simRunning = ref(true)
let rafHandle: number | null = null
let simInterval: number | null = null
let resizeObserver: ResizeObserver | null = null

const redTeamRobots = computed(() => robots.filter((r) => r.team === 'red'))
const blueTeamRobots = computed(() => robots.filter((r) => r.team === 'blue'))

/** 地图标记只使用 MQTT RobotPosition 数据；没有坐标的机器人不画。 */
function syncMqttRobots(): void {
  const next: Robot[] = []
  const append = (map: Map<number, any>, team: Team, prefix: string): void => {
    for (const [id, robot] of map) {
      const x = Number(robot.x)
      const y = Number(robot.y)
      if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) continue
      const maxHealth = Number(robot.maxHealth) || 0
      next.push({
        id: `${prefix}${id >= 100 ? id - 100 : id}`,
        team,
        x,
        y,
        hp: maxHealth > 0 ? Math.max(0, Math.min(100, Math.round((Number(robot.currentHealth) / maxHealth) * 100))) : 0,
        renderX: x,
        renderY: y,
        targetX: x,
        targetY: y
      })
    }
  }
  append(mqttStore.redRobots, 'red', 'R')
  append(mqttStore.blueRobots, 'blue', 'B')
  robots.splice(0, robots.length, ...next)
}

// Initialize sample robots
function initSampleRobots() {
  robots.splice(0, robots.length)
  // 2026 地面阵容：1 重装、3/4 步兵、7 哨兵；不再生成 2/6。
  const ids = ['1', '3', '4', '7']
  // --- 新增: 获取边界框范围 ---
  const minX = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x) * 100
  const maxX = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x) * 100
  const minY = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y) * 100
  const maxY = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y) * 100
  const rangeX = maxX - minX
  const rangeY = maxY - minY
  // --- 结束 ---

  // Red Team
  ids.forEach((id) => {
    const initX = Math.random() * (rangeX / 2) + minX
    const initY = Math.random() * rangeY + minY
    robots.push({
      id: `R${id}`,
      team: 'red',
      x: initX,
      y: initY,
      // 初始化渲染位置与实际位置相同
      renderX: initX,
      renderY: initY,
      targetX: initX,
      targetY: initY,
      hp: Math.floor(60 + Math.random() * 40)
    })
  })
  // Blue Team
  ids.forEach((id) => {
    const initX = Math.random() * (rangeX / 2) + (minX + rangeX / 2)
    const initY = Math.random() * rangeY + minY
    robots.push({
      id: `B${id}`,
      team: 'blue',
      x: initX,
      y: initY,
      // 初始化渲染位置与实际位置相同
      renderX: initX,
      renderY: initY,
      targetX: initX,
      targetY: initY,
      hp: Math.floor(60 + Math.random() * 40)
    })
  })
}

// Simulate robot movement and status changes
function simulateStep() {
  // --- 新增: 获取边界框范围 ---
  const minX = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x) * 100
  const maxX = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x) * 100
  const minY = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y) * 100
  const maxY = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y) * 100
  // --- 结束 ---

  for (const r of robots) {
    // 更新目标位置（逻辑位置）
    const newX = Math.max(minX, Math.min(maxX, r.x + (Math.random() - 0.5) * 3))
    const newY = Math.max(minY, Math.min(maxY, r.y + (Math.random() - 0.5) * 3))

    r.x = newX
    r.y = newY
    r.targetX = newX
    r.targetY = newY

    // 初始化渲染位置（如果未设置）
    if (r.renderX === undefined) r.renderX = newX
    if (r.renderY === undefined) r.renderY = newY

    r.hp = Math.max(0, Math.min(100, r.hp + Math.floor((Math.random() - 0.52) * 2)))
  }
}

const startSimulation = () => {
  if (simInterval) clearInterval(simInterval)
  simRunning.value = true
  simInterval = window.setInterval(simulateStep, 500)
}

const stopSimulation = () => {
  if (simInterval) clearInterval(simInterval)
  simInterval = null
  simRunning.value = false
}

const toggleSim = () => (simRunning.value ? stopSimulation() : startSimulation())

const selectRobot = (id: string) => (selectedId.value = id)

const handleKeyDown = (event: KeyboardEvent): void => {
  if (event.key.toLowerCase() === 'p') {
    isBorderVisible.value = !isBorderVisible.value
  }
  // --- 新增: 'e' 键切换控制弹窗 ---
  if (event.key.toLowerCase() === 'e') {
    isControlsModalVisible.value = !isControlsModalVisible.value
  }
  // --- 结束 ---
}

const resizeCanvas = (): void => {
  const cvs = canvas.value
  const panel = mapPanel.value
  if (!cvs || !panel || !ctx) return

  const { width, height } = panel.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const displayWidth = Math.round(width)
  const displayHeight = Math.round(height)

  cvs.width = displayWidth * dpr
  cvs.height = displayHeight * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function fieldToPixel(x: number, y: number, width: number, height: number): { x: number; y: number } {
  return {
    x: (x / FIELD_WIDTH) * width,
    y: (y / FIELD_HEIGHT) * height
  }
}

/** 2027 场地标注：原飞坡位置改为隧道，并补制高点/机库平台/工作台。 */
function drawField2027(ctx2d: CanvasRenderingContext2D, width: number, height: number): void {
  const label = (text: string, x: number, y: number, color = '#b9e7ff'): void => {
    const p = fieldToPixel(x, y, width, height)
    ctx2d.font = 'bold 11px "Microsoft YaHei", Arial'
    ctx2d.textAlign = 'center'
    ctx2d.textBaseline = 'middle'
    const w = ctx2d.measureText(text).width + 10
    ctx2d.fillStyle = 'rgba(2, 12, 22, 0.76)'
    ctx2d.fillRect(p.x - w / 2, p.y - 9, w, 18)
    ctx2d.strokeStyle = 'rgba(93, 194, 235, 0.45)'
    ctx2d.lineWidth = 1
    ctx2d.strokeRect(p.x - w / 2, p.y - 9, w, 18)
    ctx2d.fillStyle = color
    ctx2d.fillText(text, p.x, p.y)
  }

  // 机库平台、工作台、隧道文字按需求删除，仅保留阵地相关标注。
  label('制高点', 14, 5.2, '#ffd177')
  label('中央高地', 14, 8.8, '#b9e7ff')

  // 基地/前哨固定阵地点，坐标与模拟器演示坐标使用同一 28m × 15m 场地系。
  // 基地标记会被左上/右上 HUD 遮住，因此用引线把名称放到可见区域。
  const points = [
    { x: 3.1, y: 7.6, lx: 5.3, ly: 9.0, label: '红方基地', color: '#f87171' },
    { x: 24.8, y: 7.6, lx: 22.4, ly: 6.2, label: '蓝方基地', color: '#60a5fa' },
    { x: 11.7, y: 10.7, lx: 9.6, ly: 12.0, label: '红方前哨', color: '#fca5a5' },
    { x: 16.4, y: 4.2, lx: 18.0, ly: 3.2, label: '蓝方前哨', color: '#93c5fd' }
  ]
  for (const point of points) {
    const p = fieldToPixel(point.x, point.y, width, height)
    const lp = fieldToPixel(point.lx, point.ly, width, height)
    ctx2d.beginPath()
    ctx2d.fillStyle = 'rgba(2, 12, 22, 0.85)'
    ctx2d.arc(p.x, p.y, 12, 0, Math.PI * 2)
    ctx2d.fill()
    ctx2d.strokeStyle = point.color
    ctx2d.lineWidth = 2
    ctx2d.stroke()
    ctx2d.beginPath()
    ctx2d.fillStyle = point.color
    ctx2d.arc(p.x, p.y, 4, 0, Math.PI * 2)
    ctx2d.fill()

    ctx2d.beginPath()
    ctx2d.strokeStyle = point.color
    ctx2d.lineWidth = 1
    ctx2d.moveTo(p.x, p.y)
    ctx2d.lineTo(lp.x, lp.y)
    ctx2d.stroke()

    ctx2d.font = 'bold 10px "Microsoft YaHei", Arial'
    ctx2d.textAlign = 'left'
    ctx2d.textBaseline = 'middle'
    const labelWidth = ctx2d.measureText(point.label).width + 10
    ctx2d.fillStyle = 'rgba(2, 12, 22, 0.9)'
    ctx2d.fillRect(lp.x - 5, lp.y - 9, labelWidth, 18)
    ctx2d.strokeStyle = point.color
    ctx2d.strokeRect(lp.x - 5, lp.y - 9, labelWidth, 18)
    ctx2d.fillStyle = point.color
    ctx2d.fillText(point.label, lp.x, lp.y)
  }
}

const draw = () => {
  const currentCtx = ctx
  const currentCanvas = canvas.value

  if (currentCtx && currentCanvas) {
    syncMqttRobots()
    const { width, height } = currentCanvas.getBoundingClientRect()
    currentCtx.clearRect(0, 0, width, height)

    // --- 绘制地图背景 ---
    if (mapImage.value) {
      currentCtx.drawImage(mapImage.value, 0, 0, width, height)
    } else {
      currentCtx.fillStyle = '#061226'
      currentCtx.fillRect(0, 0, width, height)
    }

    // Draw grid over the map
    currentCtx.strokeStyle = 'rgba(255, 255, 255, 0.04)'
    currentCtx.lineWidth = 1
    for (let i = 0; i < 10; i++) {
      currentCtx.beginPath()
      currentCtx.moveTo((i / 10) * width, 0)
      currentCtx.lineTo((i / 10) * width, height)
      currentCtx.stroke()
      currentCtx.beginPath()
      currentCtx.moveTo(0, (i / 10) * height)
      currentCtx.lineTo(width, (i / 10) * height)
      currentCtx.stroke()
    }

    drawField2027(currentCtx, width, height)

    // --- 绘制可拖拽的场地边界 ---
    if (isBorderVisible.value) {
      currentCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      currentCtx.lineWidth = 3
      currentCtx.fillStyle = 'rgba(255, 255, 255, 1)'

      // 绘制连接线
      currentCtx.beginPath()
      currentCtx.moveTo(corners[0].x * width, corners[0].y * height)
      for (let i = 1; i < corners.length; i++) {
        currentCtx.lineTo(corners[i].x * width, corners[i].y * height)
      }
      currentCtx.closePath()
      currentCtx.stroke()

      // 绘制拖拽手柄
      for (let i = 0; i < corners.length; i++) {
        currentCtx.beginPath()
        currentCtx.arc(corners[i].x * width, corners[i].y * height, handleRadius, 0, Math.PI * 2)
        currentCtx.fill()
      }
    }
    // --- 结束 ---

    // 更新机器人插值位置（在每一帧中平滑移动）
    robots.forEach((robot) => {
      if (robot.targetX !== undefined && robot.targetY !== undefined) {
        // 线性插值（lerp）：renderPos = renderPos + (targetPos - renderPos) * factor
        robot.renderX = robot.renderX! + (robot.targetX - robot.renderX!) * LERP_FACTOR
        robot.renderY = robot.renderY! + (robot.targetY - robot.renderY!) * LERP_FACTOR
      }
    })

    // Draw robots
    robots.forEach((robot) => {
      // 使用插值后的渲染位置
      const fieldX = robot.renderX ?? robot.x
      const position = fieldToPixel(fieldX, robot.renderY ?? robot.y, width, height)
      const px = position.x
      const py = position.y
      const isSelected = selectedId.value === robot.id
      const radius = isSelected ? 8 : 6

      // --- 高亮选中单位 ---
      if (isSelected) {
        const pulseTime = Date.now() / 500
        const pulseRadius = radius + 4 + Math.sin(pulseTime) * 2
        const pulseOpacity = 0.5 + Math.sin(pulseTime) * 0.2

        currentCtx.beginPath()
        currentCtx.strokeStyle = `rgba(${
          robot.team === 'red' ? '248, 113, 113' : '96, 165, 250'
        }, ${pulseOpacity})`
        currentCtx.lineWidth = 3
        currentCtx.arc(px, py, pulseRadius, 0, Math.PI * 2)
        currentCtx.stroke()
      }
      // --- 结束 ---

      currentCtx.beginPath()
      currentCtx.fillStyle = robot.team === 'red' ? '#f87171' : '#60a5fa'
      currentCtx.arc(px, py, radius, 0, Math.PI * 2)
      currentCtx.fill()

      const labelText = `${robot.id} x=${fieldX.toFixed(1)} | ${robot.hp}%`
      currentCtx.font = 'bold 11px Arial'
      const textMetrics = currentCtx.measureText(labelText)
      const labelWidth = textMetrics.width + 10
      const labelHeight = 18
      const labelX = px + radius + 4
      const labelY = py - labelHeight / 2

      currentCtx.fillStyle = 'rgba(0, 0, 0, 0.6)'
      currentCtx.fillRect(labelX, labelY, labelWidth, labelHeight)
      currentCtx.fillStyle = robot.team === 'red' ? '#fecaca' : '#bfdbfe'
      currentCtx.textBaseline = 'middle'
      currentCtx.fillText(labelText, labelX + 5, py)
    })

    if (clickedFieldPoint.value) {
      const p = fieldToPixel(clickedFieldPoint.value.x, clickedFieldPoint.value.y, width, height)
      currentCtx.beginPath()
      currentCtx.strokeStyle = '#facc15'
      currentCtx.lineWidth = 1.5
      currentCtx.arc(p.x, p.y, 9, 0, Math.PI * 2)
      currentCtx.moveTo(p.x - 14, p.y)
      currentCtx.lineTo(p.x + 14, p.y)
      currentCtx.moveTo(p.x, p.y - 14)
      currentCtx.lineTo(p.x, p.y + 14)
      currentCtx.stroke()
      const coordText = `(${clickedFieldPoint.value.x.toFixed(1)}, ${clickedFieldPoint.value.y.toFixed(1)})`
      currentCtx.font = 'bold 11px "Microsoft YaHei", Arial'
      currentCtx.textAlign = 'left'
      currentCtx.textBaseline = 'middle'
      const textWidth = currentCtx.measureText(coordText).width + 10
      currentCtx.fillStyle = 'rgba(2, 12, 22, 0.86)'
      currentCtx.fillRect(p.x + 13, p.y - 9, textWidth, 18)
      currentCtx.fillStyle = '#facc15'
      currentCtx.fillText(coordText, p.x + 18, p.y)
    }
  }
  rafHandle = requestAnimationFrame(draw)
}

// --- 新增: 将 CSS 坐标转换为 Canvas 坐标 ---
function getMousePos(event: MouseEvent): { x: number; y: number } | null {
  const rect = canvas.value?.getBoundingClientRect()
  if (!rect) return null
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  }
}

function handleMapClick(event: MouseEvent): void {
  if (!canvas.value) return
  const pos = getMousePos(event)
  if (!pos) return
  const { width, height } = canvas.value.getBoundingClientRect()
  clickedFieldPoint.value = {
    x: Math.max(0, Math.min(FIELD_WIDTH, (pos.x / width) * FIELD_WIDTH)),
    y: Math.max(0, Math.min(FIELD_HEIGHT, (pos.y / height) * FIELD_HEIGHT))
  }
}

// --- 新增: 鼠标按下事件处理 ---
const handleMouseDown = (event: MouseEvent) => {
  if (!isBorderVisible.value || !canvas.value) return
  const pos = getMousePos(event)
  if (!pos) return

  const { width, height } = canvas.value.getBoundingClientRect()

  for (let i = 0; i < corners.length; i++) {
    const cornerX = corners[i].x * width
    const cornerY = corners[i].y * height
    const distance = Math.sqrt(Math.pow(pos.x - cornerX, 2) + Math.pow(pos.y - cornerY, 2))
    if (distance < handleRadius) {
      draggingCornerIndex.value = i
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      break
    }
  }
}

// --- 新增: 鼠标移动事件处理 ---
const handleMouseMove = (event: MouseEvent) => {
  if (draggingCornerIndex.value === null || !canvas.value) return

  const pos = getMousePos(event)
  if (!pos) return

  const { width, height } = canvas.value.getBoundingClientRect()

  // 将坐标限制在 0-1 范围内
  const newX = Math.max(0, Math.min(1, pos.x / width))
  const newY = Math.max(0, Math.min(1, pos.y / height))

  const index = draggingCornerIndex.value

  // 定义对角顶点的索引
  const oppositeIndex = (index + 2) % 4
  const oppositeCorner = corners[oppositeIndex]

  // 获取由拖动点和对角点定义的矩形边界
  let minX = Math.min(newX, oppositeCorner.x)
  let maxX = Math.max(newX, oppositeCorner.x)
  let minY = Math.min(newY, oppositeCorner.y)
  let maxY = Math.max(newY, oppositeCorner.y)

  // 根据新的边界重新计算所有四个顶点的位置
  corners[0] = { x: minX, y: minY } // 左上
  corners[1] = { x: maxX, y: minY } // 右上
  corners[2] = { x: maxX, y: maxY } // 右下
  corners[3] = { x: minX, y: maxY } // 左下
}

// --- 新增: 鼠标松开事件处理 ---
const handleMouseUp = () => {
  if (draggingCornerIndex.value !== null) {
    // --- 新增: 保存边界数据 ---
    window.api.setBoundaryCorners(JSON.parse(JSON.stringify(corners)))
    // --- 结束 ---
  }
  draggingCornerIndex.value = null
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)
}

// --- 新增: 重置边界框到默认位置 ---
const resetBoundary = () => {
  const defaultCorners = [
    { x: 0.1, y: 0.1 }, // 左上
    { x: 0.9, y: 0.1 }, // 右上
    { x: 0.9, y: 0.9 }, // 右下
    { x: 0.1, y: 0.9 } // 左下
  ]
  corners.splice(0, corners.length, ...defaultCorners)
  // 保存重置后的默认值
  window.api.setBoundaryCorners(JSON.parse(JSON.stringify(corners)))
}
// --- 结束 ---

onMounted(async () => {
  // --- 新增: 加载已保存的边界数据 ---
  const savedCorners = await window.api.getBoundaryCorners()
  if (savedCorners && savedCorners.length === 4) {
    corners.splice(0, corners.length, ...savedCorners)
  }
  // --- 结束 ---

  // --- 新增: 加载地图图片 ---
  const img = new Image()
  img.src = '/Map.png'
  img.onload = () => {
    mapImage.value = img
  }
  img.onerror = (err) => {
    console.error('Failed to load map image:', err)
  }
  // --- 结束 ---
  if (canvas.value) {
    ctx = canvas.value.getContext('2d')
    resizeCanvas()
    resizeObserver = new ResizeObserver(resizeCanvas)
    if (mapPanel.value) {
      resizeObserver.observe(mapPanel.value)
    }
  }
  syncMqttRobots()
  draw()
  if (canvas.value) {
    canvas.value.addEventListener('click', handleMapClick)
  }
  // --- 新增: 为拖拽功能添加事件监听 ---
  if (canvas.value) {
    canvas.value.addEventListener('mousedown', handleMouseDown)
  }
  // --- 结束 ---
})

onUnmounted(() => {
  if (rafHandle) cancelAnimationFrame(rafHandle)
  stopSimulation()
  if (resizeObserver && mapPanel.value) {
    resizeObserver.unobserve(mapPanel.value)
  }
  // --- 新增: 移除事件监听 ---
  if (canvas.value) {
    canvas.value.removeEventListener('mousedown', handleMouseDown)
    canvas.value.removeEventListener('click', handleMapClick)
  }
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)
  // --- 结束 ---
})

// --- 新增: 处理组件激活/非激活状态 ---
onActivated(() => {
  window.addEventListener('keydown', handleKeyDown)
})

onDeactivated(() => {
  window.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <div class="telemetry-root">
    <div class="map-panel" ref="mapPanel">
      <canvas ref="canvas"></canvas>

      <!-- 新增: 提示文字 -->
      <div class="hint">
        <span>按 E 打开设置菜单</span>
        <span class="separator">|</span>
        <span>按 P 绘制虚拟边界</span>
        <template v-if="clickedFieldPoint">
          <span class="separator">|</span>
          <span>点击坐标 ({{ clickedFieldPoint.x.toFixed(1) }}, {{ clickedFieldPoint.y.toFixed(1) }})</span>
        </template>
      </div>

      <!-- 修改: 移除 controls-container -->

      <div class="legend">
        <div class="legend-item"><span class="dot red"></span> 红队</div>
        <div class="legend-item"><span class="dot blue"></span> 蓝队</div>
      </div>

      <!-- 新增: 控制功能弹窗 -->
      <Transition name="modal-fade">
        <div
          v-if="isControlsModalVisible"
          class="modal-backdrop"
          @click="isControlsModalVisible = false"
        >
          <div class="modal-content" style="width: 280px" @click.stop>
            <h4>功能控制</h4>
            <div class="modal-actions" style="flex-direction: column; gap: 12px">
              <button class="modal-button-secondary" @click="toggleSim">
                {{ simRunning ? '停止模拟' : '启动模拟' }}
              </button>
              <button class="modal-button-secondary" @click="resetBoundary">重置边界</button>
            </div>
          </div>
        </div>
      </Transition>
      <!-- 结束 -->

      <HudPanel
        title="红队状态"
        team="red"
        :initial-style="{ top: '12px', left: '12px', width: '280px' }"
      >
        <div class="telemetry-panel-body">
          <div class="list">
            <div
              v-for="r in redTeamRobots"
              :key="r.id"
              :class="{ 'robot-row': true, selected: selectedId === r.id }"
              @click="selectRobot(r.id)"
            >
              <span class="badge" :class="r.team">{{ r.id }}</span>
              <div class="meta">
                <span>HP: {{ r.hp }}%</span>
                <span>Pos: ({{ r.x.toFixed(1) }}, {{ r.y.toFixed(1) }})</span>
              </div>
            </div>
          </div>
        </div>
      </HudPanel>

      <HudPanel
        title="蓝队状态"
        team="blue"
        :initial-style="{ top: '12px', right: '12px', width: '280px' }"
      >
        <div class="telemetry-panel-body">
          <div class="list">
            <div
              v-for="r in blueTeamRobots"
              :key="r.id"
              :class="{ 'robot-row': true, selected: selectedId === r.id }"
              @click="selectRobot(r.id)"
            >
              <span class="badge" :class="r.team">{{ r.id }}</span>
              <div class="meta">
                <span>HP: {{ r.hp }}%</span>
                <span>Pos: ({{ r.x.toFixed(1) }}, {{ r.y.toFixed(1) }})</span>
              </div>
            </div>
          </div>
        </div>
      </HudPanel>
    </div>
  </div>
</template>

<style scoped>
.telemetry-root {
  width: 100%;
  height: 100%;
}
.map-panel {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.legend {
  position: absolute;
  left: 12px;
  top: 12px;
  display: flex;
  gap: 8px;
  z-index: 20;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.36);
  border-radius: 6px;
  font-size: 13px;
  color: #dbeafe;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.dot.red {
  background: #f87171;
}
.dot.blue {
  background: #60a5fa;
}

/* --- 新增: 提示文字样式 --- */
.hint {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  color: rgba(255, 255, 255, 0.38);
  font-size: 12px;
  z-index: 50;
  display: flex;
  gap: 12px;
  user-select: none;
  white-space: nowrap;
}

.separator {
  color: rgba(255, 255, 255, 0.15);
}
/* --- 结束 --- */

/* --- DELETED: Controls modal styles moved to modals.css --- */

/* --- DELETED: Button group styles moved to modals.css --- */

.telemetry-panel-body .list {
  /* No margin needed as it's the only element */
}

.robot-row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px;
  border-radius: 6px;
  margin-bottom: 6px;
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
}
.robot-row.selected {
  background: linear-gradient(90deg, rgba(59, 130, 246, 0.14), rgba(244, 63, 94, 0.06));
}
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 28px;
  border-radius: 6px;
  color: #fff;
  font-weight: 600;
  flex-shrink: 0;
}
.badge.red {
  background: #f87171;
}
.badge.blue {
  background: #60a5fa;
}
.meta {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: #cbd5e1;
  gap: 2px;
}
</style>
