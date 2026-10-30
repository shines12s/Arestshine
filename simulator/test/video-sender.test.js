import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  AnnexBAccessUnitParser,
  packetizeFrame,
  UDP_MAX_DATAGRAM_BYTES,
  VideoSender
} from '../src/video-sender.js'

test('packetizer writes the exact 8-byte big-endian protocol header', () => {
  const frame = Buffer.alloc(4000, 0x5a)
  const packets = packetizeFrame(frame, 0x1234, 1392)

  assert.equal(packets.length, 3)
  assert.ok(packets.every((packet) => packet.length <= UDP_MAX_DATAGRAM_BYTES))
  packets.forEach((packet, index) => {
    assert.equal(packet.readUInt16BE(0), 0x1234)
    assert.equal(packet.readUInt16BE(2), index)
    assert.equal(packet.readUInt32BE(4), frame.length)
  })
  assert.deepEqual(Buffer.concat(packets.map((packet) => packet.subarray(8))), frame)
})

test('Annex-B parser separates HEVC access units on AUD NAL type 35', () => {
  const aud = Buffer.from([0, 0, 0, 1, 35 << 1, 1])
  const slice = Buffer.from([0, 0, 1, 1 << 1, 1, 2, 3])
  const stream = Buffer.concat([aud, slice, aud, slice, aud, slice])
  const frames = []
  const parser = new AnnexBAccessUnitParser((frame) => frames.push(Buffer.from(frame)))

  parser.push(stream.subarray(0, 11))
  parser.push(stream.subarray(11))
  parser.flush()

  assert.equal(frames.length, 3)
  assert.ok(frames.every((frame) => frame.includes(slice)))
})

test('loops a real video, transcodes it to H.265 and emits protocol UDP packets', { timeout: 20000 }, async (t) => {
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  if (ffmpeg.error || ffmpeg.status !== 0) {
    t.skip('ffmpeg is unavailable')
    return
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-protocol-sim-'))
  const videoPath = path.join(tempDir, 'loop-source.mp4')
  const generate = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=320x180:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt',
      'yuv420p', '-y', videoPath
    ],
    { encoding: 'utf8' }
  )
  assert.equal(generate.status, 0, generate.stderr)

  const receiver = dgram.createSocket('udp4')
  await new Promise((resolve) => receiver.bind(0, '127.0.0.1', resolve))
  const receiverPort = receiver.address().port
  const sender = new VideoSender()

  try {
    const completedFrame = new Promise((resolve, reject) => {
      const assemblies = new Map()
      const timeout = setTimeout(() => reject(new Error('UDP video receive timeout')), 10000)
      receiver.on('message', (packet) => {
        assert.ok(packet.length <= 1400)
        const frameNumber = packet.readUInt16BE(0)
        const fragmentIndex = packet.readUInt16BE(2)
        const totalSize = packet.readUInt32BE(4)
        const entry = assemblies.get(frameNumber) ?? { totalSize, fragments: new Map(), bytes: 0 }
        if (!entry.fragments.has(fragmentIndex)) {
          entry.fragments.set(fragmentIndex, Buffer.from(packet.subarray(8)))
          entry.bytes += packet.length - 8
        }
        assemblies.set(frameNumber, entry)
        if (entry.bytes >= totalSize) {
          clearTimeout(timeout)
          resolve({ frameNumber, entry })
        }
      })
    })

    await sender.start({
      videoPath,
      loop: true,
      targetHost: '127.0.0.1',
      targetPort: receiverPort,
      width: 320,
      height: 180,
      fps: 10,
      bitrateKbps: 500,
      gop: 10,
      fragmentPayloadBytes: 1392,
      packetLossPercent: 0
    })

    const { entry } = await completedFrame
    const indexes = [...entry.fragments.keys()].sort((a, b) => a - b)
    assert.deepEqual(indexes, indexes.map((_, index) => index))
    const rebuilt = Buffer.concat(indexes.map((index) => entry.fragments.get(index)))
    assert.equal(rebuilt.length, entry.totalSize)
    assert.ok(rebuilt.includes(Buffer.from([0, 0, 0, 1])))
    assert.ok(sender.state.stats.frames >= 1)
  } finally {
    await sender.stop()
    receiver.close()
    // Windows 上 FFmpeg 句柄释放略慢，给临时目录清理留重试窗口。
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
