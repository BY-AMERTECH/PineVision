/* ============================================================
   drone-view.js
   Drone view page — real MediaMTX stream integration + Firebase detection
   
   NEW: Integrated Firebase real-time detection updates
   ============================================================ */

'use strict';

// ── Constants ─────────────────────────────────────────────────

const API_BASE         = '';        // same-origin Flask server
const POLL_INTERVAL_MS = 5_000;
const MAX_RECONNECT    = 3;

// Interval (ms) at which the frontend polls the scan document for progress
// while the backend sequential scan loop is running.
const SCAN_PROGRESS_POLL_MS = 2_000;

const HLS_CONFIG = {
    maxLoadingDelay:         10,
    manifestLoadingTimeOut:  8_000,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut:     8_000,
};

// ── State ─────────────────────────────────────────────────────

// (no video-time throttle state needed — scan is driven entirely by the backend)

const DRONE_STATE = {
    status:               'idle',   // idle|connecting|active|reconnecting|failed|ending
    streamUrl:            null,
    rtmpUrl:              null,
    streamPath:           null,
    blockId:              null,
    userId:               null,
    scanId:               null,
    scanStartTime:        null,
    timerInterval:        null,
    statsInterval:        null,
    pollInterval:         null,
    reconnectAttempts:    0,
    hls:                  null,
    firebaseListener:     null,
    scanFirebaseListener: null,  // listener for scans/{scanId} completion signal
    scanProgressInterval: null,  // polls Firestore for backend scan progress
    videoMode:            false,  // true when playing an uploaded MP4 (not live HLS)
    videoBlobUrl:         null,   // object URL for the uploaded file
    videoEnded:           false,  // true when browser video element has finished playing
    backendCompleted:     false,  // true when backend scan loop signals 'completed' via Firestore
    _syncPrevPct:         0,      // scanProgress value at the previous syncVideoToBackend call
    _syncPrevTime:        0,      // Date.now() at the previous syncVideoToBackend call
    stats: { total: 0, bearing: 0, nonBearing: 0, discolored: 0, progress: 0 },
};

const STATUS_LABELS = {
    idle:         'No Signal',
    connecting:   'Connecting...',
    active:       'Live',
    reconnecting: 'Reconnecting...',
    failed:       'Connection Failed',
    ending:       'Ending Scan...',
};

// ── Bounding-box Overlay ──────────────────────────────────────
//
// Renders per-frame detection boxes on top of the MP4 video.
// Data flows: backend detect_frame() → Firestore recentFrames → ingestFrames()
// → frameCache.  A requestAnimationFrame loop looks up the closest stored
// frame time for video.currentTime and draws the matching boxes.
//
// Coordinate mapping: bboxes arrive normalized (0–1) relative to the inference
// frame, which is isotropically scaled from the original video, so normalized
// coords are identical to those of the original frame.  getVideoPaintRect()
// accounts for object-fit:cover so boxes line up with the visible pixels.

const BboxOverlay = (() => {
    const COLORS = {
        bearing:     '#22c55e',
        non_bearing: '#f59e0b',
        non_viable:  '#eab308',
    };
    const SHORT = { bearing: 'B', non_bearing: 'NB', non_viable: 'NV' };

    let frameTimes = [];        // sorted number[] — timestamps of stored frames
    let frameCache = new Map(); // time → detection[]
    let rafId      = null;
    let active     = false;
    let canvas     = null;
    let ctx        = null;

    function init() {
        canvas = document.getElementById('dv-bbox-canvas');
        if (canvas) ctx = canvas.getContext('2d');
    }

    function start() {
        if (!canvas) init();
        if (!canvas || !ctx) return;
        frameTimes = [];
        frameCache.clear();
        active = true;
        canvas.classList.add('dv-bbox-active');
        _scheduleRaf();
    }

    function stop() {
        active = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (canvas) {
            canvas.classList.remove('dv-bbox-active');
            if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        frameTimes = [];
        frameCache.clear();
    }

    // Called from startScanCompletionListener whenever the scan doc updates
    function ingestFrames(recentFrames) {
        if (!Array.isArray(recentFrames)) return;
        for (const f of recentFrames) {
            const t = Number(f.t);
            if (isNaN(t)) continue;
            if (!frameCache.has(t)) {
                // Keep frameTimes sorted (frames arrive roughly in order)
                frameTimes.splice(_upperBound(frameTimes, t), 0, t);
            }
            frameCache.set(t, Array.isArray(f.d) ? f.d : []);
        }
    }

    function _scheduleRaf() {
        if (!active) return;
        rafId = requestAnimationFrame(_tick);
    }

    function _tick() {
        if (!active) return;

        const wrapper = document.getElementById('drone-feed-wrapper');
        const videoEl = document.getElementById('drone-feed');
        if (!wrapper || !videoEl) { _scheduleRaf(); return; }

        // Keep canvas pixel dimensions in sync with wrapper
        const cw = wrapper.clientWidth, ch = wrapper.clientHeight;
        if (cw > 0 && ch > 0 && (canvas.width !== cw || canvas.height !== ch)) {
            canvas.width  = cw;
            canvas.height = ch;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (videoEl.readyState >= 1 && videoEl.videoWidth) {
            const dets = _findDetections(videoEl.currentTime);
            if (dets && dets.length > 0) {
                const pr = _getVideoPaintRect(videoEl);
                if (pr) _drawDetections(dets, pr);
            }
        }

        _scheduleRaf();
    }

    // Binary-search: find the latest stored frame time <= timeSec (+ small
    // forward tolerance to cover frames arriving slightly ahead of playback).
    function _findDetections(timeSec) {
        if (!frameTimes.length) return null;
        let idx = _upperBound(frameTimes, timeSec + 0.4) - 1;
        if (idx < 0) return null;
        // Don't show boxes more than 2 s stale (handles large processed-frame gaps)
        if (timeSec - frameTimes[idx] > 2.0) return null;
        return frameCache.get(frameTimes[idx]) || null;
    }

    // Returns the painted rect of the video content inside the element,
    // accounting for object-fit:cover (scaled to fill, may crop edges).
    function _getVideoPaintRect(videoEl) {
        const cW = videoEl.clientWidth,  cH = videoEl.clientHeight;
        const vW = videoEl.videoWidth,   vH = videoEl.videoHeight;
        if (!vW || !vH) return null;
        const scale = Math.max(cW / vW, cH / vH);
        return {
            x: (cW - vW * scale) / 2,
            y: (cH - vH * scale) / 2,
            w: vW * scale,
            h: vH * scale,
        };
    }

    function _drawDetections(dets, pr) {
        ctx.save();
        ctx.font = 'bold 11px monospace';
        ctx.textBaseline = 'top';

        for (const det of dets) {
            if (!det.b || det.b.length < 4) continue;
            const [nx, ny, nw, nh] = det.b;
            const color   = COLORS[det.cls] || '#94a3b8';
            const confStr = (typeof det.conf === 'number' && det.conf > 0)
                ? ' ' + Math.round(det.conf * 100) + '%'
                : '';
            const label   = (SHORT[det.cls] || '?') + ' #' + det.id + confStr;
            const px = nx * pr.w + pr.x;
            const py = ny * pr.h + pr.y;
            const pw = nw * pr.w;
            const ph = nh * pr.h;

            if (pw < 4 || ph < 4) continue;

            // Translucent fill
            ctx.globalAlpha = 0.10;
            ctx.fillStyle   = color;
            ctx.fillRect(px, py, pw, ph);
            ctx.globalAlpha = 1;

            // Box outline
            ctx.strokeStyle = color;
            ctx.lineWidth   = 1.5;
            ctx.strokeRect(px, py, pw, ph);

            // Label pill (float above box, clamp to canvas top)
            const tw     = ctx.measureText(label).width;
            const lh     = 15;
            const lx     = px;
            const ly     = py >= lh ? py - lh : py + ph;
            ctx.globalAlpha = 0.88;
            ctx.fillStyle   = color;
            ctx.fillRect(lx, ly, tw + 6, lh);
            ctx.globalAlpha = 1;
            ctx.fillStyle   = '#000';
            ctx.fillText(label, lx + 3, ly + 2);
        }

        ctx.restore();
    }

    // Standard upper-bound: first index where arr[i] > val
    function _upperBound(arr, val) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] <= val) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    return { init, start, stop, ingestFrames };
})();

