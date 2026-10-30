# AI Server（本地 ONNX 检测）

这是 Tauri 桌面版使用的外置 Python 检测服务，不需要浏览器。

## 目录

```text
AI Server/
  .venv/                 Python 虚拟环境（Tauri 优先使用）
  model/
    armor.onnx           装甲板检测/分类模型
    car.onnx             车辆检测模型
  server/
    Server.py            ONNX Runtime 推理封装
    pipe_server.py       Windows Named Pipe / Unix socket 服务
  requirements.txt
```

## 模型

当前模型来自公开仓库：

- <https://github.com/Y-Tomorrow/PFA_radar-2025>
- `models/armor.onnx`、`models/car.onnx`
- 仓库许可证：GPL-2.0

模型输出：

```text
armor: [1, 25200, 17] = 4 bbox + 1 objectness + 12 类（B1..R7）
car:   [1, 25200, 10] = 4 bbox + 1 objectness + 5 类
```

服务只保留 2026 地面阵容的 `R1/R3/R4/R7` 与 `B1/B3/B4/B7`，模型中的 2/5 类不会进入 HUD。

## 运行

```powershell
cd "AI Server"
.\.venv\Scripts\python.exe server\pipe_server.py
```

看到：

```text
[PipeServer] ready
Windows named pipe listening on \\.\pipe\OriginDetectionPipe
```

Tauri 客户端启动时会自动拉起这个脚本；也可以在设置页手动启动/停止。

## 依赖

```powershell
.\.venv\Scripts\python.exe -m pip install onnxruntime numpy Pillow pywin32
```

当前 `.venv` 使用 `--system-site-packages` 复用已安装的 onnxruntime/numpy/Pillow。

## 直接测试推理

```powershell
.\.venv\Scripts\python.exe -c "from server.Server import DetectionServer; from PIL import Image; d=DetectionServer('model/armor.onnx','model/car.onnx'); print(d.detect_all(Image.open('sample.jpg'),0.25,0.25,0.45,1280)['detections'][:3])"
```

## 性能

CPU 上两个模型合计约 300–1300 ms/帧，具体取决于图片尺寸和 CPU。客户端检测循环会按 provider 自动降低发送频率。
