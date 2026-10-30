# OriginClient Protocol Simulator v2

> 面向 RoboMaster 2026 自定义客户端的**独立本地协议对端**：
> MQTT 3.1.1 Broker + 36 个 Protobuf topic 编辑器 + FFmpeg H.265 循环图传 + Web 控制台。
>
> 本目录可独立复制、安装和运行，不导入 `OriginClient` 的 Vue / Rust / `node_modules`。

## 1. 相对上游的 v2 改动

| 项 | v1 / 上游 | v2 |
|---|---|---|
| 启动后状态 | 需手动点“启动推荐场景” | `protocol.auto_scenario: true` 自动发布 8 条推荐状态流 |
| 图传启动 | 默认关闭 | `udp_video.start_on_launch: true` 启动即发 H.265 |
| 默认视频 | 占位 Linux 路径 | 自带 `test1.mp4`，1280×720@30，2 Mbps |
| 机器人 ID | 1 | 3（红方 3 号步兵，与完整 UI 当前机器人一致） |
| 日志噪声 | 每个下游消息都记录 | 下游 5 秒采样、上行 500ms，避免刷屏 |
| Windows 启动 | 仅 `start.sh` | 新增 `start.cmd`，自动设置 FFmpeg 路径 |
| 客户端集成 | 独立模拟器 | 配合 `origin-client-lite` 的 **external broker 模式** + FFmpeg H.265 解码，完整 Vue UI 直接显示真实 H.265 |

## 2. 架构

```
┌──────────────────────────────┐
│ Browser GUI :9130            │
│ 36 topic 编辑器 / 推荐场景    │
│ Broker 状态 / 视频控制 / 日志 │
└──────────────┬───────────────┘
               │ HTTP + SSE
┌──────────────▼───────────────┐
│ src/server.js                │
│  ├─ aedes MQTT Broker :3333  │
│  ├─ mqtt publisher client    │
│  ├─ ProtocolRegistry (proto) │
│  ├─ Schedule Manager         │
│  └─ VideoSender              │
│       └─ FFmpeg libx265      │
│            aud=1 / Annex-B   │
└──────────────┬───────────────┘
               │ UDP 8B header, <=1400B
               ▼
       127.0.0.1:3334
```

## 3. 启动

### 3.1 只启动模拟器

```powershell
cd origin-simulator-v2
.\start.cmd
```

Ubuntu：

```bash
cd origin-simulator-v2
chmod +x start.sh
./start.sh
```

`start.sh` 会优先用 `pnpm install --frozen-lockfile`，没有 pnpm 时回退 `npm install`；不再依赖上游的 `package-lock.json`。

打开：<http://127.0.0.1:9130/>

`start.cmd` 会设置：

- Node：`C:\Users\HUAWEI\.dsh\...\node.exe`
- FFmpeg：`C:\Users\HUAWEI\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg...\ffmpeg.exe`

### 3.2 连同完整客户端一起启动

在仓库根目录：

```powershell
.\start-full-h265.cmd
```

会按顺序启动：

1. 模拟器（9130 / 3333 / 3334）
2. 客户端后端 `origin-client-lite` 的 external-broker 模式（8080，H.265→JPEG→MJPEG）
3. 完整 OriginClient Vue UI（1420）

打开：

- 客户端：<http://127.0.0.1:1420/>
- 模拟器：<http://127.0.0.1:9130/>

## 4. 配置 `config.yaml`

| 配置 | v2 默认 | 说明 |
|---|---|---|
| `web.host/port` | `127.0.0.1:9130` | 控制台 |
| `mqtt.host/port` | `127.0.0.1:3333` | 本地 Broker |
| `mqtt.qos` | `1` | 发布 QoS |
| `mqtt.expected_client_id` | `"3"` | 客户端 ID 检查，不匹配只警告 |
| `udp_video.video_path` | `./test1.mp4` | 循环视频；支持绝对路径 |
| `udp_video.start_on_launch` | `true` | 启动即发图传 |
| `udp_video.target_host/port` | `127.0.0.1:3334` | 客户端 UDP 接收端 |
| `udp_video.width/height` | `1280×720` | 输出分辨率 |
| `udp_video.fps` | `30` | 输出帧率 |
| `udp_video.bitrate_kbps` | `2000` | H.265 目标码率 |
| `udp_video.gop` | `30` | 关键帧间隔 |
| `udp_video.fragment_payload_bytes` | `1392` | 8B 头后的负载 |
| `udp_video.packet_loss_percent` | `0` | 人工丢包测试 |
| `protocol.proto_file` | `./proto/messages.proto` | 36 topic 的协议源 |
| `protocol.robot_id` | `3` | 静态/位置/Buff/PathPlan 的机器人 ID |
| `protocol.auto_scenario` | `true` | 启动后自动发推荐状态流 |

环境变量：

```powershell
$env:SIMULATOR_CONFIG = "C:\path\to\another.yaml"
$env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
```

## 5. GUI 功能

- **MQTT Broker**：监听地址/端口、重启、已连接客户端列表、Client ID 警告。
- **推荐状态流**：8 个 topic（GameStatus、GlobalUnitStatus、GlobalLogisticsStatus、RobotStaticStatus、RobotDynamicStatus、RobotModuleStatus、RobotPosition、SentryStatusSync），按官方频率发送。
- **Protobuf 消息编辑器**：36 个 topic；字段名/类型/方向/频率；camelCase JSON；发送一次；0.1–100Hz 定时发送；恢复示例。
- **H.265 图传**：视频路径、目标 IP/端口、宽高、FPS、码率、GOP、分片负载、丢包率、开始/停止。
- **日志**：MQTT 上下行、FFmpeg、UDP、配置变更；下行 5 秒采样。