// ── UI Rendering ──────────────────────────────────────────────

function renderUI() {
    const s = DRONE_STATE.status;

    // Status indicator
    const indicator = document.getElementById('dv-status-indicator');
    indicator.className = `dv-status-${s} d-flex align-items-center gap-2 me-3`;
    document.querySelector('.dv-status-label').textContent = STATUS_LABELS[s] ?? s;

    // Derived state groups
    const isLive     = s === 'active';
    const isLoading  = s === 'connecting' || s === 'reconnecting';
    const isInactive = s === 'idle' || s === 'failed';
    const isSession  = s === 'active' || s === 'reconnecting';

    // Placeholder title/hint varies between idle and failed
    document.querySelector('.dv-placeholder-title').textContent =
        s === 'failed' ? 'Connection Failed' : 'Awaiting Connection';
    document.querySelector('.dv-placeholder-hint').textContent =
        s === 'failed'
            ? 'Stream could not be established. Check setup and try again.'
            : 'Click "Connect Drone" or "Upload MP4" to begin a scan session';

    // Connecting overlay label changes for reconnect
    const connLabel = document.querySelector('.dv-connecting-label');
    if (connLabel) connLabel.textContent = s === 'reconnecting' ? 'Reconnecting...' : 'Connecting...';

    // Topbar buttons
    toggleEl('btn-connect',        isInactive);
    toggleEl('btn-upload-video',   isInactive);
    toggleEl('btn-end-scan',       isSession);
    toggleEl('btn-end-scan-stats', isSession);

    // Video + overlays
    toggleClass('drone-feed',         'dv-feed-active', isLive);
    toggleEl('dv-placeholder',        isInactive);
    toggleEl('dv-connecting-overlay', isLoading);
    toggleEl('dv-live-overlay',       isLive);

    // Timer stays visible while a session is active
    toggleEl('dv-timer', isSession);

    // Reset stat display only when fully idle
    if (s === 'idle') resetStatDisplay();
}

function transitionTo(newStatus) {
    DRONE_STATE.status = newStatus;
    renderUI();
}

// ── Backend API ───────────────────────────────────────────────

async function apiPrepare() {
    const resp = await fetch(`${API_BASE}/api/drone/prepare`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  AbortSignal.timeout(15_000),
    });
    if (!resp.ok && resp.status !== 500) throw new Error(`Server ${resp.status}`);
    return resp.json();
}

async function apiConnect(rtmpUrl) {
    const resp = await fetch(`${API_BASE}/api/drone/connect`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ rtmp_url: rtmpUrl }),
        signal:  AbortSignal.timeout(10_000),
    });
    if (!resp.ok && resp.status !== 400) throw new Error(`Server ${resp.status}`);
    return resp.json();
}

async function apiStatus(path) {
    const resp = await fetch(
        `${API_BASE}/api/drone/status?path=${encodeURIComponent(path)}`,
        { signal: AbortSignal.timeout(5_000) },
    );
    return resp.json();
}

// NEW: Start detection API
async function apiStartDetection(hlsUrl, blockId, userId, fps = 2) {
    const resp = await fetch(`${API_BASE}/api/drone/start-detection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            hls_url: hlsUrl,
            block_id: blockId,
            user_id: userId,
            fps,
        }),
        signal: AbortSignal.timeout(10_000)
    });
    return resp.json();
}

// NEW: Stop detection API
async function apiStopDetection(blockId, scanId, userId) {
    const resp = await fetch(`${API_BASE}/api/drone/stop-detection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            block_id: blockId,
            scan_id: scanId,
            user_id: userId,
        }),
        signal: AbortSignal.timeout(10_000)
    });
    return resp.json();
}


