import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig, normalizeConfig } from '../src/config.js'
import { ProtocolRegistry, UPLINK_TOPICS } from '../src/protocol.js'

test('loads the standalone V2.0.0 schema and exposes every MQTT topic', async () => {
  const config = loadConfig()
  const protocol = await ProtocolRegistry.load(config.protocol.protoFile)
  const messages = protocol.describe()

  assert.equal(messages.length, 36)
  assert.equal(messages.find((entry) => entry.name === 'GameStatus').officialFrequencyHz, 5)
  assert.equal(messages.find((entry) => entry.name === 'KeyboardMouseControl').direction, 'client-to-server')
  assert.equal(messages.find((entry) => entry.name === 'SentryCtrlResult').triggered, true)
  assert.equal(messages.find((entry) => entry.name === 'Buff').frequencyDescription, '获得时触发，随后 1Hz')
  assert.equal(UPLINK_TOPICS.size, 11)

  for (const message of messages) {
    assert.doesNotThrow(() => protocol.encode(message.name, message.preset), message.name)
  }
})

test('encodes and decodes GUI JSON as binary Protobuf', async () => {
  const config = loadConfig()
  const protocol = await ProtocolRegistry.load(config.protocol.protoFile)
  const payload = protocol.createPreset('GameStatus')
  const encoded = protocol.encode('GameStatus', payload)
  const decoded = protocol.decode('GameStatus', encoded)

  assert.ok(Buffer.isBuffer(encoded))
  assert.ok(encoded.length > 0)
  assert.equal(decoded.currentRound, 1)
  assert.equal(decoded.currentStage, 4)
  assert.equal(decoded.stageCountdownSec, 420)
})

test('uses the configured robot ID in all robot identity presets', async () => {
  const config = loadConfig()
  const protocol = await ProtocolRegistry.load(config.protocol.protoFile, { robotId: 3 })

  assert.equal(protocol.createPreset('RobotStaticStatus').robotId, 3)
  assert.equal(protocol.createPreset('RobotPosition').robotId, 3)
  assert.equal(protocol.createPreset('Buff').robotId, 3)
  assert.equal(protocol.createPreset('RobotPathPlanInfo').senderId, 3)
})

test('keeps the default robot health consistent across status presets', async () => {
  const config = loadConfig()
  const protocol = await ProtocolRegistry.load(config.protocol.protoFile)

  assert.equal(
    protocol.createPreset('GlobalUnitStatus').robotHealth[0],
    protocol.createPreset('RobotDynamicStatus').currentHealth
  )
})

test('accepts robot IDs from both teams and defaults to 1', () => {
  const base = { web: {}, mqtt: {}, udp_video: {}, protocol: {} }
  assert.equal(normalizeConfig(base).protocol.robotId, 1)
  assert.equal(normalizeConfig({ ...base, protocol: { robot_id: 107 } }).protocol.robotId, 107)
  assert.throws(
    () => normalizeConfig({ ...base, protocol: { robot_id: 8 } }),
    /protocol\.robot_id 必须是 1-7 或 101-107/
  )
})

test('supports bytes and nested repeated messages', async () => {
  const config = loadConfig()
  const protocol = await ProtocolRegistry.load(config.protocol.protoFile)

  const bytes = protocol.decode(
    'CustomByteBlock',
    protocol.encode('CustomByteBlock', { data: 'AQIDBA==' })
  )
  assert.equal(bytes.data, 'AQIDBA==')

  const radarPreset = protocol.createPreset('RadarInfoToClient')
  const radar = protocol.decode('RadarInfoToClient', protocol.encode('RadarInfoToClient', radarPreset))
  assert.equal(radar.RadarSingleRobotInfo.length, 2)
  assert.equal(radar.RadarSingleRobotInfo[0].targetPosX, 1200)
})
