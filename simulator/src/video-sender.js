import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'

export const UDP_HEADER_BYTES = 8
export const UDP_MAX_DATAGRAM_BYTES = 1400
export const UDP_MAX_FRAGMENT_PAYLOAD_BYTES = UDP_MAX_DATAGRAM_BYTES - UDP_HEADER_BYTES
const MAX_CLIENT_FRAME_BYTES = 16 * 1024 * 1024

function findNalStarts(buffer) {
  const starts = []
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (buffer[index] !== 0 || buffer[index + 1] !== 0) continue

    let startCodeLength = 0
    if (buffer[index + 2] === 1) startCodeLength = 3
    if (buffer[index + 2] === 0 && buffer[index + 3] === 1) startCodeLength = 4
    if (!startCodeLength) continue

    const headerOffset = index + startCodeLength
    if (headerOffset >= buffer.length) break
    starts.push({
      offset: index,
      startCodeLength,
      nalType: (buffer[headerOffset] >> 1) & 0x3f
    })
    index = headerOffset
  }
  return starts
}

/**
 * Split an Annex-B HEVC byte stream at Access Unit Delimiter NAL units.
 * x265 is started with aud=1, so every encoded video frame begins with NAL 35.
 */
export class AnnexBAccessUnitParser {
  constructor(onAccessUnit) {
    this.onAccessUnit = onAccessUnit
    this.buffer = Buffer.alloc(0)
    this.started = false
  }

  push(chunk) {
    if (!chunk?.length) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk)
    this.#drain()

    if (this.buffer.length > MAX_CLIENT_FRAME_BYTES * 2) {
      throw new Error('H.265 码流中未找到 AUD 帧边界，请确认 FFmpeg/x265 支持 aud=1')
    }
  }

  flush() {
    if (this.started && this.buffer.length) this.onAccessUnit(this.buffer)
    this.buffer = Buffer.alloc(0)
    this.started = false
  }

  #drain() {
    const accessUnitStarts = findNalStarts(this.buffer).filter((entry) => entry.nalType === 35)
    if (accessUnitStarts.length < 2) return

    for (let index = 0; index < accessUnitStarts.length - 1; index += 1) {
      const start = index === 0 && !this.started ? 0 : accessUnitStarts[index].offset
      const end = accessUnitStarts[index + 1].offset
      if (end > start) this.onAccessUnit(this.buffer.subarray(start, end))
      this.started = true
    }

    this.buffer = this.buffer.subarray(accessUnitStarts.at(-1).offset)
  }
}

export function packetizeFrame(frame, frameNumber, fragmentPayloadBytes = 1392) {
  if (!Buffer.isBuffer(frame)) frame = Buffer.from(frame)
  if (frame.length === 0) throw new Error('不能发送空视频帧')
  if (frame.length > MAX_CLIENT_FRAME_BYTES) {
    throw new Error(`单帧 ${frame.length} 字节，超过客户端 16 MiB 安全限制`)
  }
  if (fragmentPayloadBytes < 1 || fragmentPayloadBytes > UDP_MAX_FRAGMENT_PAYLOAD_BYTES) {
    throw new Error(`UDP 分片负载必须在 1 到 ${UDP_MAX_FRAGMENT_PAYLOAD_BYTES} 字节之间`)
  }

  const fragmentCount = Math.ceil(frame.length / fragmentPayloadBytes)
  if (fragmentCount > 0xffff) throw new Error('单帧分片数超过 uint16 范围')

  const packets = []
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const offset = fragmentIndex * fragmentPayloadBytes
    const payload = frame.subarray(offset, Math.min(frame.length, offset + fragmentPayloadBytes))
    const packet = Buffer.allocUnsafe(UDP_HEADER_BYTES + payload.length)
    packet.writeUInt16BE(frameNumber & 0xffff, 0)
    packet.writeUInt16BE(fragmentIndex, 2)
    packet.writeUInt32BE(frame.length, 4)
    payload.copy(packet, UDP_HEADER_BYTES)
    packets.push(packet)
  }
  return packets
}