// ── Auto-Prepare (MediaMTX startup + IPv4 detection) ─────────

function showPrepareStatus(message) {
    document.getElementById('dv-prepare-status')?.classList.remove('d-none');
    const label = document.getElementById('dv-prepare-label');
    if (label) label.textContent = message;
}

function hidePrepareStatus() {
    document.getElementById('dv-prepare-status')?.classList.add('d-none');
}

async function autoPrepareModal() {
    const inputEl   = document.getElementById('input-rtmp-url');
    const submitBtn = document.getElementById('btn-connect-submit');

    if (inputEl)   inputEl.disabled   = true;
    if (submitBtn) submitBtn.disabled = true;
    hideConnectError();

    showPrepareStatus('Starting MediaMTX server...');

    let result;
    try {
        result = await apiPrepare();
    } catch {
        hidePrepareStatus();
        showConnectError('Backend unreachable. Ensure Flask server is running on port 5000.');
        if (inputEl)   inputEl.disabled   = false;
        if (submitBtn) submitBtn.disabled  = false;
        return;
    }

    hidePrepareStatus();

    if (result.ok) {
        if (inputEl) {
            inputEl.value    = result.rtmp_url;
            inputEl.disabled = false;
        }
        if (submitBtn) submitBtn.disabled = false;
        clearInputError('input-rtmp-url');

        // Warn user if multiple network interfaces detected — the pre-filled IP
        // might be the WiFi adapter while the DJI controller is on USB/hotspot.
        const allIps = result.all_ips || [];
        if (allIps.length > 1) {
            const warning = document.getElementById('dv-ip-warning');
            const list    = document.getElementById('dv-ip-list');
            if (warning && list) {
                list.innerHTML = allIps.map(ip =>
                    `<li><code>rtmp://${ip}:1935/pinevision_scan</code></li>`
                ).join('');
                warning.classList.remove('d-none');
            }
        } else {
            document.getElementById('dv-ip-warning')?.classList.add('d-none');
        }
    } else {
        showConnectError(result.message ?? 'Failed to prepare drone connection.');
        if (inputEl)   inputEl.disabled   = false;
        if (submitBtn) submitBtn.disabled  = false;
    }
}

// ── Connection Workflow ───────────────────────────────────────

async function handleConnect() {
    if (DRONE_STATE.status === 'connecting') return;

    const rawUrl = document.getElementById('input-rtmp-url').value.trim();

    if (!validateRtmpUrl(rawUrl)) {
        showInputError('input-rtmp-url', 'Enter a valid RTMP URL (rtmp://...)');
        return;
    }
    clearInputError('input-rtmp-url');
    hideConnectError();
    setConnectButtonLoading(true);
    lockConnectModal(true);
    transitionTo('connecting');
    setConnectingLabel('Connecting drone stream...');

    let result;
    try {
        result = await apiConnect(rawUrl);
    } catch {
        handleConnectFailed(
            'Cannot reach the backend server. Ensure Flask (backend/app.py) is running on port 5000.',
        );
        return;
    }

    if (!result.ok) {
        const MESSAGES = {
            invalid_url:      'Invalid RTMP URL format. Expected: rtmp://HOST:PORT/PATH',
            mediamtx_offline: 'MediaMTX is not running. Start mediamtx.exe and try again.',
            path_not_found:   'Stream path not found in MediaMTX configuration.',
            stream_not_ready: 'Drone is not streaming. Start the live stream in DJI Fly first.',
        };
        handleConnectFailed(MESSAGES[result.error] ?? result.message ?? 'Connection failed.');
        return;
    }

    DRONE_STATE.rtmpUrl           = rawUrl;
    DRONE_STATE.streamUrl         = result.hls_url;
    DRONE_STATE.streamPath        = result.path;
    DRONE_STATE.reconnectAttempts = 0;

    loadHlsStream(result.hls_url, /* isReconnect */ false);
}

// ── HLS Playback ──────────────────────────────────────────────

function loadHlsStream(hlsUrl, isReconnect) {
    if (typeof Hls === 'undefined') {
        handleConnectFailed('hls.js not loaded. Check your internet connection.');
        return;
    }

    if (!Hls.isSupported()) {
        const videoEl = document.getElementById('drone-feed');
        if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            videoEl.src = hlsUrl;
            videoEl.addEventListener('loadedmetadata', () => onHlsReady(isReconnect), { once: true });
            videoEl.addEventListener('error', () => onHlsFatalError(isReconnect), { once: true });
            return;
        }
        handleConnectFailed('HLS is not supported in this browser.');
        return;
    }

    destroyHls();

    const hls     = new Hls(HLS_CONFIG);
    const videoEl = document.getElementById('drone-feed');
    DRONE_STATE.hls = hls;

    hls.loadSource(hlsUrl);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoEl.play().catch(() => {});
        onHlsReady(isReconnect);
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) onHlsFatalError(isReconnect);
    });
}

async function onHlsReady(isReconnect) {
    if (isReconnect) {
        DRONE_STATE.reconnectAttempts = 0;
        transitionTo('active');
        utils.showToast('Stream reconnected', 'success');
        return;
    }

    // Initial connection success
    setConnectButtonLoading(false);
    lockConnectModal(false);
    closeBsModal('modal-connect');

    DRONE_STATE.scanStartTime = new Date();
    startScanTimer();
    startStatusPolling();

    // NEW: Start detection on backend
    await startDetection();

    transitionTo('active');
    document.getElementById('dv-stream-quality').textContent = 'HLS';
    utils.showToast('Drone stream connected', 'success');
}

