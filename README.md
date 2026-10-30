# Origin Suite 2027

RoboMaster 2027 比赛客户端、网页模拟器和 AI 检测服务源码仓库。

```text
origin-client/   Vue 3 + Tauri 2 桌面客户端
simulator/       Node.js 网页模拟器（MQTT / UDP 图传）
ai-server/       Python ONNX 检测服务（命名管道）
scripts/         开发启动/构建脚本
docs/            架构与构建说明
```

## 组件

### origin-client

- Vue 3 + TypeScript + Pinia
- Tauri 2（Rust）
- MQTT `127.0.0.1:3333`
- UDP 图传 `3334`
- 2027 场地地图、机器人状态、基地/前哨、控制度面板

### simulator

网页地址：`http://127.0.0.1:9130`

- MQTT Broker：`3333`
- UDP H.265 图传：`3334`
- 演示状态：比赛重置、机器人/空中系统、基地/前哨、地图坐标、战场控制度
- 机器人独立移动控制

### ai-server

- Python 3.12
- ONNX Runtime
- 命名管道 `\\.\pipe\OriginDetectionPipe`
- 模型：`ai-server/model/armor.onnx`、`car.onnx`

## 环境要求

- Windows 10/11 x64
- Node.js 18+
- pnpm 或 npm
- Rust stable + Tauri 2 构建依赖
- Python 3.12（仅 AI Server）
- FFmpeg（图传编解码）
- Microsoft Edge WebView2 Runtime（仅运行桌面客户端）

## 开发运行

### 1. 模拟器

```powershell
cd simulator
npm install
$env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
node src/server.js
```

打开 <http://127.0.0.1:9130/>。

### 2. AI Server

```powershell
cd ai-server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python server\pipe_server.py
```

### 3. Origin 客户端

```powershell
cd origin-client
npm ci
npm run tauri dev
```

生产构建：

```powershell
npm run tauri build
```

## 端口

| 服务 | 端口 |
|---|---:|
| 模拟器 Web | 9130 |
| MQTT | 3333 |
| UDP 图传 | 3334 |

## 不提交到 Git 的文件

以下内容体积大、平台相关或需要本机安装，不放入源码仓库：

- `node_modules/`
- `src-tauri/target/`
- `dist/`
- `.venv/`
- `ffmpeg.exe` / `ffprobe.exe`
- Node / Python 便携运行时
- WebView2 Runtime
- 打包 ZIP 和截图产物

FFmpeg 和 WebView2 请从官方渠道下载；运行包可作为 GitHub Release 附件发布。

## 上传到 GitHub

```powershell
cd origin-suite-github
git init -b main
git add .
git commit -m "Initial Origin Suite 2027 source"
git remote add origin https://github.com/<your-name>/origin-suite.git
git push -u origin main
```

首次提交前配置 Git 用户名：

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

## 文档

- [架构与数据流](docs/ARCHITECTURE.md)
- [构建与运行](docs/BUILD.md)
- [组件说明](docs/COMPONENTS.md)
