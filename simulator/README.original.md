# OriginClient 本地通信协议模拟器

### !!! 图传加载很慢，要等一会儿，启动默认比赛开始
这是一个可单独复制、安装和运行的调试工具，用于模拟 RoboMaster 2026 自定义客户端的两条输入链路：

- MQTT 服务器：在本机启动 MQTT 3.1.1 Broker，按 topic 名发布 Protobuf v3 二进制数据，并解码显示客户端发回的上行消息。
- UDP 图传发送端：循环读取本地视频，经 FFmpeg 实时转换为 H.265/HEVC Annex-B，按官方 8 字节大端协议头分片发送。

模拟器运行时只读取本目录内的 `config.yaml`、`proto/messages.proto`、前端页面和自身 Node.js 依赖，不导入 OriginClient 的 Vue、Rust、资源配置或 `node_modules`。因此可将整个 `tools/protocol-simulator/` 目录复制到另一台 Ubuntu 电脑独立运行。

## 零、与 OriginClient 分目录部署

解压独立压缩包后，建议保持下面的并列目录结构。模拟器不能放进 OriginClient 的源码目录中，两者也不应由同一个启动脚本拉起：

```text
~/RoboMaster/
├── OriginClient/                    # 原客户端目录
└── OriginClientProtocolSimulator/   # 本模拟器目录
```

使用两个终端分别启动：

```bash
# 终端一：按客户端原有方式启动 OriginClient
cd ~/OriginClient
npm run tauri -- dev
```

```bash
# 终端二：单独启动模拟器
cd ~/OriginClientProtocolSimulator
./start.sh
```

两者之间仅通过 `127.0.0.1:3333` 的 MQTT 和发往 `127.0.0.1:3334` 的 UDP 通信，不共享工作目录、依赖、配置文件或进程生命周期。关闭其中一个不会自动关闭另一个。

## 一、快速启动

### 1. 填写循环视频路径

编辑 `config.yaml`：

```yaml
udp_video:
  video_path: "/home/lyu/Videos/debug-video.mp4"
  loop: true
```

输入可为 MP4、MOV、MKV、AVI 等 FFmpeg 能读取的视频。路径建议使用绝对路径；包含中文或空格也可以，YAML 中保留引号即可。

### 2. 一键启动

解压后直接执行本目录的脚本：

```bash
cd ~/OriginClientProtocolSimulator
./start.sh
```

启动脚本会检查 Node.js 20+、npm 和 FFmpeg，首次运行通过 `npm ci` 安装本目录依赖，然后自动打开：

```text
http://127.0.0.1:9130
```

按 `Ctrl+C` 会停止定时 MQTT 数据、FFmpeg、UDP Socket、Broker 和 GUI 服务。

### 3. 配置 OriginClient

| 项目 | 本地联调值 |
| --- | --- |
| MQTT Broker | `mqtt://127.0.0.1:3333` |
| MQTT Client ID | 当前机器人 ID，例如哨兵填 `7` |
| MQTT 订阅 | 客户端按现有 topic 列表订阅；调试工具发布的 topic 即 Protobuf 消息名 |
| UDP 监听地址 | `0.0.0.0` |
| UDP 监听端口 | `3334` |
| UDP 来源过滤 | 留空，或填 `127.0.0.1` |
| 视频编码 | `H.265/HEVC` 或自动检测 |

本地 Broker 不依赖 Client ID 决定消息路由，因此不会拒绝其他 ID；GUI 会列出实际连接的 Client ID，并在与 `config.yaml` 的 `expected_client_id` 不符时警告。真实赛场服务器仍要求 Client ID 使用所连接机器人的 ID。

## 二、GUI 功能

### MQTT Broker

- 修改监听 IP 和端口并重启 Broker。
- 查看当前连接的客户端及 Client ID。
- 查看 OriginClient 发布的 `KeyboardMouseControl`、`CustomControl`、`MapClickCmd` 等上行数据；高频消息会按 250 ms 节流显示，实际 Broker 转发不受影响。

### Protobuf 消息编辑器

- 从 36 个协议 topic 中选择消息。
- 查看字段名、类型、方向和协议频率。
- 使用 camelCase JSON 修改字段并发送一次。
- 以 0.1-100 Hz 定时发送；正式联调建议不超过界面显示的协议频率。
- 一键启动推荐状态流，包括 `GameStatus`、机器人静态/动态状态、模块、位置和哨兵姿态。

所有数据均由模拟器自带的 `proto/messages.proto` 运行时编码为 Protobuf 二进制，不会把 JSON 文本直接发到 MQTT。

### 循环视频 UDP 图传

