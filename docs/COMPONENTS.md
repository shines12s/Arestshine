# 组件说明

## origin-client

```text
origin-client/
├─ src/
│  ├─ components/        HUD、状态条、控制度面板、地图
│  ├─ views/             Dashboard / Telemetry / Settings / CustomData
│  ├─ store/             Pinia、MQTT 数据
│  ├─ mqtt/              客户端 MQTT
│  └─ utils/             协议与配置
├─ resources/            2027 地图、机器人配置、MQTT 配置
└─ src-tauri/            Rust 后端：UDP、FFmpeg、MQTT、AI pipe
```

关键文件：

- `src/views/Telemetry.vue`：2027 地图、机器人位置、基地/前哨、地图点击坐标
- `src/components/Dashboard/MiniMap.vue`：小地图机器人位置
- `src/components/Dashboard/BattleControlPanel.vue`：控制度面板
- `src/store/modules/mqtt_data.ts`：MQTT 状态、控制度、前哨归属

## simulator

```text
simulator/
├─ src/server.js         HTTP + MQTT Broker + 状态调度
├─ src/protocol.js       protobuf 编解码、预设消息
├─ src/mqtt-broker.js    aedes Broker
├─ public/               网页控制台
├─ proto/messages.proto  协议
├─ config.yaml           MQTT/视频/协议配置
└─ test1.mp4             演示视频
```

网页控制：

- 重置比赛
- 机器人/空中系统
- 基地/前哨
- 地图坐标组
- 战场控制度
- 各机器人独立移动

## ai-server

```text
ai-server/
├─ server/pipe_server.py  命名管道服务
├─ server/Server.py       ONNX 推理
├─ model/armor.onnx
└─ model/car.onnx
```

协议：本机命名管道，Tauri 发送 base64 JPEG，Python 返回检测 JSON。

## 不进入仓库的构建产物

- Tauri `target/`
- 前端 `dist/`
- 依赖目录
- FFmpeg / WebView2 / 便携运行时
- 打包 ZIP