function onHlsFatalError(isReconnect) {
    if (isReconnect) {
        handleStreamLost();
    } else {
        handleConnectFailed(
            'Stream unavailable. Verify MediaMTX is running and the drone is broadcasting.',
        );
    }
}

function handleConnectFailed(message) {
    setConnectButtonLoading(false);
    lockConnectModal(false);
    showConnectError(message);
    destroyHls();
    stopStatusPolling();
    DRONE_STATE.streamUrl  = null;
    DRONE_STATE.streamPath = null;
    transitionTo('failed');
}

// ── NEW: Detection Start/Stop ─────────────────────────────────

async function startDetection() {
    if (!DRONE_STATE.streamUrl || !DRONE_STATE.blockId || !DRONE_STATE.userId) {
        utils.showToast('Cannot start detection: missing block or user context. Return to Blocks and try again.', 'error');
        return;
    }

    setConnectingLabel('Initializing live YOLOv8 detection...');

    try {
        console.log('🎯 Starting detection...');

        const result = await apiStartDetection(
            DRONE_STATE.streamUrl,
            DRONE_STATE.blockId,
            DRONE_STATE.userId,
            2   // fps — 2 frames/sec balances coverage vs. CPU load
        );

        if (result.ok) {
            console.log('✅ Detection started:', result.scan_id);
            DRONE_STATE.scanId = result.scan_id;
            
            // Start Firebase listener
            startFirebaseListener();
        } else {
            console.error('❌ Failed to start detection:', result.message);
            utils.showToast('Failed to start detection: ' + result.message, 'error');
        }
    } catch (error) {
        console.error('❌ Detection start error:', error);
        utils.showToast('Failed to start detection', 'error');
    }
}

async function stopDetection() {
    if (!DRONE_STATE.scanId || !DRONE_STATE.blockId) {
        console.error('❌ No active scan to stop');
        return false;
    }

    try {
        console.log('🛑 Stopping detection...');

        const result = await apiStopDetection(
            DRONE_STATE.blockId,
            DRONE_STATE.scanId,
            DRONE_STATE.userId
        );

        if (result.ok) {
            console.log('✅ Detection stopped successfully');
            stopFirebaseListener();
            return true;
        } else {
            console.error('❌ Failed to stop detection:', result.message);
            return false;
        }
    } catch (error) {
        console.error('❌ Detection stop error:', error);
        return false;
    }
}

// ── Video Upload Mode ─────────────────────────────────────────

async function apiUploadVideo(formData) {
    const resp = await fetch(`${API_BASE}/api/drone/upload-video`, {
        method: 'POST',
        body:   formData,
        // No Content-Type header — browser sets multipart boundary automatically
        signal: AbortSignal.timeout(120_000),  // large file may take time
    });
    if (!resp.ok) {
        // Try to extract a message from a JSON error body (routes.py returns one).
        // If the body is HTML (e.g. Werkzeug 500 debug page), fall back to status text.
        let msg = `Server error (HTTP ${resp.status})`;
        try {
            const body = await resp.json();
            if (body && body.message) msg = body.message;
        } catch {
            msg = `Server error (HTTP ${resp.status}: ${resp.statusText || 'Internal Server Error'})`;
        }
        throw new Error(msg);
    }
    return resp.json();
}

function handleVideoUploadClick() {
    if (DRONE_STATE.status !== 'idle' && DRONE_STATE.status !== 'failed') return;
    document.getElementById('input-video-file').click();
}

async function handleFileSelect(event) {
    const file = event.target.files[0];
    event.target.value = '';   // allow re-selecting the same file later

    if (!file) return;

    if (!file.type.includes('mp4') && !file.name.toLowerCase().endsWith('.mp4')) {
        utils.showToast('Only MP4 files are supported', 'error');
        return;
    }

    if (!DRONE_STATE.blockId || !DRONE_STATE.userId) {
        utils.showToast('Missing block context. Return to Blocks and try again.', 'error');
        return;
    }

    // Revoke any leftover blob URL from a previous upload
    if (DRONE_STATE.videoBlobUrl) {
        URL.revokeObjectURL(DRONE_STATE.videoBlobUrl);
        DRONE_STATE.videoBlobUrl = null;
    }

    // Load video locally so playback starts as soon as upload completes
    DRONE_STATE.videoBlobUrl = URL.createObjectURL(file);
    const videoEl = document.getElementById('drone-feed');
    videoEl.src   = DRONE_STATE.videoBlobUrl;
    videoEl.load();

    // Show upload-in-progress state
    DRONE_STATE.videoMode = true;
    transitionTo('connecting');
    setConnectingLabel('Uploading video and starting analysis...');

    // POST file to backend
    const formData = new FormData();
    formData.append('file',     file);
    formData.append('block_id', DRONE_STATE.blockId);
    formData.append('user_id',  DRONE_STATE.userId);

    let result;
    try {
        result = await apiUploadVideo(formData);
    } catch (err) {
        console.error('Video upload error:', err);
        let msg;
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            // AbortSignal.timeout() fires after 120 s — model may still be loading
            msg = 'Upload timed out. The server may be initializing — try again in a moment.';
        } else if (err instanceof TypeError) {
            // fetch() throws TypeError on network-level failure (connection refused, no server)
            msg = 'Cannot reach backend. Ensure Flask server is running on port 5000.';
        } else {
            // Error thrown by apiUploadVideo's !resp.ok branch — actual backend error
            msg = err.message || 'Backend error. Check the Flask server terminal for details.';
        }
        handleVideoFailed(msg);
        return;
    }

    if (!result.ok) {
        handleVideoFailed(result.message ?? 'Upload failed.');
        return;
    }

    // Upload successful — activate video scan session
    DRONE_STATE.scanId           = result.scan_id;
    DRONE_STATE.scanStartTime    = new Date();
    DRONE_STATE.videoEnded       = false;
    DRONE_STATE.backendCompleted = false;
    DRONE_STATE._syncPrevPct     = 0;
    DRONE_STATE._syncPrevTime    = 0;

    startFirebaseListener();
    startScanCompletionListener();
    startScanTimer();

    // Video stays paused until syncVideoToBackend() receives the first backend
    // progress update (~2 s after scan start).  This ensures the initial bbox
    // batch is already cached before the video begins playing, so every visible
    // frame has detection boxes available from the first moment.
    videoEl.addEventListener('ended', handleVideoEnd, { once: true });

    transitionTo('active');
    BboxOverlay.start();
    document.getElementById('dv-stream-quality').textContent = 'MP4';
    document.querySelector('.dv-live-badge').innerHTML =
        '<span class="dv-live-dot" aria-hidden="true"></span> MP4';
    utils.showToast('Video scan started', 'success');
}

