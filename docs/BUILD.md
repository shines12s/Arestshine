# 构建与运行

## 1. 安装依赖

### Origin

```powershell
cd origin-client
npm ci
```

需要 Rust stable 和 Tauri 2 系统依赖。

### Simulator

```powershell
cd simulator
npm install
```

或：

```powershell
pnpm install --frozen-lockfile
```

### AI Server

```powershell
cd ai-server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 2. 启动

### 模拟器

```powershell
cd simulator
$env:FFMPEG_PATH = "C:\ffmpeg\bin\ffmpeg.exe"
node src/server.js
```

### AI Server

```powershell
cd ai-server
python server\pipe_server.py
```

### Origin

开发模式：

```powershell
cd origin-client
npm run tauri dev
```

生产构建：

```powershell
cd origin-client
npm run tauri build
```

## 3. 2027 地图资源

```text
origin-client/resources/Map.png
origin-client/public/Map.png
```

`Map.png` 来自 2027 规则手册图 4-1。

## 4. 运行二进制

FFmpeg、WebView2、Node/Python 便携运行时和打包 ZIP 不提交到 Git。
需要运行包时，在 GitHub Releases 上传 ZIP，或按 `docs/COMPONENTS.md` 准备。

## 5. 常见问题

### Tauri 构建失败

确认：

- Rust toolchain 为 stable；
- WebView2 已安装；
- Node 版本 >= 18；
- Windows 构建需要 MSVC Build Tools。

### 图传黑屏

- 模拟器是否在发送 `3334`；
- `ORIGIN_FFMPEG_PATH` 是否指向 ffmpeg.exe；
- FFmpeg 是否支持 H.265。

### AI 检测超时

- `pipe_server.py` 是否运行；
- 模型文件是否存在；
- 是否只有一个 AI 进程占用命名管道。