## 5.1 基地 / 前哨演练

GUI 中新增“基地 / 前哨演练”卡片：

- 基地初始/上限 `10000`，前哨 `1000`；
- 基地扣 2000、前哨扣 300；
- 击毁前哨；
- 重建并换归属（默认 500 血）；
- 重置 `10000/1000` 与红/蓝归属。

对应 API：

```text
POST /api/demo/global-unit
POST /api/demo/base
POST /api/demo/outpost
POST /api/demo/robot
POST /api/demo/air
POST /api/demo/position
POST /api/demo/positions
POST /api/demo/control
POST /api/demo/reset
```

`/api/demo/base` 接受：

```json
{ "position": "blue", "action": "damage", "damage": 2000 }
```

按当前机器人红/蓝视角更新对应的 `baseHealth` / `enemyBaseHealth`，网页端“基地扣血目标”下拉框会传这个参数。

`/api/demo/outpost` 会同时发布 `GlobalUnitStatus` 和 `Event 2`：

```text
outpost:<position>:<owner>:<health>
```

客户端按 `position` 固定物理位置，`owner` 单独保存，因此重建后可以显示新的归属方和 500 血。

`/api/demo/robot` 接受 `{ "robotId": 1 }` 等值，切换模拟器当前机器人；浏览器/Tauri 客户端的角色选择会调用它。

`/api/demo/air` 接受机库和 4 个单元状态，并由模拟器以 0.5Hz 的 `Event` 发送：

```json
{
  "hangarCount": 4,
  "units": [
    { "state": "READY" },
    { "state": "READY" },
    { "state": "CHARGING" },
    { "state": "ACTIVE" }
  ]
}
```

`Event.param` 格式：

```text
air:<hangar>:<READY,READY,CHARGING,ACTIVE>:<healths>:<energies>
```

客户端不再预置空中单元状态，只解析模拟器事件。

`/api/demo/position` 接受 `{ "x": 20.5, "y": 8.5, "yaw": 1.2 }`，更新当前机器人 `RobotPosition` 定时状态。

`/api/demo/positions` 发送一组已知地图坐标（默认覆盖 1/3/4/7 与 101/103/104/107），并附带一条全量 `positions:<id>,<x>,<y>;...` Event。

默认开启独立移动：每台演示机器人有自己的 `enabled / speed / direction / phase`，模拟器每 200ms 用一条 `positions:` Event 发送全部 8 台坐标，客户端 MiniMap/遥测按同一坐标绘制。网页上的“各机器人独立移动”复选框可整体停止/恢复；也可用 `/api/demo/motion` 传 `robotId` 单独控制某一台。

`/api/demo/control` 接受四块阵地的归属和控制状态：

```json
{
  "positions": {
    "redBase": { "owner": "red", "state": "COMPLETE" },
    "blueBase": { "owner": "red", "state": "COMPLETE" },
    "redOutpost": { "owner": "red", "state": "TEMPORARY" },
    "blueOutpost": { "owner": "red", "state": "TEMPORARY" }
  }
}
```

模拟器每秒计算：控制全部 2 前哨 +1 控制度，控制全部 2 基地 +3 控制度；`{"reset":true}` 清零累计值。

## 6. H.265 与 UDP 分包

FFmpeg 参数（`src/video-sender.js`）：

```
libx265 preset=ultrafast tune=zerolatency
x265-params: keyint=GOP:min-keyint=GOP:scenecut=0:
             repeat-headers=1:aud=1:bframes=0
```

- `aud=1`：每帧前插入 AUD NAL（类型 35），发送端按 AUD 切 Access Unit。
- 每个包：

```
0..1  frame_seq   u16 BE
2..3  frag_idx    u16 BE
4..7  total_bytes u32 BE
8..   payload     <= 1392
```

- 单包 ≤ 1400 B；帧序号回绕；接收端按 `frame_seq` 重组。

## 7. 与客户端联调

客户端后端 `origin-client-lite` 使用：

```powershell
$env:ORIGIN_EXTERNAL_BROKER=1
$env:FFMPEG_PATH="...\ffmpeg.exe"
node server/index.mjs
```

- 不启动自己的 Broker，连接模拟器的 `3333`；
- UDP 接收 `3334`，识别 H.265；
- `server/h265-decoder.mjs` 用 FFmpeg 常驻进程解码为 JPEG；
- 通过 `MjpegBroadcaster` 输出 `/video.mjpg` 给完整 Vue UI。

## 8. 测试

```powershell
cd origin-simulator-v2
node --test
node --check src/server.js
```

覆盖：

- 36 个 topic 的 proto 加载、编码/解码；
- MQTT 3.1.1 / QoS 1 / Client ID / 二进制消息；
- UDP 8 字节头、1400 上限、分片/重组；
- FFmpeg 生成真实 MP4 → H.265 → UDP 端到端。

## 9. 常见问题

- **视频文件不存在**：改 `udp_video.video_path` 为绝对路径。
- **无法启动 FFmpeg**：确认 `FFMPEG_PATH` 指向包含 `libx265` 与 HEVC 解码的构建。
- **EADDRINUSE**：3333/3334/9130 被占用；先关闭旧进程或改 YAML。
- **客户端没有数据**：确认模拟器 GUI 的推荐场景在运行，客户端 MQTT 已连接 3333。
- **有连接无画面**：确认客户端 UDP 监听 3334，`fragment_payload_bytes ≤ 1392`，丢包率 0。
- **H.265 解码日志有 PPS 警告**：客户端从 GOP 中间接入时会出现，关键帧到达后恢复；后端已过滤重复提示。