function handleVideoFailed(message) {
    BboxOverlay.stop();
    DRONE_STATE.videoMode     = false;
    DRONE_STATE._syncPrevPct  = 0;
    DRONE_STATE._syncPrevTime = 0;

    const videoEl = document.getElementById('drone-feed');
    videoEl.removeEventListener('timeupdate', updateVideoProgress);
    videoEl.playbackRate = 1.0;
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();

    if (DRONE_STATE.videoBlobUrl) {
        URL.revokeObjectURL(DRONE_STATE.videoBlobUrl);
        DRONE_STATE.videoBlobUrl = null;
    }

    transitionTo('failed');
    document.querySelector('.dv-placeholder-hint').textContent = message;
    utils.showToast(message, 'error');
}

function updateVideoProgress() {
    const videoEl = document.getElementById('drone-feed');
    if (!DRONE_STATE.videoMode || !videoEl.duration) return;
    const pct = (videoEl.currentTime / videoEl.duration) * 100;

    DRONE_STATE.stats.progress = pct;
    const fill = document.getElementById('stat-progress-fill');
    if (fill) { fill.style.width = pct + '%'; fill.setAttribute('aria-valuenow', pct); }
    const pctEl = document.getElementById('stat-progress-pct');
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';

    // Note: video position is NOT sent to the backend — the backend sequential
    // scan loop reads frames independently of browser playback timing, which is
    // what guarantees deterministic results across repeated scans.
}

function handleVideoEnd() {
    if (DRONE_STATE.status !== 'active' || !DRONE_STATE.videoMode) return;

    DRONE_STATE.videoEnded = true;

    if (!DRONE_STATE.backendCompleted) {
        utils.showToast('Video complete — waiting for analysis to finish...', 'info');
    }

    checkVideoScanComplete();
}

function showScanFinishedModal() {
    document.getElementById('sf-duration').textContent    = document.getElementById('dv-timer').textContent;
    document.getElementById('sf-total').textContent       = DRONE_STATE.stats.total.toLocaleString();
    document.getElementById('sf-bearing').textContent     = DRONE_STATE.stats.bearing.toFixed(1) + '%';
    document.getElementById('sf-non-bearing').textContent = DRONE_STATE.stats.nonBearing.toFixed(1) + '%';
    document.getElementById('sf-discolored').textContent  = DRONE_STATE.stats.discolored.toFixed(1) + '%';

    const modal = new bootstrap.Modal(document.getElementById('modal-scan-finished'));
    modal.show();
}

function handleScanFinished() {
    closeBsModal('modal-scan-finished');
    BboxOverlay.stop();

    // Data is already persisted: backend called complete_scan_session before
    // signalling 'completed', which wrote final counts to both the scan doc and
    // the block doc in a single atomic batch. No additional save call needed.
    stopFirebaseListener();

    const videoEl = document.getElementById('drone-feed');
    videoEl.removeEventListener('timeupdate', updateVideoProgress);
    videoEl.playbackRate = 1.0;
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();

    if (DRONE_STATE.videoBlobUrl) {
        URL.revokeObjectURL(DRONE_STATE.videoBlobUrl);
        DRONE_STATE.videoBlobUrl = null;
    }

    DRONE_STATE.videoMode        = false;
    DRONE_STATE.videoEnded       = false;
    DRONE_STATE.backendCompleted = false;
    DRONE_STATE.scanId           = null;
    DRONE_STATE.scanStartTime    = null;
    DRONE_STATE._syncPrevPct     = 0;
    DRONE_STATE._syncPrevTime    = 0;
    DRONE_STATE.stats            = { total: 0, bearing: 0, nonBearing: 0, discolored: 0, progress: 0 };

    transitionTo('idle');

    if (DRONE_STATE.blockId) {
        setTimeout(() => {
            window.location.href = 'blocks-view.html?id=' + DRONE_STATE.blockId;
        }, 600);
    }
}

// ── NEW: Firebase Real-time Listener ──────────────────────────

function startFirebaseListener() {
    if (!DRONE_STATE.blockId || typeof firebase === 'undefined') {
        console.error('❌ Firebase not available or no block ID');
        return;
    }

    console.log('🔥 Starting Firebase listener for block:', DRONE_STATE.blockId);

    // Listen to block document changes
    DRONE_STATE.firebaseListener = firebase.firestore()
        .collection('blocks')
        .doc(DRONE_STATE.blockId)
        .onSnapshot((doc) => {
            if (doc.exists) {
                updateStatsFromFirebase(doc.data());
            }
        }, (error) => {
            console.error('❌ Firebase listener error:', error);
        });
}

function stopFirebaseListener() {
    if (DRONE_STATE.firebaseListener) {
        console.log('🔥 Stopping Firebase listener');
        DRONE_STATE.firebaseListener();
        DRONE_STATE.firebaseListener = null;
    }
    if (DRONE_STATE.scanFirebaseListener) {
        DRONE_STATE.scanFirebaseListener();
        DRONE_STATE.scanFirebaseListener = null;
    }
}

