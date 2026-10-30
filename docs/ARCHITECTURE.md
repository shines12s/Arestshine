# 架构与数据流

```text
┌──────────────────────┐        MQTT 3333        ┌──────────────────────┐
│  simulator (Node)    │ ──────────────────────> │ origin-client (Tauri)│
│  aedes + protobufjs  │ <────────────────────── │ Vue 3 + Rust         │
│  H.265 UDP 3334      │ ──────────────────────> │ UDP + FFmpeg         │
└──────────────────────┘                         └──────────┬───────────┘
                                                             │ named pipe
                                                             ▼
                                                  ┌──────────────────────┐
                                                  │ ai-server (Python)   │
                                                  │ ONNX Runtime         │
                                                  └──────────────────────┘
```

## 数据类型

- `GlobalUnitStatus`：基地/前哨血量、双方机器人血量
- `RobotStaticStatus` / `RobotDynamicStatus`：机器人型号、血量、热量、弹药
- `RobotPosition`：机器人地图坐标
- `Event`：比赛事件、基地/前哨归属、控制度、地图坐标组
- `CustomByteBlock`：机器人自定义数据
- `SentryStatusSync`：哨兵状态
- `AirSupportStatusSync`：旧空援协议（不自动发送）

## 坐标

场地：

```text
28m × 15m
x: 0..28
y: 0..15
```

机器人地图位置由模拟器 `positions:` Event 统一发送：

```text
positions:<robotId>,<x>,<y>;...
```

## 控制度

模拟器计算：

- 控制全部 2 个前哨阵地：+1/s
- 控制全部 2 个基地阵地：+3/s
- 比赛重置清零

客户端只显示模拟器状态。

## 图传

模拟器 FFmpeg 生成 H.265 Annex-B，按协议封装为 UDP 包发到 `3334`。  
Origin Tauri 接收 UDP，FFmpeg 解码，WebView2 显示。
