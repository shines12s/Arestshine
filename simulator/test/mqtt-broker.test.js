import assert from 'node:assert/strict'
import test from 'node:test'

import { connectAsync } from 'mqtt'

import { loadConfig } from '../src/config.js'
import { MockMqttBroker } from '../src/mqtt-broker.js'
import { ProtocolRegistry } from '../src/protocol.js'

test('standalone broker delivers QoS 1 Protobuf to an OriginClient-like subscriber', async () => {
  const config = loadConfig()
  const protocol = await ProtocolRegistry.load(config.protocol.protoFile)
  const broker = new MockMqttBroker({ protocol })
  let client

  try {
    await broker.start({ host: '127.0.0.1', port: 0 })
    client = await connectAsync(`mqtt://127.0.0.1:${broker.port}`, {
      clientId: '1',
      protocolVersion: 4,
      reconnectPeriod: 0
    })
    await client.subscribeAsync('GameStatus', { qos: 1 })

    const received = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MQTT receive timeout')), 3000)
      client.once('message', (topic, payload) => {
        clearTimeout(timeout)
        resolve({ topic, payload })
      })
    })
    await broker.publish('GameStatus', protocol.createPreset('GameStatus'), { qos: 1 })

    const message = await received
    assert.equal(message.topic, 'GameStatus')
    assert.equal(protocol.decode(message.topic, message.payload).currentStage, 4)
  } finally {
    if (client) await client.endAsync(true)
    await broker.stop()
  }
})