function syncVideoToBackend(pct) {
    // Update progress bar from backend frame position
    DRONE_STATE.stats.progress = pct;
    const fill = document.getElementById('stat-progress-fill');
    if (fill) { fill.style.width = pct + '%'; fill.setAttribute('aria-valuenow', pct); }
    const pctEl = document.getElementById('stat-progress-pct');
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';

    const videoEl = document.getElementById('drone-feed');
    if (!videoEl || !Number.isFinite(videoEl.duration) || videoEl.duration <= 0) return;

    const now      = Date.now();
    const prevPct  = DRONE_STATE._syncPrevPct;
    const prevTime = DRONE_STATE._syncPrevTime;

    // Derive how many video-seconds the backend has processed per real second
    // and set the <video> element's playbackRate to match.  This keeps the
    // frame currently visible to the user aligned with the backend's processed
    // position without ever pausing or seeking the video:
    //   • On fast hardware (GPU): rate > 1 → video plays faster than real-time;
    //     all bboxes are pre-cached before the matching frame is displayed.
    //   • On slow hardware (CPU): rate < 1 → video plays in slow motion;
    //     every displayed frame already has its bboxes cached.
    // 200 ms guard prevents a spurious division when two snapshots arrive
    // very close together (e.g. Firestore initial + first write).
    if (prevTime > 0 && pct > prevPct && (now - prevTime) > 200) {
        const videoSecsDone   = (pct - prevPct) / 100 * videoEl.duration;
        const realSecsElapsed = (now - prevTime) / 1000;
        const backendRate     = videoSecsDone / realSecsElapsed;
        // 0.1× floor: prevents near-freeze on very slow hardware.
        // 4.0× ceiling: keeps the video watchable even on a fast GPU.
        videoEl.playbackRate  = Math.max(0.1, Math.min(4.0, backendRate));
    }

    DRONE_STATE._syncPrevPct  = pct;
    DRONE_STATE._syncPrevTime = now;

    // Start playback on the first progress update.  The video was deliberately
    // kept paused at scan start so the first bbox batch arrives before any
    // frame is displayed.
    if (videoEl.paused && !DRONE_STATE.videoEnded) {
        videoEl.play().catch(() => {});
    }
}

function startScanCompletionListener() {
    if (!DRONE_STATE.scanId || typeof firebase === 'undefined') return;

    console.log('🔥 Watching scan completion for:', DRONE_STATE.scanId);

    DRONE_STATE.scanFirebaseListener = firebase.firestore()
        .collection('scans')
        .doc(DRONE_STATE.scanId)
        .onSnapshot((doc) => {
            if (!doc.exists) return;
            const data = doc.data();

            // Sync video position and progress bar to backend's current frame
            if (DRONE_STATE.videoMode && typeof data.scanProgress === 'number') {
                syncVideoToBackend(data.scanProgress);
            }

            // Feed newly arrived frame bboxes into the overlay cache
            if (DRONE_STATE.videoMode && Array.isArray(data.recentFrames)) {
                BboxOverlay.ingestFrames(data.recentFrames);
            }

            if (data.status !== 'completed') return;

            // Overwrite stats with the authoritative final values from the scan doc
            const total = data.total || 0;
            DRONE_STATE.stats.total      = total;
            DRONE_STATE.stats.bearing    = data.bearingPercent    || 0;
            DRONE_STATE.stats.nonBearing = data.nonBearingPercent || 0;
            DRONE_STATE.stats.discolored = data.nonViablePercent  || 0;
            updateStatDisplay();

            DRONE_STATE.backendCompleted = true;
            checkVideoScanComplete();
        }, (error) => {
            console.error('❌ Scan completion listener error:', error);
        });
}

function checkVideoScanComplete() {
    if (DRONE_STATE.status !== 'active' || !DRONE_STATE.videoMode) return;
    // Backend completion is the authoritative signal — it runs the full frame
    // sequence deterministically, so its 'completed' status means all data is saved.
    if (!DRONE_STATE.backendCompleted) return;

    const videoEl = document.getElementById('drone-feed');

    // If the backend finished first (fast GPU / short video), let the video
    // play to its natural end before showing the results modal.  Reset rate to
    // 1× so the remaining seconds play at normal speed.  handleVideoEnd will
    // call checkVideoScanComplete() again once the 'ended' event fires.
    if (!DRONE_STATE.videoEnded) {
        if (videoEl && videoEl.ended) {
            // 'ended' fired but the flag was not set — fix the inconsistency
            DRONE_STATE.videoEnded = true;
        } else {
            if (videoEl) {
                videoEl.playbackRate = 1.0;
                if (videoEl.paused) videoEl.play().catch(() => {});
            }
            return;
        }
    }

    stopScanIntervals();
    showScanFinishedModal();
}

function updateStatsFromFirebase(data) {
    DRONE_STATE.stats.bearing    = data.bearingPercent    || 0;
    DRONE_STATE.stats.nonBearing = data.nonBearingPercent || 0;
    DRONE_STATE.stats.discolored = data.nonViable         || 0;
    DRONE_STATE.stats.total      = data.totalPineapples   || 0;

    // In video mode the progress bar shows playback position, not bearing rate
    if (!DRONE_STATE.videoMode) {
        DRONE_STATE.stats.progress = Math.round(data.bearingPercent || 0);
    }

    updateStatDisplay();
}

// ── Stream Health Polling ─────────────────────────────────────

function startStatusPolling() {
    DRONE_STATE.pollInterval = setInterval(async () => {
        const s = DRONE_STATE.status;
        if (s !== 'active' && s !== 'reconnecting') return;

        let result;
        try {
            result = await apiStatus(DRONE_STATE.streamPath);
        } catch {
            result = { ok: false, ready: false };
        }

        if (result.ready) {
            if (s === 'reconnecting') {
                transitionTo('connecting');
                loadHlsStream(DRONE_STATE.streamUrl, /* isReconnect */ true);
            }
        } else {
            handleStreamLost();
        }
    }, POLL_INTERVAL_MS);
}

