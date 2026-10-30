import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import YAML from 'yaml'

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const SIMULATOR_DIR = path.resolve(CURRENT_DIR, '..')
export const DEFAULT_CONFIG_PATH = path.join(SIMULATOR_DIR, 'config.yaml')

function ensureObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`config.yaml 中的 ${name} 必须是对象`)
  }
  return value
}

function numberInRange(value, name, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`config.yaml 中的 ${name} 必须在 ${min} 到 ${max} 之间`)
  }
  return parsed
}

function robotIdInRange(value) {
  const parsed = Number(value)
  const valid = (parsed >= 1 && parsed <= 7) || (parsed >= 101 && parsed <= 107)
  if (!Number.isInteger(parsed) || !valid) {
    throw new Error('config.yaml 中的 protocol.robot_id 必须是 1-7 或 101-107')
  }
  return parsed
}

function resolveFromConfig(configPath, value) {
  if (!value) return value
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(configPath), value)
}

export function normalizeConfig(raw, configPath = DEFAULT_CONFIG_PATH) {
  const web = ensureObject(raw.web, 'web')
  const mqtt = ensureObject(raw.mqtt, 'mqtt')
  const udpVideo = ensureObject(raw.udp_video, 'udp_video')
  const protocol = ensureObject(raw.protocol, 'protocol')

  return {
    web: {
      host: String(web.host ?? '127.0.0.1'),
      port: numberInRange(web.port ?? 9130, 'web.port', 1, 65535),
      openBrowser: Boolean(web.open_browser ?? true)
    },
    mqtt: {
      host: String(mqtt.host ?? '127.0.0.1'),
      port: numberInRange(mqtt.port ?? 3333, 'mqtt.port', 1, 65535),
      qos: numberInRange(mqtt.qos ?? 1, 'mqtt.qos', 0, 1),
      expectedClientId: String(mqtt.expected_client_id ?? '')
    },
    udpVideo: {
      videoPath: resolveFromConfig(configPath, String(udpVideo.video_path ?? '')),
      loop: Boolean(udpVideo.loop ?? true),
      startOnLaunch: Boolean(udpVideo.start_on_launch ?? false),
      targetHost: String(udpVideo.target_host ?? '127.0.0.1'),
      targetPort: numberInRange(udpVideo.target_port ?? 3334, 'udp_video.target_port', 1, 65535),
      width: numberInRange(udpVideo.width ?? 1920, 'udp_video.width', 160, 7680),
      height: numberInRange(udpVideo.height ?? 1080, 'udp_video.height', 120, 4320),
      fps: numberInRange(udpVideo.fps ?? 60, 'udp_video.fps', 1, 120),
      bitrateKbps: numberInRange(
        udpVideo.bitrate_kbps ?? 4000,
        'udp_video.bitrate_kbps',
        100,
        100000
      ),
      gop: numberInRange(udpVideo.gop ?? 60, 'udp_video.gop', 1, 600),
      fragmentPayloadBytes: numberInRange(
        udpVideo.fragment_payload_bytes ?? 1392,
        'udp_video.fragment_payload_bytes',
        1,
        1392
      ),
      packetLossPercent: numberInRange(
        udpVideo.packet_loss_percent ?? 0,
        'udp_video.packet_loss_percent',
        0,
        100
      )
    },
    protocol: {
      protoFile: resolveFromConfig(configPath, String(protocol.proto_file ?? './proto/messages.proto')),
      robotId: robotIdInRange(protocol.robot_id ?? 1),
      // v2：启动后自动发布推荐状态流，便于“一键联调”。
      autoScenario: Boolean(protocol.auto_scenario ?? false)
    },
    configPath
  }
}

export function loadConfig(configPath = process.env.SIMULATOR_CONFIG || DEFAULT_CONFIG_PATH) {
  const absolutePath = path.resolve(configPath)
  const source = fs.readFileSync(absolutePath, 'utf8')
  const raw = YAML.parse(source)
  return normalizeConfig(raw, absolutePath)
}

export function saveConfig(config) {
  const configPath = config.configPath || DEFAULT_CONFIG_PATH
  const relativeProto = path.relative(path.dirname(configPath), config.protocol.protoFile) || '.'
  const document = {
    web: {
      host: config.web.host,
      port: config.web.port,
      open_browser: config.web.openBrowser
    },
    mqtt: {
      host: config.mqtt.host,
      port: config.mqtt.port,
      qos: config.mqtt.qos,
      expected_client_id: config.mqtt.expectedClientId
    },
    udp_video: {
      video_path: config.udpVideo.videoPath,
      loop: config.udpVideo.loop,
      start_on_launch: config.udpVideo.startOnLaunch,
      target_host: config.udpVideo.targetHost,
      target_port: config.udpVideo.targetPort,
      width: config.udpVideo.width,
      height: config.udpVideo.height,
      fps: config.udpVideo.fps,
      bitrate_kbps: config.udpVideo.bitrateKbps,
      gop: config.udpVideo.gop,
      fragment_payload_bytes: config.udpVideo.fragmentPayloadBytes,
      packet_loss_percent: config.udpVideo.packetLossPercent
    },
    protocol: {
      proto_file: relativeProto.startsWith('.') ? relativeProto : `./${relativeProto}`,
      robot_id: config.protocol.robotId,
      auto_scenario: Boolean(config.protocol.autoScenario)
    }
  }
  fs.writeFileSync(configPath, YAML.stringify(document), 'utf8')
}