export function buildFfmpegArgs(config) {
  const filter = [
    `fps=${config.fps}`,
    `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease`,
    `pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'format=yuv420p'
  ].join(',')
  const x265Params = [
    `keyint=${config.gop}`,
    `min-keyint=${config.gop}`,
    'scenecut=0',
    'repeat-headers=1',
    'aud=1',
    'bframes=0',
    'log-level=error'
  ].join(':')

  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...(config.loop ? ['-stream_loop', '-1'] : []),
    '-re',
    '-i',
    config.videoPath,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    filter,
    '-c:v',
    'libx265',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-b:v',
    `${config.bitrateKbps}k`,
    '-maxrate',
    `${config.bitrateKbps}k`,
    '-bufsize',
    `${config.bitrateKbps}k`,
    '-g',
    String(config.gop),
    '-x265-params',
    x265Params,
    '-f',
    'hevc',
    'pipe:1'
  ]
}

export class VideoSender extends EventEmitter {
  constructor({ ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg' } = {}) {
    super()
    this.ffmpegPath = ffmpegPath
    this.child = null
    this.socket = null
    this.parser = null
    this.statsTimer = null
    this.config = null
    this.frameNumber = 0
    this.startedAt = null
    this.stopping = false
    this.counters = this.#emptyCounters()
    this.lastSnapshot = { frames: 0, bytes: 0, at: Date.now() }
  }

  #emptyCounters() {
    return { frames: 0, packets: 0, bytes: 0, droppedPackets: 0, encodeErrors: 0 }
  }

  get running() {
    return Boolean(this.child && !this.child.killed)
  }

  get state() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      config: this.config,
      stats: { ...this.counters }
    }
  }

  async start(config) {
    await this.stop()
    this.#validateConfig(config)

    this.config = { ...config }
    this.frameNumber = 0
    this.counters = this.#emptyCounters()
    this.lastSnapshot = { frames: 0, bytes: 0, at: Date.now() }
    this.startedAt = new Date().toISOString()
    this.stopping = false
    this.socket = dgram.createSocket('udp4')
    this.parser = new AnnexBAccessUnitParser((frame) => this.#sendFrame(frame))

    const child = spawn(this.ffmpegPath, buildFfmpegArgs(this.config), {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child

    child.stdout.on('data', (chunk) => {
      try {
        this.parser?.push(chunk)
      } catch (error) {
        this.counters.encodeErrors += 1
        this.emit('log', { level: 'error', source: 'UDP', message: error.message })
        void this.stop()
      }
    })

    let stderrRemainder = ''
    child.stderr.on('data', (chunk) => {
      stderrRemainder += chunk.toString('utf8')
      const lines = stderrRemainder.split(/\r?\n/)
      stderrRemainder = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.includes('set_mempolicy: Operation not permitted')) continue
        this.emit('log', { level: 'error', source: 'FFmpeg', message: trimmed })
      }
    })

    child.once('error', (error) => {
      this.counters.encodeErrors += 1
      this.emit('log', {
        level: 'error',
        source: 'FFmpeg',
        message: `无法启动 ${this.ffmpegPath}：${error.message}`
      })
    })

    child.once('close', (code, signal) => {
      try {
        this.parser?.flush()
      } catch {
        // Ignore a partial final access unit when FFmpeg is interrupted.
      }
      const expected = this.stopping
      this.#cleanupAfterClose()
      if (!expected && code !== 0) {
        this.emit('log', {
          level: 'error',
          source: 'FFmpeg',
          message: `视频编码进程退出：code=${code ?? 'null'}, signal=${signal ?? 'none'}`
        })
      } else if (!expected && !this.config?.loop) {
        this.emit('log', { level: 'info', source: 'UDP', message: '视频播放完毕' })
      }
      this.emit('state', this.state)
    })

    this.statsTimer = setInterval(() => this.#emitStats(), 1000)
    this.emit('log', {
      level: 'success',
      source: 'UDP',
      message: `循环发送 ${config.videoPath} -> ${config.targetHost}:${config.targetPort}`
    })
    this.emit('state', this.state)
    return this.state
  }

  async stop() {
    const child = this.child
    if (!child) {
      this.#cleanupAfterClose()
      return this.state
    }

    this.stopping = true
    await new Promise((resolve) => {
      let done = false
      let timer
      const finish = () => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        resolve()
      }
      child.once('close', finish)
      child.kill('SIGTERM')
      timer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
        finish()
      }, 2000)
      timer.unref()
    })
    this.#cleanupAfterClose()
    this.emit('state', this.state)
    return this.state
  }

  #validateConfig(config) {
    const ffmpeg = spawnSync(this.ffmpegPath, ['-version'], { stdio: 'ignore' })
    if (ffmpeg.error || ffmpeg.status !== 0) {
      throw new Error(`无法执行 ${this.ffmpegPath}，请先安装包含 libx265 的 FFmpeg`)
    }
    const stat = fs.statSync(config.videoPath, { throwIfNoEntry: false })
    if (!stat?.isFile()) {
      throw new Error(`视频文件不存在：${config.videoPath}。请修改 config.yaml 中的 video_path`)
    }
    if (config.fragmentPayloadBytes < 1 || config.fragmentPayloadBytes > 1392) {
      throw new Error('fragmentPayloadBytes 必须在 1 到 1392 之间')
    }
  }

  #sendFrame(frame) {
    if (!this.socket || !this.config || this.stopping) return

    let packets
    try {
      packets = packetizeFrame(frame, this.frameNumber, this.config.fragmentPayloadBytes)
    } catch (error) {
      this.counters.encodeErrors += 1
      this.emit('log', { level: 'error', source: 'UDP', message: error.message })
      return
    }

    this.frameNumber = (this.frameNumber + 1) & 0xffff
    this.counters.frames += 1

    for (const packet of packets) {
      if (Math.random() * 100 < this.config.packetLossPercent) {
        this.counters.droppedPackets += 1
        continue
      }
      this.socket.send(packet, this.config.targetPort, this.config.targetHost, (error) => {
        if (error) {
          this.emit('log', { level: 'error', source: 'UDP', message: error.message })
          return
        }
        this.counters.packets += 1
        this.counters.bytes += packet.length
      })
    }
  }

  #emitStats() {
    const now = Date.now()
    const elapsedSec = Math.max((now - this.lastSnapshot.at) / 1000, 0.001)
    const framesDelta = this.counters.frames - this.lastSnapshot.frames
    const bytesDelta = this.counters.bytes - this.lastSnapshot.bytes
    const payload = {
      ...this.counters,
      actualFps: Number((framesDelta / elapsedSec).toFixed(1)),
      bitrateMbps: Number(((bytesDelta * 8) / elapsedSec / 1_000_000).toFixed(2))
    }
    this.lastSnapshot = { frames: this.counters.frames, bytes: this.counters.bytes, at: now }
    this.emit('stats', payload)
  }

  #cleanupAfterClose() {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    this.child = null
    this.parser = null
    this.startedAt = null
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // Socket may already be closed.
      }
    }
    this.socket = null
  }
}