function stopStatusPolling() {
    clearInterval(DRONE_STATE.pollInterval);
    DRONE_STATE.pollInterval = null;
}

async function handleStreamLost() {
    const s = DRONE_STATE.status;

    if (s === 'reconnecting') {
        DRONE_STATE.reconnectAttempts++;
        if (DRONE_STATE.reconnectAttempts >= MAX_RECONNECT) {
            stopScanIntervals();
            stopStatusPolling();
            await stopDetection();
            destroyHls();
            transitionTo('failed');
            utils.showToast('Stream lost. Scan ended automatically.', 'error');
        }
        return;
    }

    if (s === 'active') {
        DRONE_STATE.reconnectAttempts = 0;
        transitionTo('reconnecting');
        utils.showToast('Stream interrupted. Attempting to reconnect…', 'info');
    }
}

// ── End Scan Workflow ─────────────────────────────────────────

function onEndScanModalShow() {
    document.getElementById('summary-duration').textContent    = document.getElementById('dv-timer').textContent;
    document.getElementById('summary-total').textContent       = DRONE_STATE.stats.total.toLocaleString();
    document.getElementById('summary-bearing').textContent     = DRONE_STATE.stats.bearing.toFixed(1) + '%';
    document.getElementById('summary-non-bearing').textContent = DRONE_STATE.stats.nonBearing.toFixed(1) + '%';
    document.getElementById('summary-discolored').textContent  = DRONE_STATE.stats.discolored.toFixed(1) + '%';
}

async function handleEndScan() {
    setEndScanButtonLoading(true);
    transitionTo('ending');

    if (DRONE_STATE.videoMode) {
        // Prevent handleVideoEnd from firing the scan-finished modal
        document.getElementById('drone-feed').removeEventListener('ended', handleVideoEnd);
    }

    await stopDetection();

    if (DRONE_STATE.videoMode) {
        if (DRONE_STATE.videoBlobUrl) {
            URL.revokeObjectURL(DRONE_STATE.videoBlobUrl);
            DRONE_STATE.videoBlobUrl = null;
        }
        DRONE_STATE.videoMode = false;
    } else {
        destroyHls();
        stopStatusPolling();
    }

    stopScanIntervals();
    stopFirebaseListener();
    BboxOverlay.stop();

    const videoEl = document.getElementById('drone-feed');
    videoEl.playbackRate = 1.0;
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();

    DRONE_STATE.stats             = { total: 0, bearing: 0, nonBearing: 0, discolored: 0, progress: 0 };
    DRONE_STATE.scanStartTime     = null;
    DRONE_STATE.streamUrl         = null;
    DRONE_STATE.rtmpUrl           = null;
    DRONE_STATE.streamPath        = null;
    DRONE_STATE.reconnectAttempts = 0;
    DRONE_STATE.scanId            = null;
    DRONE_STATE.videoEnded        = false;
    DRONE_STATE.backendCompleted  = false;
    DRONE_STATE._syncPrevPct      = 0;
    DRONE_STATE._syncPrevTime     = 0;

    setEndScanButtonLoading(false);
    closeBsModal('modal-end-scan');
    transitionTo('idle');
    utils.showToast('Scan session ended', 'info');

    if (DRONE_STATE.blockId) {
        setTimeout(() => {
            window.location.href = 'blocks-view.html?id=' + DRONE_STATE.blockId;
        }, 1000);
    }
}

// ── Timer ─────────────────────────────────────────────────────

function startScanTimer() {
    const timerEl = document.getElementById('dv-timer');
    DRONE_STATE.timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - DRONE_STATE.scanStartTime) / 1000);
        const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
        const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        timerEl.textContent = `${h}:${m}:${s}`;
    }, 1_000);
}

function stopScanIntervals() {
    clearInterval(DRONE_STATE.timerInterval);
    DRONE_STATE.timerInterval = null;
    clearInterval(DRONE_STATE.scanProgressInterval);
    DRONE_STATE.scanProgressInterval = null;
}

// ── HLS Cleanup ───────────────────────────────────────────────

function destroyHls() {
    if (DRONE_STATE.hls) {
        DRONE_STATE.hls.destroy();
        DRONE_STATE.hls = null;
    }
}

// ── Fullscreen ────────────────────────────────────────────────

function setupFullscreen() {
    const btn     = document.getElementById('dv-fullscreen-btn');
    const wrapper = document.getElementById('drone-feed-wrapper');
    const icon    = btn.querySelector('i');

    btn.addEventListener('click', () => {
        if (!document.fullscreenElement) wrapper.requestFullscreen().catch(() => {});
        else document.exitFullscreen().catch(() => {});
    });

    document.addEventListener('fullscreenchange', () => {
        const fs = !!document.fullscreenElement;
        icon.className = fs ? 'ti ti-minimize' : 'ti ti-maximize';
        btn.setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Toggle fullscreen');
    });
}

// ── Connecting Overlay Label ──────────────────────────────────

function setConnectingLabel(text) {
    const el = document.querySelector('.dv-connecting-label');
    if (el) el.textContent = text;
}

// ── Display Helpers ───────────────────────────────────────────

function updateStatDisplay() {
    const s = DRONE_STATE.stats;
    document.getElementById('stat-total').textContent       = s.total.toLocaleString();
    document.getElementById('stat-bearing').textContent     = s.bearing.toFixed(1) + '%';
    document.getElementById('stat-non-bearing').textContent = s.nonBearing.toFixed(1) + '%';
    document.getElementById('stat-discolored').textContent  = s.discolored.toFixed(1) + '%';

    const fill = document.getElementById('stat-progress-fill');
    fill.style.width = s.progress + '%';
    fill.setAttribute('aria-valuenow', s.progress);
    document.getElementById('stat-progress-pct').textContent = Math.round(s.progress) + '%';
    document.querySelector('#dv-stats-panel .progress').setAttribute('aria-valuenow', s.progress);
}

