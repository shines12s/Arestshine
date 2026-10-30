import { createServer } from 'node:net'
import { EventEmitter } from 'node:events'

import { Aedes } from 'aedes'
import { connectAsync } from 'mqtt'

const PUBLISHER_CLIENT_ID = 'origin-protocol-simulator-server'

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) return resolve()
    server.close(() => resolve())
  })
}

export class MockMqttBroker extends EventEmitter {
  constructor({ protocol }) {
    super()
    this.protocol = protocol
    this.aedes = null
    this.server = null
    this.publisher = null
    this.publisherPromise = null
    this.publisherSeq = 0
    this.stopping = false
    this.host = null
    this.port = null
    this.clients = new Set()
    this.startedAt = null
  }

  /**
   * 按需建立发布端连接。
   *
   * 之前使用一个长期 publisher + mqtt.js 自动重连；在 Windows 上它偶尔
   * 会进入 close 后不恢复的状态，表现为 GUI 显示“MQTT Broker 尚未启动”，
   * 但 aedes 服务器其实还在监听。这里改成 publish 时确保连接：
   *   - 连接正常：直接复用；
   *   - 连接已断：重新 connect，后续定时器立即恢复；
   *   - 并发 publish：共用同一个连接 Promise，避免创建多个 client。
   */
  async #ensurePublisher() {
    if (this.stopping || !this.server?.listening) {
      throw new Error('MQTT Broker 尚未启动')
    }
    if (this.publisher?.connected) return this.publisher
    if (this.publisherPromise) return this.publisherPromise

    this.publisherPromise = (async () => {
      const oldPublisher = this.publisher
      this.publisher = null
      if (oldPublisher) {
        try {
          oldPublisher.removeAllListeners()
          oldPublisher.end(true)
        } catch {
          // ignore
        }
      }

      // 每次重连使用唯一 clientId，避免 aedes 把新连接当成旧 publisher 的重复 ID 顶掉。
      // 本地 broker 不需要 keepalive；关闭它可以避免事件循环短暂卡顿导致 publisher 被踢。
      const client = await connectAsync(`mqtt://127.0.0.1:${this.port}`, {
        clientId: `${PUBLISHER_CLIENT_ID}-${++this.publisherSeq}`,
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 0,
        keepalive: 0,
        connectTimeout: 5000
      })
      this.publisher = client
      client.on('close', () => {
        if (this.publisher === client) this.publisher = null
        this.emit('state', this.state)
      })
      client.on('error', (error) => {
        this.emit('log', {
          level: 'warning',
          source: 'MQTT',
          message: `发布端连接异常：${error.message}`
        })
      })
      this.emit('state', this.state)
      return client
    })()

    try {
      return await this.publisherPromise
    } finally {
      this.publisherPromise = null
    }
  }

  get running() {
    return Boolean(this.server?.listening && this.publisher?.connected)
  }

  get state() {
    return {
      running: this.running,
      host: this.host,
      port: this.port,
      clients: [...this.clients].sort(),
      startedAt: this.startedAt
    }
  }

  async start({ host = '127.0.0.1', port = 3333 } = {}) {
    if (this.server || this.aedes || this.publisher) await this.stop()

    const aedes = await Aedes.createBroker()
    const server = createServer(aedes.handle)
    this.aedes = aedes
    this.server = server
    this.host = host
    this.port = port

    aedes.on('clientReady', (client) => {
      if (!client?.id || client.id.startsWith(PUBLISHER_CLIENT_ID)) return
      this.clients.add(client.id)
      this.emit('client-change', this.state)
      this.emit('log', {
        level: 'success',
        source: 'MQTT',
        message: `客户端已连接：${client.id}`
      })
    })

    aedes.on('clientDisconnect', (client) => {
      if (!client?.id || client.id.startsWith(PUBLISHER_CLIENT_ID)) return
      this.clients.delete(client.id)
      this.emit('client-change', this.state)
      this.emit('log', {
        level: 'warning',
        source: 'MQTT',
        message: `客户端已断开：${client.id}`
      })
    })

    aedes.on('clientError', (client, error) => {
      this.emit('log', {
        level: 'error',
        source: 'MQTT',
        message: `客户端 ${client?.id ?? 'unknown'} 错误：${error.message}`
      })
    })

    aedes.on('publish', (packet, client) => {
      if (!packet?.topic || packet.topic.startsWith('$SYS/')) return
      const sourceClientId = client?.id ?? 'broker'
      const fromSimulator = sourceClientId.startsWith(PUBLISHER_CLIENT_ID)
      let decoded = null
      let decodeError = null

      if (this.protocol.hasTopic(packet.topic)) {
        try {
          decoded = this.protocol.decode(packet.topic, packet.payload)
        } catch (error) {
          decodeError = error.message
        }
      }

      this.emit('message', {
        direction: fromSimulator ? 'server-to-client' : 'client-to-server',
        clientId: sourceClientId,
        topic: packet.topic,
        qos: packet.qos,
        bytes: packet.payload?.length ?? 0,
        decoded,
        decodeError,
        rawHex: decoded ? null : Buffer.from(packet.payload ?? []).toString('hex').slice(0, 512)
      })
    })

    server.on('error', (error) => {
      this.emit('log', { level: 'error', source: 'MQTT', message: error.message })
    })

    try {
      await listen(server, port, host)
      const actualAddress = server.address()
      this.port = typeof actualAddress === 'object' && actualAddress ? actualAddress.port : port
      await this.#ensurePublisher()
      this.startedAt = new Date().toISOString()
      this.emit('state', this.state)
      this.emit('log', {
        level: 'success',
        source: 'MQTT',
        message: `Broker 已监听 ${host}:${this.port}（MQTT 3.1.1）`
      })
      return this.state
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop() {
    this.stopping = true
    const publisher = this.publisher
    const server = this.server
    const aedes = this.aedes

    this.publisher = null
    this.publisherPromise = null
    this.server = null
    this.aedes = null
    this.clients.clear()

    if (publisher) {
      try {
        await publisher.endAsync(true)
      } catch {
        publisher.end(true)
      }
    }
    await closeServer(server)
    if (aedes) await aedes.close()

    this.startedAt = null
    this.stopping = false
    this.emit('state', this.state)
  }

  async restart(config) {
    await this.stop()
    return this.start(config)
  }

  async publish(topic, payload, { qos = 1, retain = false } = {}) {
    if (![0, 1].includes(qos)) throw new Error('协议规定最高 QoS 为 1')
    const publisher = await this.#ensurePublisher()
    const encoded = this.protocol.encode(topic, payload)
    await publisher.publishAsync(topic, encoded, { qos, retain })
    return { topic, qos, retain, bytes: encoded.length }
  }
}