- 从 YAML 加载视频路径，也可在 GUI 临时修改。
- 选择“同步写入 config.yaml”后，GUI 中的视频参数会持久保存。
- 可调整目标 IP/端口、宽高、FPS、H.265 码率、GOP、UDP 分片负载和模拟丢包率。
- “循环播放”使用 FFmpeg `-stream_loop -1`，到视频末尾后从头继续。
- 输入视频无论原编码为何，都会统一转码为标准 H.265 Annex-B。

## 三、YAML 配置说明

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `web.host` / `web.port` | `127.0.0.1` / `9130` | GUI HTTP 服务，仅本机访问 |
| `web.open_browser` | `true` | 启动后自动打开默认浏览器 |
| `mqtt.host` / `mqtt.port` | `127.0.0.1` / `3333` | 本地 MQTT Broker |
| `mqtt.qos` | `1` | 模拟器发布消息的默认 QoS |
| `mqtt.expected_client_id` | `"1"` | GUI 用于检查客户端机器人 ID |
| `protocol.robot_id` | `1` | `RobotStaticStatus`、`RobotPosition`、`Buff` 的 `robot_id` 以及 `RobotPathPlanInfo` 的 `sender_id`；合法范围为 `1-7` 或 `101-107` |
| `udp_video.video_path` | 占位路径 | 循环播放的视频绝对路径 |
| `udp_video.loop` | `true` | 视频结尾后从头循环 |
| `udp_video.start_on_launch` | `false` | 启动模拟器后自动开始图传；路径有效时才建议开启 |
| `udp_video.target_host` / `target_port` | `127.0.0.1` / `3334` | OriginClient UDP 接收端 |
| `udp_video.width` / `height` | `1920` / `1080` | 输出分辨率，符合 PDF 默认规范 |
| `udp_video.fps` | `60` | 输出帧率，符合 PDF 默认规范 |
| `udp_video.bitrate_kbps` | `4000` | H.265 目标码率 |
| `udp_video.gop` | `60` | 关键帧间隔；默认每秒一个关键帧 |
| `udp_video.fragment_payload_bytes` | `1392` | 8 字节头之外的负载，不能大于 1392 |
| `udp_video.packet_loss_percent` | `0` | 人工随机丢包，用于验证客户端恢复策略 |
| `protocol.proto_file` | `./proto/messages.proto` | 模拟器自带协议文件 |

环境变量 `SIMULATOR_CONFIG` 可指定另一份 YAML：

```bash
SIMULATOR_CONFIG=/path/to/my-simulator.yaml ./start.sh
```

## 四、UDP 分包规范

每个 UDP 数据报由 8 字节协议头和最多 1392 字节 H.265 帧数据组成，总长度不超过 1400 字节：

| 偏移 | 长度 | 类型 | 字节序 | 内容 |
| ---: | ---: | --- | --- | --- |
| 0 | 2 B | `uint16` | 大端 | 帧编号，发送后递增并自然回绕 |
| 2 | 2 B | `uint16` | 大端 | 当前帧内分片序号，从 0 开始 |
| 4 | 4 B | `uint32` | 大端 | 当前完整 H.265 帧的总字节数 |
| 8 | ≤ 1392 B | bytes | - | 当前分片负载 |

FFmpeg/x265 通过 `aud=1` 为每帧插入 Access Unit Delimiter。模拟器以 AUD NAL（类型 35）识别帧边界，随后再执行 UDP 分片，而不是按任意 stdout 块发送。

## 五、测试与排错

运行完整测试：

```bash
cd tools/protocol-simulator
npm test
```

测试覆盖：

- 36 个 topic 的独立 proto 加载与 Protobuf 编解码。
- MQTT 3.1.1、QoS 1、Client ID 和二进制消息收发。
- UDP 8 字节大端头、1400 字节上限和帧重组。
- 临时生成真实 MP4，循环转码 H.265，再通过本机 UDP 完成端到端接收。

常见问题：

- `视频文件不存在`：先修改 `config.yaml` 的 `video_path`，或在 GUI 输入绝对路径。
- `EADDRINUSE`：3333 或 9130 已被其他程序占用；先关闭旧进程，或修改 YAML。
- `无法启动 ffmpeg`：Ubuntu 执行 `sudo apt install ffmpeg`，并确认该构建包含 `libx265`。
- MQTT 已连接但没有数据：在 GUI 点击“启动推荐场景”或“发送一次”；Broker 启动不代表自动发布全部消息。
- 图传有连接但无画面：先保持 `packet_loss_percent: 0`，确认客户端监听 3334 且未错误过滤 UDP 来源。