function resetStatDisplay() {
    ['stat-total', 'stat-bearing', 'stat-non-bearing', 'stat-discolored'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '—';
    });
    const fill = document.getElementById('stat-progress-fill');
    if (fill) { fill.style.width = '0%'; fill.setAttribute('aria-valuenow', 0); }
    const pct = document.getElementById('stat-progress-pct');
    if (pct) pct.textContent = '0%';
    const timer = document.getElementById('dv-timer');
    if (timer) timer.textContent = '00:00:00';
}

// ── Input Error Helpers ───────────────────────────────────────

function showInputError(inputId, message) {
    document.getElementById(inputId)?.classList.add('is-invalid');
    const err = document.getElementById(inputId + '-error');
    if (err) { err.textContent = message; err.classList.remove('d-none'); }
}

function clearInputError(inputId) {
    document.getElementById(inputId)?.classList.remove('is-invalid');
    document.getElementById(inputId + '-error')?.classList.add('d-none');
}

function showConnectError(message) {
    const msg = document.getElementById('connect-error-message');
    if (msg) msg.textContent = message;
    document.getElementById('connect-error-banner')?.classList.remove('d-none');
}

function hideConnectError() {
    document.getElementById('connect-error-banner')?.classList.add('d-none');
}

// ── Button Loading States ─────────────────────────────────────

function setConnectButtonLoading(loading) {
    const btn = document.getElementById('btn-connect-submit');
    if (!btn) return;
    btn.disabled = loading;
    document.getElementById('btn-connect-label').textContent = loading ? 'Connecting...' : 'Connect';
    document.getElementById('btn-connect-spinner').classList.toggle('d-none', !loading);
}

function setEndScanButtonLoading(loading) {
    const btn = document.getElementById('btn-confirm-end-scan');
    if (!btn) return;
    btn.disabled = loading;
    document.getElementById('btn-end-label').textContent = loading ? 'Ending...' : 'End Scan';
    document.getElementById('btn-end-spinner').classList.toggle('d-none', !loading);
}

// ── Modal Lock During Connecting ──────────────────────────────

function lockConnectModal(lock) {
    const el = document.getElementById('modal-connect');
    if (!el) return;
    const modal = bootstrap.Modal.getInstance(el);
    if (!modal) return;
    modal._config.backdrop = lock ? 'static' : true;
    modal._config.keyboard = !lock;
    const closeBtn = el.querySelector('.btn-close');
    if (closeBtn) closeBtn.disabled = lock;
}

// ── DOM / Bootstrap Utilities ─────────────────────────────────

function toggleEl(id, show) {
    document.getElementById(id)?.classList.toggle('d-none', !show);
}

function toggleClass(id, cls, add) {
    document.getElementById(id)?.classList.toggle(cls, add);
}

function closeBsModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    bootstrap.Modal.getInstance(el)?.hide();
}

// ── URL Validation ────────────────────────────────────────────

function validateRtmpUrl(url) {
    return typeof url === 'string' && /^rtmp:\/\/.+/.test(url) && url.length > 10;
}

// ── Modal Event Wiring ────────────────────────────────────────

function setupModalEvents() {
    const connectModalEl = document.getElementById('modal-connect');
    connectModalEl.addEventListener('show.bs.modal', () => {
        clearInputError('input-rtmp-url');
        hideConnectError();
        hidePrepareStatus();
        document.getElementById('dv-ip-warning')?.classList.add('d-none');
        setConnectButtonLoading(false);
        autoPrepareModal();
    });
    document.getElementById('btn-connect-submit')
        .addEventListener('click', handleConnect);
    document.getElementById('input-rtmp-url')
        .addEventListener('keydown', e => { if (e.key === 'Enter') handleConnect(); });
    document.getElementById('input-rtmp-url')
        .addEventListener('input', () => clearInputError('input-rtmp-url'));

    const endScanModalEl = document.getElementById('modal-end-scan');
    endScanModalEl.addEventListener('show.bs.modal', () => {
        const s = DRONE_STATE.status;
        if (s === 'active' || s === 'reconnecting') onEndScanModalShow();
        setEndScanButtonLoading(false);
    });
    document.getElementById('btn-confirm-end-scan')
        .addEventListener('click', handleEndScan);

    document.getElementById('btn-scan-finished-ok')
        .addEventListener('click', handleScanFinished);
}

// ── Back Navigation ───────────────────────────────────────────

function setupBackNavigation() {
    document.getElementById('btn-back').addEventListener('click', () => {
        if (DRONE_STATE.blockId) {
            window.location.href = 'blocks-view.html?id=' + DRONE_STATE.blockId;
        } else if (history.length > 1) {
            history.back();
        } else {
            window.location.href = 'blocks.html';
        }
    });
}

// ── Page Initialization ───────────────────────────────────────

function initPage() {
    utils.initializeSettings();
    
    // Get block ID and user ID
    const urlParams = new URLSearchParams(window.location.search);
    DRONE_STATE.blockId = urlParams.get('blockId');
    
    // Get current user
    if (typeof auth !== 'undefined') {
        const currentUser = auth.getCurrentUser();
        if (currentUser) {
            DRONE_STATE.userId = currentUser.uid;
            console.log('✅ User ID:', DRONE_STATE.userId);
        }
    }
    
    console.log('📦 Block ID:', DRONE_STATE.blockId);
    
    BboxOverlay.init();
    setupBackNavigation();
    setupModalEvents();
    setupFullscreen();

    // Video upload button wiring
    document.getElementById('btn-upload-video')
        .addEventListener('click', handleVideoUploadClick);
    document.getElementById('input-video-file')
        .addEventListener('change', handleFileSelect);

    renderUI();
}

