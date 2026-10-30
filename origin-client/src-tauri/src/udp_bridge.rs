//! UDP video bridge.
//!
//! Receives raw UDP video, assembles fragments, decodes H.265 in-process
//! and exposes the result to Tauri as binary `Channel` JPEG frames or a
//! backend MJPEG stream.
//!
//! Submodules:
//! - [`stats`]         — lock-free statistics (`AtomicStats`, `UdpStats`).
//! - [`assembly`]      — fragment reorder + per-frame buffer pool.
//! - [`codec_detect`]  — JPEG / H.264 / H.265 NAL parsing + keyframe detection.
//! - [`mjpeg`]         — backend MJPEG fallback HTTP stream server.

mod assembly;
mod codec_detect;
mod mjpeg;
mod stats;

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Emitter,
};
use tokio::net::UdpSocket;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::video_decoder::{SmartDecoder, YuvFrame};

use self::assembly::{drop_in_flight_frame, drop_stale_in_flight_frames, FrameAssembly, FramePool};
use self::codec_detect::detect_frame_type;
use self::mjpeg::{
    MjpegBroadcaster, MjpegStreamServer, MJPEG_FALLBACK_MAX_FPS, MJPEG_FALLBACK_QUALITY,
};
use self::stats::AtomicStats;

// ==================== Public types ====================

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UdpConfig {
    pub host: String,
    #[serde(default)]
    pub source_host: Option<String>,
    pub port: u16,
    pub buffer_size: usize,
    #[serde(default)]
    pub requested_codec: Option<String>,
    #[serde(default)]
    pub codec_decision_reason: Option<String>,
    pub codec: String, // Frontend decoding removed; output is normalized to backend MJPEG.
    #[serde(default)]
    pub jpeg_quality: Option<u8>, // Backend MJPEG fallback quality.
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrameInfo {
    pub r#type: String, // "jpeg", "h264", "h265", "unknown"
    pub is_keyframe: bool,
    pub timestamp: u64,
    pub nal_type: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestMjpegFrame {
    pub success: bool,
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub image: String,
}

// ==================== Bridge state ====================

pub struct UdpBridgeState {
    pub config: StdMutex<Option<UdpConfig>>,
    pub stats: Arc<AtomicStats>,
    pub running_task: StdMutex<Option<JoinHandle<()>>>,
    mjpeg_server: StdMutex<Option<MjpegStreamServer>>,
    mjpeg_stream_url: StdMutex<Option<String>>,
    /// Current abort signal. Replaced on every start so the previous
    /// receive loop's notification can never affect the new run.
    pub abort_handle: StdMutex<Arc<Notify>>,
    /// Serializes start/stop so rapid reconnects cannot spawn two
    /// concurrent receive loops binding the same port.
    pub lifecycle: tokio::sync::Mutex<()>,
}

impl Default for UdpBridgeState {
    fn default() -> Self {
        Self {
            config: StdMutex::new(None),
            stats: Arc::new(AtomicStats::default()),
            running_task: StdMutex::new(None),
            mjpeg_server: StdMutex::new(None),
            mjpeg_stream_url: StdMutex::new(None),
            abort_handle: StdMutex::new(Arc::new(Notify::new())),
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }
}

impl UdpBridgeState {
    pub fn latest_mjpeg_frame_bytes(&self) -> Option<(u64, u32, u32, Vec<u8>)> {
        let broadcaster = {
            let guard = self.mjpeg_server.lock().unwrap();
            let server = guard.as_ref()?;
            Arc::clone(&server.broadcaster)
        };

        broadcaster.latest()
    }
}

// ==================== Constants ====================

/// Protocol header: [frame_number(2B) | fragment_index(2B) | total_frame_size(4B)]
const FRAME_HEADER_SIZE: usize = 8;

/// Default UDP receive buffer for the low-latency profile.
/// The UI can override this. Keep the fallback modest so packet loss is visible
/// as frame drops instead of seconds of stale kernel-buffered video.
const DEFAULT_RECV_BUFFER_SIZE: usize = 4 * 1024 * 1024;

/// Frame buffer pool capacity.
const FRAME_POOL_CAPACITY: usize = 8;

/// Maximum number of partially received frames tracked at once.
/// 1080p UDP fragmentation can leave several frame assemblies active during
/// packet reordering. Keep this bounded so stale frames cannot dominate memory.
const MAX_IN_FLIGHT_FRAMES: usize = 16;

/// Refuse malformed frame headers that would allocate huge buffers.
const MAX_FRAME_SIZE: u32 = 16 * 1024 * 1024;

/// Maximum number of compressed H.265 access units queued for the background decoder.
/// Keep this deliberately short: at 60 FPS, 12 frames cap queued video at about
/// 200 ms. On overflow we discard the stale GOP and resume from the newest IRAP
/// rather than spending decoder time on video the operator can no longer use.
const H265_DECODE_QUEUE_CAPACITY: usize = 12;

/// Decode backlog budget. HEVC dependency chains are kept intact only while
/// the head of the queue is still useful to display.
const H265_TARGET_LATENCY: Duration = Duration::from_millis(150);
const H265_MAX_LATENCY: Duration = Duration::from_millis(300);

/// Drop incomplete fragmented frames quickly. With the fixed UDP protocol we
/// cannot repair lost fragments, so waiting longer only preserves stale video.
const FRAME_ASSEMBLY_TIMEOUT: Duration = Duration::from_millis(120);
const FRAME_ASSEMBLY_SWEEP_INTERVAL: Duration = Duration::from_millis(20);
const KEYFRAME_REQUEST_MIN_INTERVAL: Duration = Duration::from_millis(500);

// ==================== H.265 background decoder ====================

struct PendingH265Frame {
    data: Vec<u8>,
    is_keyframe: bool,
    reset_decoder: bool,
    enqueued_at: Instant,
    generation: u64,
}

struct H265DecodeQueue {
    frames: VecDeque<PendingH265Frame>,
    needs_keyframe: bool,
    generation: u64,
}

struct H265Worker {
    alive: Arc<AtomicBool>,
    slot: Arc<(StdMutex<H265DecodeQueue>, Condvar)>,
    encode_slot: Arc<(StdMutex<Option<YuvFrame>>, Condvar)>,
    decode_handle: Option<thread::JoinHandle<()>>,
    encode_handle: Option<thread::JoinHandle<()>>,
}

impl H265Worker {
    fn stop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        {
            let (_lock, cvar) = &*self.slot;
            cvar.notify_all();
        }
        {
            let (_lock, cvar) = &*self.encode_slot;
            cvar.notify_all();
        }
        if let Some(handle) = self.decode_handle.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.encode_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for H265Worker {
    fn drop(&mut self) {
        self.stop();
    }
}

// ==================== Commands ====================

/// Internal stop helper; caller must hold the lifecycle lock.
/// Aborts the receive loop AND awaits its completion so the UDP
/// socket FD is fully released before the caller attempts to rebind.
async fn stop_internal(state: &UdpBridgeState) -> Result<bool, String> {
    let notify = state.abort_handle.lock().unwrap().clone();
    notify.notify_waiters();
    let old_task = state.running_task.lock().unwrap().take();
    if let Some(mut task) = old_task {
        tokio::select! {
            result = &mut task => {
                let _ = result;
            }
            _ = tokio::time::sleep(Duration::from_millis(1500)) => {
                warn!("receive loop did not stop in time; aborting task");
                task.abort();
                let _ = task.await;
            }
        }
    }
    if let Some(mut server) = state.mjpeg_server.lock().unwrap().take() {
        server.stop();
    }
    *state.mjpeg_stream_url.lock().unwrap() = None;
    Ok(true)
}

#[tauri::command]
pub async fn udp_stream_start(
    app: AppHandle,
    state: tauri::State<'_, UdpBridgeState>,
    config: UdpConfig,
    frame_channel: Channel<InvokeResponseBody>,
) -> Result<serde_json::Value, String> {
    // Serialize start/stop to prevent double receive loops on rapid reconnect.
    let _lifecycle_guard = state.lifecycle.lock().await;

    // Stop existing stream (awaits task termination so the socket is released).
    stop_internal(&state).await?;

    // Reset stats
    state.stats.reset();

    // Install a fresh abort signal for this run; stale notifications from
    // prior runs cannot affect the new receive loop.
    let abort_notify = Arc::new(Notify::new());
    {
        let mut abort_slot = state.abort_handle.lock().unwrap();
        *abort_slot = abort_notify.clone();
    }

    // Save config
    {
        let mut cfg_lock = state.config.lock().unwrap();
        *cfg_lock = Some(config.clone());
    }

    let bind_addr = format!("{}:{}", config.host, config.port);

    // ---------- socket2: OS-level buffer tuning ----------
    let socket2 = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
        .map_err(|e| format!("Failed to create socket: {}", e))?;

    // Set receive buffer BEFORE bind. In a low-latency video path, a very large
    // kernel buffer hides packet loss by queueing stale frames, so respect the
    // UI low-latency value and use a modest default only when it is unset.
    let requested_recv_buffer_size = if config.buffer_size > 0 {
        config.buffer_size
    } else {
        DEFAULT_RECV_BUFFER_SIZE
    };
    if let Err(e) = socket2.set_recv_buffer_size(requested_recv_buffer_size) {
        warn!(
            requested = requested_recv_buffer_size,
            error = %e,
            "failed to set SO_RCVBUF"
        );
    }
    let actual_buf = socket2.recv_buffer_size().unwrap_or(0);
    info!(
        requested = requested_recv_buffer_size,
        actual = actual_buf,
        "SO_RCVBUF tuning"
    );

    socket2.set_reuse_address(true).ok();
    socket2.set_nonblocking(true).map_err(|e| e.to_string())?;

    let addr: std::net::SocketAddr = bind_addr
        .parse()
        .map_err(|e| format!("Invalid bind address '{}': {}", bind_addr, e))?;
    socket2
        .bind(&addr.into())
        .map_err(|e| format!("Failed to bind {}: {}", bind_addr, e))?;

    let std_socket: std::net::UdpSocket = socket2.into();
    let socket = UdpSocket::from_std(std_socket)
        .map_err(|e| format!("Failed to convert to async socket: {}", e))?;

    info!(addr = %bind_addr, "UDP listening (high-perf assembly engine)");

    let requested_output_codec = config.codec.clone();
    let output_codec = "mjpeg".to_string();
    if requested_output_codec != "mjpeg" {
        info!(
            requested_output_codec = %requested_output_codec,
            "frontend compressed passthrough disabled; forcing backend MJPEG output"
        );
    }
    let source_filter = parse_source_host_filter(config.source_host.as_deref())?;
    let jpeg_quality = config.jpeg_quality.unwrap_or(MJPEG_FALLBACK_QUALITY);
    let (mjpeg_broadcaster, mjpeg_stream_url) = if output_codec == "mjpeg" {
        let server = MjpegStreamServer::start()?;
        let url = server.url.clone();
        let broadcaster = Arc::clone(&server.broadcaster);
        *state.mjpeg_stream_url.lock().unwrap() = Some(url.clone());
        *state.mjpeg_server.lock().unwrap() = Some(server);
        info!(%url, "backend MJPEG stream ready");
        (Some(broadcaster), Some(url))
    } else {
        *state.mjpeg_stream_url.lock().unwrap() = None;
        (None, None)
    };

    let stats = state.stats.clone();
    let app_handle = app.clone();
    let channel = frame_channel.clone();
    let requested_udp_codec = config
        .requested_codec
        .clone()
        .unwrap_or_else(|| requested_output_codec.clone());
    let h265_recovery_enabled = matches!(requested_udp_codec.as_str(), "h265" | "auto");
    info!(
        codec = %output_codec,
        mode = "backend MJPEG stream",
        "output codec mode"
    );
    info!(
        requested = config.requested_codec.as_deref().unwrap_or("unknown"),
        effective = %output_codec,
        reason = config
            .codec_decision_reason
            .as_deref()
            .unwrap_or("not provided"),
        source_filter = source_filter
            .map(|ip| ip.to_string())
            .unwrap_or_else(|| "any".into()),
        "codec decision"
    );

    // Spawn async receive loop
    let handle = tokio::spawn(async move {
        udp_receive_loop(
            socket,
            abort_notify,
            stats,
            app_handle,
            channel,
            output_codec,
            source_filter,
            mjpeg_broadcaster,
            jpeg_quality,
            h265_recovery_enabled,
        )
        .await;
    });

    {
        let mut task_guard = state.running_task.lock().unwrap();
        *task_guard = Some(handle);
    }

    Ok(serde_json::json!({
        "success": true,
        "mjpegStreamUrl": mjpeg_stream_url
    }))
}

#[tauri::command]
pub async fn udp_stream_stop(state: tauri::State<'_, UdpBridgeState>) -> Result<bool, String> {
    let _lifecycle_guard = state.lifecycle.lock().await;
    stop_internal(&state).await
}

#[tauri::command]
pub async fn udp_stream_get_status(
    state: tauri::State<'_, UdpBridgeState>,
) -> Result<serde_json::Value, String> {
    let running = state.running_task.lock().unwrap().is_some();
    let stats = state.stats.snapshot();
    let mjpeg_stream_url = state.mjpeg_stream_url.lock().unwrap().clone();
    Ok(serde_json::json!({
        "running": running,
        "stats": stats,
        "mjpegStreamUrl": mjpeg_stream_url
    }))
}

#[tauri::command]
pub async fn udp_stream_get_latest_mjpeg_frame(
    state: tauri::State<'_, UdpBridgeState>,
) -> Result<Option<LatestMjpegFrame>, String> {
    let Some((seq, width, height, jpeg)) = state.latest_mjpeg_frame_bytes() else {
        return Ok(None);
    };

    Ok(Some(LatestMjpegFrame {
        success: true,
        seq,
        width,
        height,
        image: BASE64_STANDARD.encode(jpeg),
    }))
}

fn parse_source_host_filter(value: Option<&str>) -> Result<Option<IpAddr>, String> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "0.0.0.0" || trimmed == "*" {
        return Ok(None);
    }
    trimmed
        .parse::<IpAddr>()
        .map(Some)
        .map_err(|e| format!("Invalid sourceHost '{}': {}", trimmed, e))
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn mark_output_frame(stats: &AtomicStats, timestamp: u64) {
    stats
        .last_output_frame_time
        .store(timestamp, Ordering::Relaxed);
    stats.last_frame_time.store(timestamp, Ordering::Relaxed);
}

fn h265_queue_head_age(queue: &H265DecodeQueue, now: Instant) -> Duration {
    queue
        .frames
        .front()
        .map(|frame| now.duration_since(frame.enqueued_at))
        .unwrap_or_default()
}

fn clear_h265_gop(queue: &mut H265DecodeQueue, stats: &AtomicStats) -> u32 {
    let dropped_old = queue.frames.len() as u32;
    queue.frames.clear();
    queue.needs_keyframe = true;
    queue.generation = queue.generation.wrapping_add(1);
    if dropped_old > 0 {
        stats
            .dropped_old_frames
            .fetch_add(dropped_old, Ordering::Relaxed);
        stats
            .dropped_frames
            .fetch_add(dropped_old, Ordering::Relaxed);
    }
    stats.decode_queue_depth.store(0, Ordering::Relaxed);
    stats
        .decoder_waiting_keyframe
        .store(true, Ordering::Relaxed);
    dropped_old
}

fn force_h265_keyframe_wait(
    h265_slot: &Arc<(StdMutex<H265DecodeQueue>, Condvar)>,
    stats: &AtomicStats,
) -> u32 {
    let (lock, cvar) = &**h265_slot;
    let mut guard = lock.lock().unwrap();
    let dropped = clear_h265_gop(&mut guard, stats);
    cvar.notify_one();
    dropped
}

fn emit_keyframe_request(
    app: &AppHandle,
    stats: &AtomicStats,
    last_request_at: &mut Instant,
    reason: &str,
) {
    let now = Instant::now();
    if now.duration_since(*last_request_at) < KEYFRAME_REQUEST_MIN_INTERVAL {
        return;
    }
    *last_request_at = now;
    stats.keyframe_requests.fetch_add(1, Ordering::Relaxed);
    let timestamp = unix_timestamp_ms();
    let _ = app.emit(
        "udp-keyframe-request",
        serde_json::json!({
            "type": "request_keyframe",
            "reason": reason,
            "timestamp": timestamp,
        }),
    );
}

// ==================== Receive Loop ====================

/// Core receive loop with high-performance frame assembly.
///
/// Architecture:
/// ```text
/// UDP socket → parse header (in-place) → fragment write (zero-copy to frame buffer)
///            → frame complete? → detect codec → emit to frontend
///            → pool: recycle buffer
/// ```
#[allow(clippy::too_many_arguments)]
async fn udp_receive_loop(
    socket: UdpSocket,
    abort: Arc<Notify>,
    stats: Arc<AtomicStats>,
    app: AppHandle,
    frame_channel: Channel<InvokeResponseBody>,
    output_codec: String,
    source_filter: Option<IpAddr>,
    mjpeg_broadcaster: Option<Arc<MjpegBroadcaster>>,
    jpeg_quality: u8,
    h265_recovery_enabled: bool,
) {
    // Pre-allocate receive buffer (max UDP datagram = ~65KB)
    let mut buf = vec![0u8; 65536];
    info!(
        h265_target_latency_ms = H265_TARGET_LATENCY.as_millis() as u64,
        h265_max_latency_ms = H265_MAX_LATENCY.as_millis() as u64,
        "UDP low-latency budgets"
    );

    // Assembly state
    let mut in_flight_frames: HashMap<u16, FrameAssembly> =
        HashMap::with_capacity(MAX_IN_FLIGHT_FRAMES);
    let mut frame_order: VecDeque<u16> = VecDeque::with_capacity(MAX_IN_FLIGHT_FRAMES);
    let mut pool = FramePool::new(FRAME_POOL_CAPACITY);

    // Periodic stats emission state (sliding 1-second window)
    let mut stats_tick = tokio::time::interval(std::time::Duration::from_secs(1));
    stats_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_received_frames: u32 = 0;
    let mut last_total_bytes: u64 = 0;
    let mut last_assembly_sweep = Instant::now();
    let mut h265_stream_seen = false;
    let mut last_keyframe_request_at = Instant::now()
        .checked_sub(KEYFRAME_REQUEST_MIN_INTERVAL)
        .unwrap_or_else(Instant::now);

    // H.265 decoder — lazy-initialized on first H.265 frame
    let mut decoder: Option<SmartDecoder> = None;

    // H.265 async decode worker: bounded FIFO queue plus keyframe-gated reset.
    // This keeps inter-frame dependencies intact while preventing unbounded
    // latency growth when decode throughput is below source FPS.
    let h265_slot: Arc<(StdMutex<H265DecodeQueue>, Condvar)> = Arc::new((
        StdMutex::new(H265DecodeQueue {
            frames: VecDeque::with_capacity(H265_DECODE_QUEUE_CAPACITY),
            needs_keyframe: true,
            generation: 0,
        }),
        Condvar::new(),
    ));
    let h265_alive = Arc::new(AtomicBool::new(true));
    let mut h265_worker: Option<H265Worker> = if output_codec != "h265" {
        // JPEG conversion/encoding is intentionally separated from H.265
        // decode. Dropping a decoded display frame is safe; dropping a
        // compressed HEVC delta frame is not. A latest-frame slot therefore
        // prevents slow JPEG work from filling and invalidating the HEVC queue.
        let encode_slot: Arc<(StdMutex<Option<YuvFrame>>, Condvar)> =
            Arc::new((StdMutex::new(None), Condvar::new()));
        let frame_interval = Duration::from_millis((1000 / MJPEG_FALLBACK_MAX_FPS.max(1)) as u64);

        let encode_slot_w = Arc::clone(&encode_slot);
        let encode_alive = Arc::clone(&h265_alive);
        let encode_stats = Arc::clone(&stats);
        let encode_channel = frame_channel.clone();
        let encode_mjpeg = mjpeg_broadcaster.clone();
        let encode_handle = std::thread::Builder::new()
            .name("udp-mjpeg-encoder".into())
            .spawn(move || {
                while encode_alive.load(Ordering::Relaxed) {
                    let frame_opt = {
                        let (lock, cvar) = &*encode_slot_w;
                        let mut guard = lock.lock().unwrap();
                        while guard.is_none() && encode_alive.load(Ordering::Relaxed) {
                            guard = cvar.wait(guard).unwrap();
                        }
                        guard.take()
                    };
                    let Some(frame) = frame_opt else { continue };
                    if !encode_alive.load(Ordering::Relaxed) {
                        break;
                    }

                    let decoded_width = frame.width;
                    let decoded_height = frame.height;
                    let jpeg = frame.to_jpeg(jpeg_quality);
                    encode_stats.set_frame_dimensions(
                        decoded_width,
                        decoded_height,
                        jpeg.width,
                        jpeg.height,
                    );

                    if let Some(mjpeg) = &encode_mjpeg {
                        mjpeg.publish(jpeg.data, jpeg.width, jpeg.height);
                    } else {
                        // Non-MJPEG fallback should be rare, but keep a compact
                        // JPEG IPC path instead of ever sending raw YUV again.
                        send_channel_frame(
                            &encode_channel,
                            &encode_stats,
                            FRAME_TYPE_JPEG,
                            true,
                            &jpeg.data,
                        );
                    }

                    encode_stats.received_frames.fetch_add(1, Ordering::Relaxed);
                    mark_output_frame(&encode_stats, unix_timestamp_ms());
                }
            })
            .expect("spawn mjpeg encoder worker");

        let slot = Arc::clone(&h265_slot);
        let decode_slot = Arc::clone(&encode_slot);
        let alive = Arc::clone(&h265_alive);
        let stats_w = Arc::clone(&stats);
        let decode_app = app.clone();
        let decode_handle = std::thread::Builder::new()
            .name("udp-h265-decoder".into())
            .spawn(move || {
                let mut dec: Option<SmartDecoder> = None;
                let mut last_worker_keyframe_request_at = Instant::now()
                    .checked_sub(KEYFRAME_REQUEST_MIN_INTERVAL)
                    .unwrap_or_else(Instant::now);
                let mut last_enqueue = Instant::now()
                    .checked_sub(frame_interval)
                    .unwrap_or_else(Instant::now);
                while alive.load(Ordering::Relaxed) {
                    // Decode compressed frames in arrival order.
                    let pending_opt = {
                        let (lock, cvar) = &*slot;
                        let mut guard = lock.lock().unwrap();
                        while guard.frames.is_empty() && alive.load(Ordering::Relaxed) {
                            guard = cvar.wait(guard).unwrap();
                        }
                        let pending = guard.frames.pop_front();
                        stats_w
                            .decode_queue_depth
                            .store(guard.frames.len() as u32, Ordering::Relaxed);
                        pending
                    };
                    let Some(pending) = pending_opt else { continue };
                    if !alive.load(Ordering::Relaxed) {
                        break;
                    }

                    let current_generation = {
                        let (lock, _) = &*slot;
                        lock.lock().unwrap().generation
                    };
                    if pending.generation != current_generation {
                        dec = None;
                        stats_w.dropped_old_frames.fetch_add(1, Ordering::Relaxed);
                        stats_w.dropped_frames.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }

                    if Instant::now().duration_since(pending.enqueued_at) >= H265_MAX_LATENCY {
                        dec = None;
                        let dropped_old = {
                            let (lock, _) = &*slot;
                            let mut guard = lock.lock().unwrap();
                            clear_h265_gop(&mut guard, &stats_w)
                        };
                        stats_w.dropped_old_frames.fetch_add(1, Ordering::Relaxed);
                        stats_w.dropped_frames.fetch_add(1, Ordering::Relaxed);
                        emit_keyframe_request(
                            &decode_app,
                            &stats_w,
                            &mut last_worker_keyframe_request_at,
                            "h265_decode_backlog_timeout",
                        );
                        warn!(
                            dropped_old = dropped_old + 1,
                            "H.265 decode backlog exceeded latency budget; waiting for keyframe"
                        );
                        continue;
                    }

                    if pending.reset_decoder {
                        dec = None;
                    }
                    let d = dec.get_or_insert_with(SmartDecoder::new);
                    let decode_result = d.decode_to_yuv(&pending.data, pending.is_keyframe);
                    stats_w.set_decoder_backend(d.backend_name());
                    match decode_result {
                        Ok(Some(frame)) => {
                            let current_generation = {
                                let (lock, _) = &*slot;
                                lock.lock().unwrap().generation
                            };
                            if pending.generation != current_generation {
                                dec = None;
                                stats_w.dropped_old_frames.fetch_add(1, Ordering::Relaxed);
                                stats_w.dropped_frames.fetch_add(1, Ordering::Relaxed);
                                continue;
                            }

                            let now = Instant::now();
                            if now.duration_since(last_enqueue) < frame_interval {
                                stats_w.dropped_old_frames.fetch_add(1, Ordering::Relaxed);
                                continue;
                            }
                            last_enqueue = now;

                            let (lock, cvar) = &*decode_slot;
                            let mut pending_frame = lock.lock().unwrap();
                            if pending_frame.replace(frame).is_some() {
                                // JPEG is behind, but the decoder remains current.
                                // Replacing raw YUV here does not break HEVC refs.
                                stats_w.dropped_old_frames.fetch_add(1, Ordering::Relaxed);
                            }
                            cvar.notify_one();
                        }
                        Ok(None) => { /* decoder buffering */ }
                        Err(e) => {
                            // A failed backend cannot safely resume mid-GOP with
                            // a fresh decoder. Clear stale deltas and resume from
                            // the next keyframe; known-bad GPU backends are cached
                            // by SmartDecoder and will not be retried.
                            warn!(error = %e, "H.265 decode error; resetting and waiting for keyframe");
                            dec = None;
                            {
                                let (lock, _) = &*slot;
                                let mut guard = lock.lock().unwrap();
                                clear_h265_gop(&mut guard, &stats_w);
                            }
                            emit_keyframe_request(
                                &decode_app,
                                &stats_w,
                                &mut last_worker_keyframe_request_at,
                                "h265_decode_error",
                            );
                            stats_w.errors.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            })
            .expect("spawn h265 worker");
        Some(H265Worker {
            alive: h265_alive.clone(),
            slot: h265_slot.clone(),
            encode_slot,
            decode_handle: Some(decode_handle),
            encode_handle: Some(encode_handle),
        })
    } else {
        None
    };

    loop {
        tokio::select! {
            _ = abort.notified() => {
                info!("receive loop terminated by abort signal");
                break;
            }
            _ = stats_tick.tick() => {
                let dropped_stale = drop_stale_in_flight_frames(
                    &mut in_flight_frames,
                    &mut frame_order,
                    &mut pool,
                    &stats,
                    FRAME_ASSEMBLY_TIMEOUT,
                );
                if dropped_stale > 0 && (h265_recovery_enabled || h265_stream_seen) {
                    let dropped_queued = force_h265_keyframe_wait(&h265_slot, &stats);
                    emit_keyframe_request(
                        &app,
                        &stats,
                        &mut last_keyframe_request_at,
                        "h265_incomplete_frame_timeout",
                    );
                    warn!(
                        dropped_stale,
                        dropped_queued,
                        "incomplete H.265 frame timed out; waiting for keyframe"
                    );
                }
                last_assembly_sweep = Instant::now();
                // Emit per-second stats: FPS & bitrate (bytes/s)
                let rx_frames = stats.received_frames.load(Ordering::Relaxed);
                let total_bytes = stats.total_bytes.load(Ordering::Relaxed);
                let fps = rx_frames.saturating_sub(last_received_frames);
                let bps = total_bytes.saturating_sub(last_total_bytes);
                last_received_frames = rx_frames;
                last_total_bytes = total_bytes;

                let snapshot = stats.snapshot();
                let _ = app.emit("udp-stream-stats", serde_json::json!({
                    "fps": fps,
                    "bytesPerSecond": bps,
                    "stats": snapshot,
                }));
            }
            res = socket.recv_from(&mut buf) => {
                match res {
                    Ok((len, addr)) => {
                        if source_filter
                            .map(|expected| addr.ip() != expected)
                            .unwrap_or(false)
                        {
                            stats.dropped_frames.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }

                        stats
                            .last_packet_time
                            .store(unix_timestamp_ms(), Ordering::Relaxed);

                        let now = Instant::now();
                        if now.duration_since(last_assembly_sweep) >= FRAME_ASSEMBLY_SWEEP_INTERVAL
                        {
                            let dropped_stale = drop_stale_in_flight_frames(
                                &mut in_flight_frames,
                                &mut frame_order,
                                &mut pool,
                                &stats,
                                FRAME_ASSEMBLY_TIMEOUT,
                            );
                            if dropped_stale > 0 && (h265_recovery_enabled || h265_stream_seen) {
                                let dropped_queued = force_h265_keyframe_wait(&h265_slot, &stats);
                                emit_keyframe_request(
                                    &app,
                                    &stats,
                                    &mut last_keyframe_request_at,
                                    "h265_incomplete_frame_timeout",
                                );
                                warn!(
                                    dropped_stale,
                                    dropped_queued,
                                    "incomplete H.265 frame timed out; waiting for keyframe"
                                );
                            }
                            last_assembly_sweep = now;
                        }

                        if len < FRAME_HEADER_SIZE {
                            stats.dropped_frames.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }

                        stats.total_bytes.fetch_add(len as u64, Ordering::Relaxed);

                        // Parse header in-place (no allocation)
                        let frame_number = u16::from_be_bytes([buf[0], buf[1]]);
                        let fragment_index = u16::from_be_bytes([buf[2], buf[3]]);
                        let total_frame_size = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
                        let payload = &buf[FRAME_HEADER_SIZE..len];

                        if total_frame_size == 0 || total_frame_size > MAX_FRAME_SIZE {
                            stats.dropped_frames.fetch_add(1, Ordering::Relaxed);
                            stats.errors.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }

                        if payload.len() as u32 > total_frame_size {
                            stats.dropped_frames.fetch_add(1, Ordering::Relaxed);
                            stats.errors.fetch_add(1, Ordering::Relaxed);
                            drop_in_flight_frame(
                                &mut in_flight_frames,
                                &mut frame_order,
                                frame_number,
                                &mut pool,
                                &stats,
                            );
                            continue;
                        }

                        // === Fast path: single-packet frame (no assembly needed) ===
                        if fragment_index == 0 && payload.len() as u32 == total_frame_size {
                            let info = detect_frame_type(payload);
                            stats
                                .last_assembled_frame_time
                                .store(info.timestamp, Ordering::Relaxed);
                            if info.r#type == "h265" {
                                h265_stream_seen = true;
                            }
                            if output_codec == "h265" && info.r#type == "h265" {
                                let packet =
                                    build_ipc_frame(frame_type_code(&info.r#type), info.is_keyframe, payload);
                                send_prefixed_channel_frame(
                                    &frame_channel,
                                    &stats,
                                    packet,
                                    &info,
                                );
                            } else {
                                // Must copy here since buf is reused
                                send_frame_to_frontend(
                                    &app,
                                    &frame_channel,
                                    &stats,
                                    payload.to_vec(),
                                    info,
                                    &mut decoder,
                                    &output_codec,
                                    &h265_slot,
                                    &mjpeg_broadcaster,
                                    &mut last_keyframe_request_at,
                                );
                            }
                            continue;
                        }

                        // === Multi-packet frame assembly ===
                        if !in_flight_frames.contains_key(&frame_number) {
                            if in_flight_frames.len() >= MAX_IN_FLIGHT_FRAMES {
                                if let Some(oldest_frame_number) = frame_order.pop_front() {
                                    drop_in_flight_frame(
                                        &mut in_flight_frames,
                                        &mut frame_order,
                                        oldest_frame_number,
                                        &mut pool,
                                        &stats,
                                    );
                                }
                            }

                            let payload_offset = if output_codec == "h265" {
                                IPC_HEADER_SIZE
                            } else {
                                0
                            };
                            let frame_buf =
                                pool.acquire(payload_offset + total_frame_size as usize);
                            in_flight_frames.insert(
                                frame_number,
                                FrameAssembly::new(
                                    frame_number,
                                    total_frame_size,
                                    frame_buf,
                                    payload_offset,
                                ),
                            );
                            frame_order.push_back(frame_number);
                        }

                        let complete = if let Some(frame) = in_flight_frames.get_mut(&frame_number) {
                            if frame.total_size != total_frame_size {
                                stats.errors.fetch_add(1, Ordering::Relaxed);
                                continue;
                            }

                            frame.write_fragment(fragment_index, payload)
                        } else {
                            continue;
                        };

                        if complete {
                            frame_order.retain(|value| *value != frame_number);

                            if let Some(finished) = in_flight_frames.remove(&frame_number) {
                                let info = detect_frame_type(finished.payload());
                                stats
                                    .last_assembled_frame_time
                                    .store(info.timestamp, Ordering::Relaxed);
                                if info.r#type == "h265" {
                                    h265_stream_seen = true;
                                }
                                if output_codec == "h265" && info.r#type == "h265" {
                                    let packet =
                                        finished.finalize_prefixed(&ipc_header_for_info(&info));
                                    send_prefixed_channel_frame(
                                        &frame_channel,
                                        &stats,
                                        packet,
                                        &info,
                                    );
                                } else {
                                    let data = finished.finalize();
                                    send_frame_to_frontend(
                                        &app,
                                        &frame_channel,
                                        &stats,
                                        data,
                                        info,
                                        &mut decoder,
                                        &output_codec,
                                        &h265_slot,
                                        &mjpeg_broadcaster,
                                        &mut last_keyframe_request_at,
                                    );
                                }
                            }
                        }
                    }
                    Err(e) => {
                        // WouldBlock is expected for non-blocking sockets
                        if e.kind() != std::io::ErrorKind::WouldBlock {
                            error!(error = ?e, "socket read error");
                            stats.errors.fetch_add(1, Ordering::Relaxed);
                            let _ = app.emit("udp-stream-error", serde_json::json!({
                                "kind": "socket",
                                "message": format!("{}", e),
                            }));
                        }
                    }
                }
            }
        }
    }

    while let Some(frame_number) = frame_order.pop_front() {
        if let Some(frame) = in_flight_frames.remove(&frame_number) {
            pool.release(frame.recycle_buffer());
        }
    }

    // Stop the H.265 decode worker (if any) and wait for it to flush.
    if let Some(worker) = &mut h265_worker {
        worker.stop();
    }
    let _ = decoder; // silence unused-mut warning when output_codec=="h265"
}

// ==================== IPC Output ====================
//
// Compact frame protocol over Tauri Channel raw bytes:
//   [type, keyframe, 0, 0, payload...]
//
// Raw IPC avoids base64 encode/decode and avoids Tauri serializing large Vec<u8>
// payloads into huge JS objects.
//
// Compact (4-byte) header for legacy IPC fallback frames.
//   [type: u8] [is_keyframe: u8] [reserved: u16] [payload...]
//
// Type codes:
//   0x00 = jpeg
//   0x01 = h264
//   0x02 = h265
//   0xFF = unknown
//
const FRAME_TYPE_JPEG: u8 = 0x00;
const FRAME_TYPE_H264: u8 = 0x01;
const FRAME_TYPE_H265: u8 = 0x02;
const FRAME_TYPE_UNKNOWN: u8 = 0xFF;
const IPC_HEADER_SIZE: usize = 4;

fn frame_type_code(frame_type: &str) -> u8 {
    match frame_type {
        "jpeg" => FRAME_TYPE_JPEG,
        "h264" => FRAME_TYPE_H264,
        "h265" => FRAME_TYPE_H265,
        _ => FRAME_TYPE_UNKNOWN,
    }
}

fn ipc_header(type_code: u8, is_keyframe: bool) -> [u8; IPC_HEADER_SIZE] {
    [type_code, if is_keyframe { 1 } else { 0 }, 0, 0]
}

fn ipc_header_for_info(info: &FrameInfo) -> [u8; IPC_HEADER_SIZE] {
    ipc_header(frame_type_code(&info.r#type), info.is_keyframe)
}

fn jpeg_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return None;
    }

    let mut idx = 2usize;
    while idx + 4 <= data.len() {
        while idx < data.len() && data[idx] != 0xFF {
            idx += 1;
        }
        while idx < data.len() && data[idx] == 0xFF {
            idx += 1;
        }
        if idx >= data.len() {
            break;
        }

        let marker = data[idx];
        idx += 1;

        if marker == 0xD9 || marker == 0xDA {
            break;
        }
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        if idx + 2 > data.len() {
            break;
        }

        let segment_len = u16::from_be_bytes([data[idx], data[idx + 1]]) as usize;
        if segment_len < 2 || idx + segment_len > data.len() {
            break;
        }

        let is_sof = matches!(
            marker,
            0xC0 | 0xC1
                | 0xC2
                | 0xC3
                | 0xC5
                | 0xC6
                | 0xC7
                | 0xC9
                | 0xCA
                | 0xCB
                | 0xCD
                | 0xCE
                | 0xCF
        );
        if is_sof && segment_len >= 7 {
            let height = u16::from_be_bytes([data[idx + 3], data[idx + 4]]) as u32;
            let width = u16::from_be_bytes([data[idx + 5], data[idx + 6]]) as u32;
            if width > 0 && height > 0 {
                return Some((width, height));
            }
            return None;
        }

        idx += segment_len;
    }

    None
}

/// Build `[type, keyframe, 0, 0, payload...]` in one buffer.
fn build_ipc_frame(type_code: u8, is_keyframe: bool, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(IPC_HEADER_SIZE + payload.len());
    out.extend_from_slice(&ipc_header(type_code, is_keyframe));
    out.extend_from_slice(payload);
    out
}

fn send_channel_frame(
    frame_channel: &Channel<InvokeResponseBody>,
    stats: &AtomicStats,
    type_code: u8,
    is_keyframe: bool,
    payload: &[u8],
) {
    let buf = build_ipc_frame(type_code, is_keyframe, payload);
    if let Err(error) = frame_channel.send(InvokeResponseBody::Raw(buf)) {
        warn!(%error, "frame channel send failed");
        stats.errors.fetch_add(1, Ordering::Relaxed);
    }
}

fn send_raw_channel_frame(
    frame_channel: &Channel<InvokeResponseBody>,
    stats: &AtomicStats,
    buf: Vec<u8>,
) {
    if let Err(error) = frame_channel.send(InvokeResponseBody::Raw(buf)) {
        warn!(%error, "frame channel send failed");
        stats.errors.fetch_add(1, Ordering::Relaxed);
    }
}

fn send_prefixed_channel_frame(
    frame_channel: &Channel<InvokeResponseBody>,
    stats: &AtomicStats,
    buf: Vec<u8>,
    info: &FrameInfo,
) {
    stats.received_frames.fetch_add(1, Ordering::Relaxed);
    mark_output_frame(stats, info.timestamp);
    send_raw_channel_frame(frame_channel, stats, buf);
}

/// Send assembled frame to the frontend via the binary Channel.
/// H.265 output policy:
///   - compressed H.265 is handed off to a bounded background decode queue.
///     On overflow, the queue is dropped and decode resumes from the next keyframe
///     to keep latency bounded without corrupting HEVC references.
#[inline]
#[allow(clippy::too_many_arguments)]
fn send_frame_to_frontend(
    app: &AppHandle,
    frame_channel: &Channel<InvokeResponseBody>,
    stats: &AtomicStats,
    data: Vec<u8>,
    info: FrameInfo,
    decoder: &mut Option<SmartDecoder>,
    output_codec: &str,
    h265_slot: &Arc<(StdMutex<H265DecodeQueue>, Condvar)>,
    mjpeg_broadcaster: &Option<Arc<MjpegBroadcaster>>,
    last_keyframe_request_at: &mut Instant,
) {
    if output_codec == "mjpeg" && info.r#type == "jpeg" {
        stats.received_frames.fetch_add(1, Ordering::Relaxed);
        mark_output_frame(stats, info.timestamp);
        stats.set_decoder_backend("mjpeg-passthrough");
        if let Some(mjpeg) = mjpeg_broadcaster {
            let (width, height) = jpeg_dimensions(&data).unwrap_or((0, 0));
            stats.set_frame_dimensions(width, height, width, height);
            mjpeg.publish(data, width, height);
        } else {
            send_channel_frame(
                frame_channel,
                stats,
                FRAME_TYPE_JPEG,
                info.is_keyframe,
                &data,
            );
        }
        let _ = (app, decoder);
        return;
    }

    if info.r#type == "h265" && output_codec != "h265" {
        // Low-latency policy: never allow a stale GOP to accumulate. HEVC delta
        // frames cannot be dropped individually, so an overload discards the
        // queued GOP immediately and resumes from the newest IRAP frame.
        let (lock, cvar) = &**h265_slot;
        let mut guard = lock.lock().unwrap();
        if guard.needs_keyframe && !info.is_keyframe {
            stats.dropped_frames.fetch_add(1, Ordering::Relaxed);
            stats
                .decode_queue_depth
                .store(guard.frames.len() as u32, Ordering::Relaxed);
            stats
                .decoder_waiting_keyframe
                .store(true, Ordering::Relaxed);
            emit_keyframe_request(
                app,
                stats,
                last_keyframe_request_at,
                "h265_waiting_keyframe",
            );
            let _ = (app, frame_channel, decoder);
            return;
        }

        let mut reset_decoder = false;
        let now = Instant::now();
        let backlog_age = h265_queue_head_age(&guard, now);
        let backlog_over_time = backlog_age >= H265_MAX_LATENCY;
        let backlog_over_capacity = guard.frames.len() >= H265_DECODE_QUEUE_CAPACITY;
        if backlog_over_time || backlog_over_capacity {
            if info.is_keyframe {
                // A keyframe lets us safely catch up to the freshest picture.
                let dropped_old = clear_h265_gop(&mut guard, stats);
                guard.needs_keyframe = false;
                stats
                    .decoder_waiting_keyframe
                    .store(false, Ordering::Relaxed);
                reset_decoder = true;
                warn!(
                    dropped_old,
                    backlog_age_ms = backlog_age.as_millis() as u64,
                    "H.265 backlog recovered at keyframe"
                );
            } else {
                // Continuing to decode this full queue only displays stale
                // video and delays recovery. Drop it as one dependency unit;
                // subsequent deltas are rejected until a fresh IRAP arrives.
                let dropped_old = clear_h265_gop(&mut guard, stats);
                stats.dropped_frames.fetch_add(1, Ordering::Relaxed);
                emit_keyframe_request(
                    app,
                    stats,
                    last_keyframe_request_at,
                    if backlog_over_time {
                        "h265_queue_latency_exceeded"
                    } else {
                        "h265_queue_capacity_exceeded"
                    },
                );
                warn!(
                    dropped_old = dropped_old + 1,
                    backlog_age_ms = backlog_age.as_millis() as u64,
                    "H.265 backlog exceeded budget; waiting for keyframe"
                );
                let _ = (app, frame_channel, decoder);
                return;
            }
        }

        if guard.needs_keyframe {
            if !info.is_keyframe {
                stats.dropped_frames.fetch_add(1, Ordering::Relaxed);
                stats.decode_queue_depth.store(0, Ordering::Relaxed);
                emit_keyframe_request(
                    app,
                    stats,
                    last_keyframe_request_at,
                    "h265_waiting_keyframe",
                );
                let _ = (app, frame_channel, decoder);
                return;
            }
            guard.needs_keyframe = false;
            reset_decoder = true;
            stats
                .decoder_waiting_keyframe
                .store(false, Ordering::Relaxed);
        }

        let generation = guard.generation;
        guard.frames.push_back(PendingH265Frame {
            data,
            is_keyframe: info.is_keyframe,
            reset_decoder,
            enqueued_at: now,
            generation,
        });
        stats
            .decode_queue_depth
            .store(guard.frames.len() as u32, Ordering::Relaxed);
        cvar.notify_one();
        let _ = (app, frame_channel, decoder); // silence unused warnings
        return;
    }

    if info.r#type == "h264" || info.r#type == "h265" {
        // Frontend compressed video decoding was removed. If an unsupported
        // compressed frame still reaches this point, drop it instead of
        // forwarding data the renderer cannot decode.
        stats.dropped_frames.fetch_add(1, Ordering::Relaxed);
        let _ = (app, frame_channel, decoder);
        return;
    }

    // Legacy IPC fallback for JPEG/unknown frames only.
    stats.received_frames.fetch_add(1, Ordering::Relaxed);
    mark_output_frame(stats, info.timestamp);
    send_channel_frame(
        frame_channel,
        stats,
        frame_type_code(&info.r#type),
        info.is_keyframe,
        &data,
    );
}
