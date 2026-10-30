/**
 * 浏览器版 Tauri API 适配层。
 *
 * 原版 OriginClient 的 `src/api-shim.ts` 只依赖：
 *   - `invoke(command, args)`  -> Rust command
 *   - `listen(event, handler)` -> Tauri event
 *   - `Channel`                -> Rust -> 前端二进制通道
 *
 * 在网页里，这三者分别映射到：
 *   - HTTP  /api/...            （origin-client-lite server/web-api.mjs）
 *   - SSE   /api/events         （命名事件）
 *   - no-op Channel             （视频走 MJPEG，不需要逐帧 Channel）
 *
 * 这样完整 Vue 界面不用改一行，只换掉 Tauri 运行时。
 */

const API_BASE =
  typeof window !== 'undefined' && window.location.port === '8080'
    ? ''
    : 'http://127.0.0.1:8080'

// `?static=1`：视频用单帧 JPEG 而不是 MJPEG 长连接，方便无头浏览器截图。
const STATIC_VIDEO =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('static')

function apiUrl(path) {
  return `${API_BASE}${path}`
}

async function request(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  })
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!response.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${response.status}`)
  }
  return data
}

function getJson(path) {
  return request(path)
}

function postJson(path, body = {}) {
  return request(path, { method: 'POST', body: JSON.stringify(body) })
}

function query(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value))
  }
  return search.toString()
}

/**
 * no-op 二进制通道。MJPEG 模式不需要逐帧 IPC。
 */
export class Channel {
  constructor(onmessage = null) {
    this.onmessage = onmessage
  }

  send(_data) {
    // 浏览器里没有 Rust -> JS 的二进制通道；帧由 <img src="/video.mjpg"> 消费。
  }
}

// ==================== 事件（SSE） ====================

const eventHandlers = new Map()
let eventSource = null

function ensureEventSource() {
  if (eventSource || typeof window === 'undefined') return
  eventSource = new EventSource(apiUrl('/api/events'))
  eventSource.onerror = () => {
    // EventSource 会自动重连；这里只提示一次，避免刷屏。
    if (!eventHandlers.has('__warned')) {
      console.warn('[web-tauri] SSE disconnected, retrying...')
      eventHandlers.set('__warned', new Set())
    }
  }
  eventSource.onopen = () => {
    eventHandlers.delete('__warned')
  }
}

export function listen(eventName, handler) {
  ensureEventSource()
  if (!eventHandlers.has(eventName)) {
    eventHandlers.set(eventName, new Set())
    eventSource?.addEventListener(eventName, (event) => {
      let payload = null
      try {
        payload = event.data ? JSON.parse(event.data) : null
      } catch {
        payload = event.data
      }
      const set = eventHandlers.get(eventName)
      if (!set) return
      for (const callback of [...set]) {
        try {
          callback({ event: eventName, payload })
        } catch (error) {
          console.warn(`[web-tauri] handler for ${eventName} failed`, error)
        }
      }
    })
  }
  const set = eventHandlers.get(eventName)
  set.add(handler)
  return Promise.resolve(() => set.delete(handler))
}

export async function emit(eventName, payload) {
  if (eventName === 'frontend-ready') {
    try {
      await postJson('/api/frontend-ready', {})
    } catch {
      // ignore
    }
  }
  // 其它 Tauri emit 在浏览器里没有对端，忽略。
  void payload
}

// ==================== 命令（HTTP） ====================

export async function invoke(command, args = {}) {
  switch (command) {
    // ---------- 设置 / 配置 ----------
    case 'get_setting':
      return getJson(`/api/settings/get?${query({ key: args.key })}`)
    case 'save_setting':
      return postJson('/api/settings/save', { key: args.key, value: args.value })
    case 'get_robot_config':
      return getJson('/api/config/robot')
    case 'get_robot_types':
      return getJson('/api/config/roboselect')
    case 'get_robot_config_by_name':
      return getJson(`/api/config/robot-by-name?${query({ name: args.name })}`)
    case 'read_yaml_config':
      return getJson(`/api/config/yaml?${query({ filename: args.filename })}`)

    // ---------- HUD ----------
    case 'hud_get_templates':
      return getJson('/api/hud/templates')
    case 'hud_save_template':
      return postJson('/api/hud/save', { filename: args.filename, content: args.content })
    case 'hud_update_template_title':
      return postJson('/api/hud/rename', { id: args.id, title: args.title })
    case 'hud_delete_template':
      return postJson('/api/hud/delete', { id: args.id })

    // ---------- DashboardConfig ----------
    case 'dashboard_config_list':
      return getJson('/api/dashboard/configs')
    case 'dashboard_config_load':
      return getJson(`/api/dashboard/config?${query({ filename: args.filename })}`)
    case 'dashboard_config_save':
      return postJson('/api/dashboard/save', {
        filename: args.filename,
        content: args.content
      })
    case 'dashboard_config_delete':
      return postJson('/api/dashboard/delete', { filename: args.filename })
    case 'dashboard_config_check_panel_usage':
      return postJson('/api/dashboard/usage', { panelId: args.panelId })

    // ---------- 图形库 ----------
    case 'graphic_get_all_categories':
      return getJson('/api/graphics/categories')
    case 'graphic_get_list':
      return getJson('/api/graphics/list')
    case 'graphic_save':
      return postJson('/api/graphics/save', { filename: args.filename, content: args.content })
    case 'graphic_delete':
      return postJson('/api/graphics/delete', { filename: args.filename })
    case 'graphic_rename':
      return postJson('/api/graphics/rename', {
        oldName: args.oldName,
        newName: args.newName
      })

    // ---------- MQTT ----------
    case 'mqtt_connect':
      return postJson('/api/mqtt/connect', { config: args.config || {} })
    case 'mqtt_disconnect':
      return postJson('/api/mqtt/disconnect', {})
    case 'mqtt_publish':
    case 'mqtt_publish_raw':
      return postJson('/api/mqtt/publish', { data: args.data })
    case 'mqtt_subscribe':
      return postJson('/api/mqtt/subscribe', { topics: args.topics || [] })
    case 'mqtt_unsubscribe':
      return postJson('/api/mqtt/unsubscribe', { topics: args.topics || [] })
    case 'mqtt_get_status':
      return getJson('/api/mqtt/status')
    case 'mqtt_get_stats':
      return getJson('/api/mqtt/stats')
    case 'mqtt_reset_stats':
      return postJson('/api/mqtt/reset', {})

    // ---------- UDP ----------
    case 'udp_stream_start': {
      const result = await postJson('/api/udp/start', { config: args.config || {} })
      if (STATIC_VIDEO) {
        return { ...result, mjpegStreamUrl: `${API_BASE}/api/frame.jpg` }
      }
      return result
    }
    case 'udp_stream_stop':
      return postJson('/api/udp/stop', {})
    case 'udp_stream_get_status':
      return getJson('/api/udp/status')
    case 'udp_stream_get_latest_mjpeg_frame':
      return getJson('/api/udp/latest-frame')
    case 'get_decode_capabilities':
      return getJson('/api/decode/capabilities')

    // ---------- 浏览器里的本地 AI / 窗口 / 文件桩 ----------
    case 'pipe_server_get_status':
      return { running: false, status: 'stopped', pid: null, pipe: '' }
    case 'pipe_server_start':
      return { success: false, error: 'AI Server is not available in the browser demo.' }
    case 'pipe_server_stop':
      return false
    case 'shm_connect':
      return false
    case 'shm_disconnect':
      return false
    case 'shm_status':
      return { connected: false, pipe: '', metrics: null }
    case 'shm_detect':
    case 'shm_detect_latest_mjpeg':
      return { success: false, error: 'AI detection is not available in the browser demo.' }
    case 'mqtt_start_local_broker':
      return { success: false, error: 'Use the Node broker on 127.0.0.1:3333.' }
    case 'mqtt_stop_local_broker':
      return true
    case 'mqtt_get_local_broker_status':
      return { status: 'stopped', port: 3333 }

    case 'select_directory':
    case 'select_file':
      return null
    case 'get_model_path':
      return null
    case 'toggle_fullscreen': {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
      else await document.exitFullscreen()
      return Boolean(document.fullscreenElement)
    }
    case 'set_fullscreen': {
      if (args.fullscreen && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
      } else if (!args.fullscreen && document.fullscreenElement) {
        await document.exitFullscreen()
      }
      return Boolean(document.fullscreenElement)
    }
    case 'window_minimize':
    case 'window_toggle_maximize':
    case 'app_close':
    case 'open_devtools':
      return null

    default:
      console.warn(`[web-tauri] unsupported command: ${command}`)
      return null
  }
}
