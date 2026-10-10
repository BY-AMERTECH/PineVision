/* ============================================================
   drone-view.js
   Drone view page — real MediaMTX stream integration + Firebase detection

   MP4 UPLOAD: processing starts on upload, playback after a short buffer.
   The backend publishes timestamped boxes during processing. After the
   startup buffer, playback stays at 1×; final results never restart playback.

   The video playback rate is NEVER adjusted based on detection speed.
   video.currentTime is the sole source of truth for bbox lookup.
   ============================================================ */

'use strict';

// ── Constants ─────────────────────────────────────────────────

const API_BASE         = '';
const POLL_INTERVAL_MS = 5_000;
const MAX_RECONNECT    = 3;
// Upload-only startup buffer, in seconds after the upload is accepted.
const UPLOAD_STARTUP_DELAY_SECONDS = 7;
const UPLOAD_RESULT_POLL_MS = 250;
const UPLOAD_END_GRACE_SECONDS = 10;

const HLS_CONFIG = {
    maxLoadingDelay:         10,
    manifestLoadingTimeOut:  8_000,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut:     8_000,
};

// ── State ─────────────────────────────────────────────────────

const DRONE_STATE = {
    status:               'idle',   // idle|connecting|buffering|active|reconnecting|failed|ending
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
    scanFirebaseListener: null,
    videoMode:            false,    // true when playing an uploaded MP4 (not live HLS)
    videoBlobUrl:         null,     // object URL for the uploaded file
    videoEnded:           false,    // true when browser video element has finished playing
    backendCompleted:     false,    // results loaded, or processing done and fetch retries exhausted
    videoFinishedShown:   false,
    uploadStartupTimer:   null,
    manifestLoading:      false,
    manifestRetryTimer:   null,
    manifestAttempts:     0,
    uploadVideoSettings:  null,
    uploadFramesTimer:    null,
    uploadFramesAbort:    null,
    uploadFramesCursor:   0,
    uploadResultThrough:  -1,
    uploadDuration:       null,
    uploadFrameStep:      0.25,
    uploadEndTimer:       null,
    countingStarting:     false,    // prevents duplicate live start requests
    stats: { total: 0, bearing: 0, nonBearing: 0, discolored: 0, progress: 0 },
};

const STATUS_LABELS = {
    idle:         'No Signal',
    connecting:   'Connecting...',
    buffering:    'Buffering...',
    active:       'Live',
    reconnecting: 'Reconnecting...',
    failed:       'Connection Failed',
    ending:       'Ending Scan...',
};

// ── Bounding-box Overlay ──────────────────────────────────────
//
// Renders per-frame detection boxes on top of the MP4 video.
//
// loadManifest() loads frames when completion results become available.
// A requestAnimationFrame loop looks up the latest non-future frame for
// video.currentTime, subject to a short staleness limit.
//
// Coordinate mapping: bboxes arrive normalized (0–1) relative to the
// inference frame (isotropically scaled from the original video), so
// normalized coords are identical to those of the original frame.
// getVideoPaintRect() accounts for object-fit:cover.

const BboxOverlay = (() => {
    const COLORS = {
        bearing:     '#22c55e',
        non_bearing: '#f59e0b',
        non_viable:  '#eab308',
    };
    const SHORT = { bearing: 'B', non_bearing: 'NB', non_viable: 'NV' };

    let frameTimes = [];        // sorted number[] — timestamps of stored frames
    let frameCache = new Map(); // time → detection[]
    let liveDetections = [];    // newest live detector frame; no timestamp lookup
    let renderMode = 'manifest';
    let maxFrameAge = 0.25;
    let rafId      = null;
    let videoFrameId = null;
    let active     = false;
    let canvas     = null;
    let ctx        = null;

    function init() {
        canvas = document.getElementById('dv-bbox-canvas');
        if (canvas) ctx = canvas.getContext('2d');
    }

    function start(mode = 'manifest') {
        if (!canvas) init();
        if (!canvas || !ctx) return;
        renderMode = mode === 'live' ? 'live' : 'manifest';
        if (active) return;
        active = true;
        canvas.classList.add('dv-bbox-active');
        _scheduleRaf();
    }

    function stop() {
        active = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        if (videoFrameId !== null) {
            document.getElementById('drone-feed')?.cancelVideoFrameCallback(videoFrameId);
            videoFrameId = null;
        }
        if (canvas) {
            canvas.classList.remove('dv-bbox-active');
            if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        frameTimes = [];
        frameCache.clear();
        liveDetections = [];
        maxFrameAge = 0.25;
    }

    // Load the full detection manifest — called once when analysis completes.
    function loadManifest(frames) {
        renderMode = 'manifest';
        liveDetections = [];
        frameTimes = [];
        frameCache.clear();
        ingestFrames(frames);
        console.log(`📦 Manifest loaded: ${frameTimes.length} detection frames`);
    }

    // Incremental upload frames are cached by media time, never arrival time.
    function ingestFrames(frames) {
        if (!Array.isArray(frames)) return;
        for (const f of frames) {
            const t = Number(f.t);
            if (!Number.isFinite(t) || t < 0) continue;
            if (!frameCache.has(t)) {
                frameTimes.splice(_upperBound(frameTimes, t), 0, t);
            }
            frameCache.set(t, Array.isArray(f.d) ? f.d : []);
        }
    }

    function setFrameStep(step) {
        if (Number.isFinite(step) && step > 0) {
            maxFrameAge = Math.min(0.25, step + 0.001);
        }
    }

    // Live HLS frames have no stable, seekable timestamp. Replace the prior
    // frame with the newest Firestore payload and draw it on the next RAF tick.
    function setLiveDetections(detections) {
        liveDetections = Array.isArray(detections) ? detections : [];
    }

    function _scheduleRaf() {
        if (!active) return;
        const videoEl = document.getElementById('drone-feed');
        if (renderMode === 'manifest' && videoEl?.requestVideoFrameCallback) {
            videoFrameId = videoEl.requestVideoFrameCallback(_tick);
            return;
        }
        rafId = requestAnimationFrame(_tick);
    }

    function _tick(_now, videoFrame) {
        if (!active) return;

        const wrapper = document.getElementById('drone-feed-wrapper');
        const videoEl = document.getElementById('drone-feed');
        if (!wrapper || !videoEl) { _scheduleRaf(); return; }

        const cw = wrapper.clientWidth, ch = wrapper.clientHeight;
        if (cw > 0 && ch > 0 && (canvas.width !== cw || canvas.height !== ch)) {
            canvas.width  = cw;
            canvas.height = ch;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (videoEl.readyState >= 1 && videoEl.videoWidth) {
            const dets = renderMode === 'live'
                ? liveDetections
                : _findDetections(videoFrame?.mediaTime ?? videoEl.currentTime);
            if (dets && dets.length > 0) {
                const pr = _getVideoPaintRect(videoEl);
                if (pr) _drawDetections(dets, pr);
            }
        }

        _scheduleRaf();
    }

    // Upload-only lookup: never draw a future frame or bridge a missing
    // result for more than 0.25 s. Empty detection frames also clear boxes.
    function _findDetections(timeSec) {
        if (!frameTimes.length) return null;
        let idx = _upperBound(frameTimes, timeSec) - 1;
        if (idx < 0) return null;
        if (timeSec - frameTimes[idx] > maxFrameAge) return null;
        return frameCache.get(frameTimes[idx]) || null;
    }

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

            ctx.globalAlpha = 0.10;
            ctx.fillStyle   = color;
            ctx.fillRect(px, py, pw, ph);
            ctx.globalAlpha = 1;

            ctx.strokeStyle = color;
            ctx.lineWidth   = 1.5;
            ctx.strokeRect(px, py, pw, ph);

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

    function _upperBound(arr, val) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] <= val) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    return { init, start, stop, loadManifest, ingestFrames, setFrameStep, setLiveDetections };
})();

// ── UI Rendering ──────────────────────────────────────────────

function renderUI() {
    const s = DRONE_STATE.status;

    const indicator = document.getElementById('dv-status-indicator');
    indicator.className = `dv-status-${s} d-flex align-items-center gap-2 me-3`;
    document.querySelector('.dv-status-label').textContent = STATUS_LABELS[s] ?? s;

    const isLive      = s === 'active';
    const isLoading   = s === 'connecting' || s === 'reconnecting' || s === 'buffering';
    const isInactive  = s === 'idle' || s === 'failed';
    const isSession   = s === 'active' || s === 'reconnecting' || s === 'buffering';
    const isMp4Buffering = DRONE_STATE.videoMode === true && s === 'buffering';
    const uploadStatus = document.getElementById('dv-upload-status');
    if (uploadStatus) uploadStatus.classList.toggle('d-none', !DRONE_STATE.videoMode || !isSession);
    const statProgressRow = document.getElementById('stat-progress-row');
    if (statProgressRow) {
        statProgressRow.classList.toggle('d-none', !DRONE_STATE.videoMode);
    }
    const canStartLiveCounting =
        !DRONE_STATE.videoMode &&
        s === 'active' &&
        !DRONE_STATE.scanId &&
        !DRONE_STATE.countingStarting;

    document.querySelector('.dv-placeholder-title').textContent =
        s === 'failed' ? 'Connection Failed' : 'Awaiting Connection';
    document.querySelector('.dv-placeholder-hint').textContent =
        s === 'failed'
            ? 'Stream could not be established. Check setup and try again.'
            : 'Click "Connect Drone" or "Upload MP4" to begin a scan session';

    const connLabel = document.querySelector('.dv-connecting-label');
    if (connLabel && !isMp4Buffering) connLabel.textContent = s === 'reconnecting' ? 'Reconnecting...' : 'Connecting...';

    toggleEl('btn-connect',        isInactive);
    toggleEl('btn-upload-video',   isInactive);
    toggleEl('btn-start-counting', canStartLiveCounting);
    toggleEl('btn-end-scan',       isSession);

    toggleClass('drone-feed',         'dv-feed-active', isLive);
    toggleEl('dv-placeholder',        isInactive);
    toggleEl('dv-connecting-overlay', isLoading);
    toggleEl('dv-live-overlay',       isLive);

    toggleEl('dv-timer', isSession);

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

async function apiStartDetection(hlsUrl, blockId, userId, fps = 2) {
    const resp = await fetch(`${API_BASE}/api/drone/start-detection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hls_url: hlsUrl, block_id: blockId, user_id: userId, fps }),
        signal: AbortSignal.timeout(10_000)
    });
    return parseApiResponse(resp);
}

async function apiStopDetection(blockId, scanId, userId) {
    const resp = await fetch(`${API_BASE}/api/drone/stop-detection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ block_id: blockId, scan_id: scanId, user_id: userId }),
        signal: AbortSignal.timeout(10_000)
    });
    return parseApiResponse(resp);
}

// Reads a fetch Response's JSON body regardless of HTTP status. The backend
// always returns a structured {ok, error, message} JSON body for both
// success and failure (400/409/500/...) — see routes.py — so callers can
// rely on `result.ok` / `result.message` without inspecting resp.status
// themselves. This only falls back to a synthesized error object when the
// body itself isn't valid JSON (e.g. a raw proxy/Flask error page), which
// previously would throw out of resp.json() and get flattened into a
// generic "Failed to start/stop detection" toast with no real detail.
async function parseApiResponse(resp) {
    try {
        return await resp.json();
    } catch {
        return {
            ok: false,
            error: 'invalid_response',
            message: `Unexpected server response (HTTP ${resp.status}).`,
        };
    }
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
        // Counting may already be active when the HLS player reconnects.
        if (DRONE_STATE.scanId) BboxOverlay.start('live');
        DRONE_STATE.reconnectAttempts = 0;
        transitionTo('active');
        utils.showToast('Stream reconnected', 'success');
        return;
    }

    setConnectButtonLoading(false);
    lockConnectModal(false);
    closeBsModal('modal-connect');

    DRONE_STATE.scanStartTime = new Date();
    DRONE_STATE.countingStarting = false;
    startScanTimer();
    startStatusPolling();

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

// ── Detection Start/Stop (Live Drone) ─────────────────────────

async function startDetection() {
    if (!DRONE_STATE.streamUrl || !DRONE_STATE.blockId || !DRONE_STATE.userId) {
        utils.showToast('Cannot start detection: missing block or user context.', 'error');
        return false;
    }

    try {
        const result = await apiStartDetection(
            DRONE_STATE.streamUrl,
            DRONE_STATE.blockId,
            DRONE_STATE.userId,
            2
        );

        if (result.ok) {
            console.log('✅ Detection started:', result.scan_id);
            DRONE_STATE.scanId = result.scan_id;
            startFirebaseListener();
            BboxOverlay.start('live');
            startLiveCountdown();
            return true;
        } else {
            console.error('❌ Failed to start detection:', result.message);
            utils.showToast('Failed to start detection: ' + result.message, 'error');
            return false;
        }
    } catch (error) {
        console.error('❌ Detection start error:', error);
        utils.showToast('Failed to start detection', 'error');
        return false;
    }
}

// Informational countdown only: detection has already started before this runs.
let liveCountdownTimer = null;

function startLiveCountdown() {
    const notice = document.getElementById('dv-countdown-notice');
    const message = document.getElementById('dv-countdown-message');
    if (!notice || !message) return;

    if (liveCountdownTimer !== null) {
        clearInterval(liveCountdownTimer);
        liveCountdownTimer = null;
    }

    let seconds = 7;
    message.textContent = `Please wait ${seconds}s before moving the drone...`;
    notice.classList.remove('d-none');
    notice.hidden = false;

    liveCountdownTimer = setInterval(() => {
        seconds -= 1;
        if (seconds <= 0) {
            clearInterval(liveCountdownTimer);
            liveCountdownTimer = null;
            notice.classList.add('d-none');
            notice.hidden = true;
            return;
        }
        message.textContent = `Please wait ${seconds}s before moving the drone...`;
    }, 1000);
}

async function handleStartCounting() {
    if (
        DRONE_STATE.videoMode ||
        DRONE_STATE.status !== 'active' ||
        DRONE_STATE.scanId ||
        DRONE_STATE.countingStarting
    ) return;

    DRONE_STATE.countingStarting = true;
    renderUI();

    try {
        await startDetection();
    } finally {
        DRONE_STATE.countingStarting = false;
        renderUI();
    }
}

async function stopDetection() {
    if (!DRONE_STATE.scanId || !DRONE_STATE.blockId) {
        console.error('❌ No active scan to stop');
        return false;
    }

    try {
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
//
// Upload processing and timestamped result polling start before the countdown.
// Live detections are never used for MP4, and polling never pauses playback.

async function apiUploadVideo(formData) {
    const resp = await fetch(`${API_BASE}/api/drone/upload-video`, {
        method: 'POST',
        body:   formData,
        signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
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

function logVideoUploadActivity(blockId, scanId, fileName) {
    try {
        const session = typeof auth !== 'undefined' &&
            (auth.getCurrentUser() || auth.getSession());
        if (!session) return;

        firebase.firestore().collection('activity_logs').add({
            userId: session.uid,
            user: session.username || session.name || session.email || session.uid,
            role: session.role,
            email: session.email,
            // Action Breakdown currently counts Upload with an exact match.
            action: 'upload',
            status: 'success',
            ip: '—',
            device: navigator.userAgent || 'Unknown',
            details: `Uploaded MP4 scan for block ${blockId}`,
            block_id: blockId,
            scan_id: scanId || null,
            file_name: fileName,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        }).catch(error => {
            console.error('Failed to log video upload activity:', error);
        });
    } catch (error) {
        console.error('Failed to log video upload activity:', error);
    }
}

function handleVideoUploadClick() {
    if (DRONE_STATE.status !== 'idle' && DRONE_STATE.status !== 'failed') return;
    document.getElementById('input-video-file').click();
}

async function handleFileSelect(event) {
    const file = event.target.files[0];
    event.target.value = '';

    if (!file) return;

    if (!file.type.includes('mp4') && !file.name.toLowerCase().endsWith('.mp4')) {
        utils.showToast('Only MP4 files are supported', 'error');
        return;
    }

    if (!DRONE_STATE.blockId || !DRONE_STATE.userId) {
        utils.showToast('Missing block context. Return to Blocks and try again.', 'error');
        return;
    }

    if (DRONE_STATE.videoBlobUrl) {
        URL.revokeObjectURL(DRONE_STATE.videoBlobUrl);
        DRONE_STATE.videoBlobUrl = null;
    }

    // Disable HTML autoplay before loading the upload. Restore HLS settings
    // at cleanup; native controls allow pause, seek and manual play fallback.
    const videoEl = document.getElementById('drone-feed');
    DRONE_STATE.uploadVideoSettings = { autoplay: videoEl.autoplay, controls: videoEl.controls };
    videoEl.autoplay = false;
    videoEl.controls = false;
    videoEl.pause();
    BboxOverlay.stop();
    DRONE_STATE.videoBlobUrl = URL.createObjectURL(file);
    videoEl.src = DRONE_STATE.videoBlobUrl;
    videoEl.load();
    DRONE_STATE.videoMode = true;
    transitionTo('connecting');
    setConnectingLabel('Uploading video...');

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
            msg = 'Upload timed out. The server may be initializing — try again in a moment.';
        } else if (err instanceof TypeError) {
            msg = 'Cannot reach backend. Ensure Flask server is running on port 5000.';
        } else {
            msg = err.message || 'Backend error. Check the Flask server terminal for details.';
        }
        handleVideoFailed(msg);
        return;
    }

    if (!result.ok) {
        handleVideoFailed(result.message ?? 'Upload failed.');
        return;
    }

    logVideoUploadActivity(DRONE_STATE.blockId, result.scan_id, file.name);

    DRONE_STATE.scanId = result.scan_id;
    DRONE_STATE.scanStartTime = new Date();
    DRONE_STATE.videoEnded = false;
    DRONE_STATE.videoFinishedShown = false;
    DRONE_STATE.backendCompleted = false;
    DRONE_STATE.manifestAttempts = 0;
    DRONE_STATE.manifestLoading = false;
    DRONE_STATE.uploadFramesCursor = 0;
    DRONE_STATE.uploadResultThrough = -1;
    DRONE_STATE.uploadDuration = null;
    DRONE_STATE.uploadFrameStep = 0.25;
    transitionTo('buffering');
    setUploadStatus('Buffering timestamped detection results...');
    startUploadResultPolling();
    startUploadCountdown();
    startFirebaseListener();
    startScanCompletionListener();
    startScanTimer();
    utils.showToast('Video uploaded — processing in background', 'success');
}

function setUploadStatus(message) {
    const el = document.getElementById('dv-upload-status');
    if (el) el.textContent = message;
}

function stopUploadResultPolling() {
    clearTimeout(DRONE_STATE.uploadFramesTimer);
    DRONE_STATE.uploadFramesTimer = null;
    if (DRONE_STATE.uploadFramesAbort) DRONE_STATE.uploadFramesAbort.abort();
    DRONE_STATE.uploadFramesAbort = null;
}

// One request at a time; cursor reads preserve every available sampled frame.
function startUploadResultPolling() {
    stopUploadResultPolling();
    const scanId = DRONE_STATE.scanId;
    const isCurrent = () => DRONE_STATE.videoMode && DRONE_STATE.scanId === scanId &&
        ['buffering', 'active'].includes(DRONE_STATE.status) && !DRONE_STATE.backendCompleted;
    const poll = async () => {
        if (!isCurrent()) return;
        const controller = new AbortController();
        DRONE_STATE.uploadFramesAbort = controller;
        const timeout = setTimeout(() => controller.abort(), 5000);
        let nextDelay = UPLOAD_RESULT_POLL_MS;
        try {
            const resp = await fetch(API_BASE + '/api/drone/scan/' + scanId +
                '/frames?cursor=' + DRONE_STATE.uploadFramesCursor,
                { signal: controller.signal, cache: 'no-store' });
            if (!isCurrent()) return;
            if (resp.status === 404) return; // worker has not published metadata yet
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            if (!isCurrent()) return;
            if (data.scan_id !== scanId || !Array.isArray(data.frames) ||
                !Number.isSafeInteger(data.cursor) || data.cursor < DRONE_STATE.uploadFramesCursor) {
                throw new Error('Invalid upload detection response');
            }
            BboxOverlay.ingestFrames(data.frames);
            DRONE_STATE.uploadFramesCursor = data.cursor;
            if (Number.isFinite(data.duration) && data.duration >= 0) {
                DRONE_STATE.uploadDuration = data.duration;
            }
            if (data.video_fps > 0 && data.frame_stride > 0) {
                DRONE_STATE.uploadFrameStep = data.frame_stride / data.video_fps;
                BboxOverlay.setFrameStep(DRONE_STATE.uploadFrameStep);
            }
            for (const frame of data.frames) {
                if (Number.isFinite(frame.t)) {
                    DRONE_STATE.uploadResultThrough = Math.max(DRONE_STATE.uploadResultThrough, frame.t);
                }
            }
            if (DRONE_STATE.status === 'active' && !DRONE_STATE.videoEnded) {
                const time = document.getElementById('drone-feed').currentTime;
                setUploadStatus(DRONE_STATE.uploadResultThrough + DRONE_STATE.uploadFrameStep < time
                    ? 'Detection is behind playback — unavailable boxes are hidden.'
                    : 'Detection boxes follow video playback time.');
            }
            if (data.has_more) nextDelay = 0;
        } catch (err) {
            if (isCurrent()) {
                console.warn('Upload detection polling:', err);
                setUploadStatus('Waiting for detection results — unavailable boxes are hidden.');
            }
        } finally {
            clearTimeout(timeout);
            if (DRONE_STATE.uploadFramesAbort === controller) DRONE_STATE.uploadFramesAbort = null;
            if (isCurrent()) DRONE_STATE.uploadFramesTimer = setTimeout(poll, nextDelay);
        }
    };
    poll();
}

function startUploadCountdown() {
    const scanId = DRONE_STATE.scanId;
    const delay = Number.isFinite(UPLOAD_STARTUP_DELAY_SECONDS)
        ? Math.max(0, UPLOAD_STARTUP_DELAY_SECONDS) : 7;
    const deadline = performance.now() + delay * 1000;
    const tick = () => {
        if (!DRONE_STATE.videoMode || DRONE_STATE.scanId !== scanId ||
            DRONE_STATE.status !== 'buffering') {
            clearInterval(DRONE_STATE.uploadStartupTimer);
            DRONE_STATE.uploadStartupTimer = null;
            return;
        }
        const remaining = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
        setConnectingLabel('Playback starts in ' + remaining + 's — processing in background');
        // Wait only at startup for an initial lead. Short clips can use the
        // completed manifest; long clips do not wait for full-video analysis.
        const target = DRONE_STATE.uploadDuration === null ? delay :
            Math.min(delay, Math.max(0, DRONE_STATE.uploadDuration - DRONE_STATE.uploadFrameStep));
        const ready = DRONE_STATE.backendCompleted || DRONE_STATE.uploadResultThrough >= target;
        if (remaining === 0 && !ready) {
            setConnectingLabel('Buffering detection results... ' +
                Math.max(0, DRONE_STATE.uploadResultThrough).toFixed(1) + '/' + target.toFixed(1) + 's');
        }
        if (remaining === 0 && ready) {
            clearInterval(DRONE_STATE.uploadStartupTimer);
            DRONE_STATE.uploadStartupTimer = null;
            startVideoPlayback();
        }
    };
    DRONE_STATE.uploadStartupTimer = setInterval(tick, 200);
    tick();
}

function cleanupUploadedPlayback() {
    stopUploadResultPolling();
    clearTimeout(DRONE_STATE.uploadEndTimer);
    DRONE_STATE.uploadEndTimer = null;
    clearInterval(DRONE_STATE.uploadStartupTimer);
    clearTimeout(DRONE_STATE.manifestRetryTimer);
    DRONE_STATE.uploadStartupTimer = null;
    DRONE_STATE.manifestRetryTimer = null;
    DRONE_STATE.manifestLoading = false;
    const videoEl = document.getElementById('drone-feed');
    videoEl.pause();
    videoEl.removeEventListener('ended', handleVideoEnd);
}

// Restore autoplay only after the uploaded source has been removed.
function restoreUploadedVideoSettings() {
    const videoEl = document.getElementById('drone-feed');
    if (DRONE_STATE.uploadVideoSettings) {
        videoEl.autoplay = DRONE_STATE.uploadVideoSettings.autoplay;
        videoEl.controls = DRONE_STATE.uploadVideoSettings.controls;
        DRONE_STATE.uploadVideoSettings = null;
    }
}

function handleVideoFailed(message) {
    cleanupUploadedPlayback();
    stopScanIntervals();
    BboxOverlay.stop();
    DRONE_STATE.videoMode        = false;
    DRONE_STATE.backendCompleted = false;

    const videoEl = document.getElementById('drone-feed');
    videoEl.playbackRate = 1.0;
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    restoreUploadedVideoSettings();

    if (DRONE_STATE.videoBlobUrl) {
        URL.revokeObjectURL(DRONE_STATE.videoBlobUrl);
        DRONE_STATE.videoBlobUrl = null;
    }

    stopFirebaseListener();

    transitionTo('failed');
    document.querySelector('.dv-placeholder-hint').textContent = message;
    utils.showToast(message, 'error');
}

// Upload background progress remains visible in the statistics panel.
function updateAnalysisProgress(pct) {
    if (!DRONE_STATE.videoMode || DRONE_STATE.backendCompleted) return;
    DRONE_STATE.stats.progress = Math.max(0, Math.min(100, pct));
    updateStatDisplay();
}

// Manifest arrival never restarts playback or changes currentTime.
async function loadUploadManifest(scanData) {
    if (DRONE_STATE.manifestLoading || DRONE_STATE.backendCompleted) return;
    const scanId = DRONE_STATE.scanId;
    const isCurrent = () => DRONE_STATE.videoMode && DRONE_STATE.scanId === scanId &&
        ['buffering', 'active'].includes(DRONE_STATE.status);
    if (!isCurrent()) return;
    DRONE_STATE.manifestLoading = true;
    DRONE_STATE.manifestAttempts++;
    let manifest;
    try {
        const resp = await fetch(API_BASE + '/api/drone/scan/' + scanId + '/manifest',
            { signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        manifest = await resp.json();
        if (manifest.scan_id !== scanId || !Array.isArray(manifest.frames)) {
            throw new Error('Invalid detection manifest');
        }
    } catch (err) {
        if (!isCurrent()) return;
        DRONE_STATE.manifestLoading = false;
        console.error('Failed to fetch manifest:', err);
        if (DRONE_STATE.manifestAttempts < 3) {
            setUploadStatus('Final detection results unavailable — retrying; buffered boxes remain synchronized.');
            DRONE_STATE.manifestRetryTimer = setTimeout(() => {
                DRONE_STATE.manifestRetryTimer = null;
                if (isCurrent()) loadUploadManifest(scanData);
            }, 2000);
        } else {
            setUploadStatus('Final detection results could not be loaded — showing available buffered boxes.');
            DRONE_STATE.backendCompleted = true;
            stopUploadResultPolling();
            checkVideoScanComplete();
        }
        return;
    }
    if (!isCurrent()) return;
    DRONE_STATE.manifestLoading = false;
    clearTimeout(DRONE_STATE.manifestRetryTimer);
    DRONE_STATE.manifestRetryTimer = null;
    BboxOverlay.loadManifest(manifest.frames);
    if (manifest.video_fps > 0 && manifest.frame_stride > 0) {
        BboxOverlay.setFrameStep(manifest.frame_stride / manifest.video_fps);
    }
    DRONE_STATE.stats.total = scanData.total || 0;
    DRONE_STATE.stats.bearing = scanData.bearingPercent || 0;
    DRONE_STATE.stats.nonBearing = scanData.nonBearingPercent || 0;
    DRONE_STATE.stats.discolored = scanData.nonViablePercent || 0;
    DRONE_STATE.stats.progress = 100;
    DRONE_STATE.backendCompleted = true;
    stopUploadResultPolling();
    updateStatDisplay();
    setUploadStatus(manifest.frames.length
        ? 'Detection results ready — boxes follow playback time.'
        : 'Processing complete — no detection frames available.');
    checkVideoScanComplete();
}

// Start normal 1× video playback with bbox overlay active.
// Called only after the upload countdown and initial result buffer are ready.
function startVideoPlayback() {
    const videoEl = document.getElementById('drone-feed');

    // Guarantee 1× speed — never change this based on detector speed
    videoEl.playbackRate = 1.0;

    // Start the requestAnimationFrame bbox render loop
    BboxOverlay.start();

    // Transition to active (shows video, hides connecting overlay)
    transitionTo('active');

    document.getElementById('dv-stream-quality').textContent = 'MP4';
    document.querySelector('.dv-live-badge').innerHTML =
        '<span class="dv-live-dot" aria-hidden="true"></span> MP4';

    videoEl.controls = true;
    videoEl.removeEventListener('ended', handleVideoEnd);
    videoEl.addEventListener('ended', handleVideoEnd);
    const scanId = DRONE_STATE.scanId;
    videoEl.play().catch(() => {
        if (DRONE_STATE.videoMode && DRONE_STATE.scanId === scanId && DRONE_STATE.status === 'active') {
            utils.showToast('Press Play in the video controls to begin playback.', 'info');
        }
    });

    updateStatDisplay();
    utils.showToast('Playing uploaded video', 'success');
}

function handleVideoEnd() {
    if (DRONE_STATE.status !== 'active' || !DRONE_STATE.videoMode) return;
    DRONE_STATE.videoEnded = true;
    if (!DRONE_STATE.backendCompleted) {
        setUploadStatus('Playback ended — finishing scan results (up to ' + UPLOAD_END_GRACE_SECONDS + 's)...');
        clearTimeout(DRONE_STATE.uploadEndTimer);
        const scanId = DRONE_STATE.scanId;
        DRONE_STATE.uploadEndTimer = setTimeout(() => {
            DRONE_STATE.uploadEndTimer = null;
            if (DRONE_STATE.videoMode && DRONE_STATE.scanId === scanId &&
                DRONE_STATE.status === 'active' && !DRONE_STATE.backendCompleted &&
                document.getElementById('drone-feed').ended) {
                setUploadStatus('Processing is taking longer than expected — final results are still pending.');
            }
        }, UPLOAD_END_GRACE_SECONDS * 1000);
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
    cleanupUploadedPlayback();
    closeBsModal('modal-scan-finished');
    BboxOverlay.stop();
    stopFirebaseListener();

    const videoEl = document.getElementById('drone-feed');
    videoEl.playbackRate = 1.0;
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    restoreUploadedVideoSettings();

    if (DRONE_STATE.videoBlobUrl) {
        URL.revokeObjectURL(DRONE_STATE.videoBlobUrl);
        DRONE_STATE.videoBlobUrl = null;
    }

    DRONE_STATE.videoMode        = false;
    DRONE_STATE.videoEnded       = false;
    DRONE_STATE.backendCompleted = false;
    DRONE_STATE.scanId           = null;
    DRONE_STATE.scanStartTime    = null;
    DRONE_STATE.stats            = { total: 0, bearing: 0, nonBearing: 0, discolored: 0, progress: 0 };

    transitionTo('idle');

    if (DRONE_STATE.blockId) {
        setTimeout(() => {
            window.location.href = 'blocks-view.html?id=' + DRONE_STATE.blockId;
        }, 600);
    }
}

// ── Firebase Real-time Listener ──────────────────────────────

function startFirebaseListener() {
    if (!DRONE_STATE.blockId || typeof firebase === 'undefined') {
        console.error('❌ Firebase not available or no block ID');
        return;
    }

    DRONE_STATE.firebaseListener = firebase.firestore()
        .collection('blocks')
        .doc(DRONE_STATE.blockId)
        .onSnapshot((doc) => {
            if (!doc.exists) return;

            const data = doc.data();
            updateStatsFromFirebase(data);

            // The block document is shared across scan sessions. Ignore
            // upload mode and data written by a previous live scan.
            const liveFrame = data.liveDetections;
            if (
                !DRONE_STATE.videoMode &&
                liveFrame &&
                liveFrame.scanId === DRONE_STATE.scanId
            ) {
                BboxOverlay.setLiveDetections(liveFrame.d);
            }
        }, (error) => {
            console.error('❌ Firebase listener error:', error);
        });
}

function stopFirebaseListener() {
    if (DRONE_STATE.firebaseListener) {
        DRONE_STATE.firebaseListener();
        DRONE_STATE.firebaseListener = null;
    }
    if (DRONE_STATE.scanFirebaseListener) {
        DRONE_STATE.scanFirebaseListener();
        DRONE_STATE.scanFirebaseListener = null;
    }
}

// Listens to the scan document for:
//  - scanProgress / processedFrames / totalFrames → progress bar updates
//  - manifestReady: true → fetch manifest without changing playback
//  - status: 'failed' → show error
//  - status: 'completed' → update final stats display
//
// This listener does NOT control video.playbackRate in any way.
function startScanCompletionListener() {
    if (!DRONE_STATE.scanId || typeof firebase === 'undefined') return;

    const scanId = DRONE_STATE.scanId;
    console.log('🔥 Watching scan:', scanId);

    DRONE_STATE.scanFirebaseListener = firebase.firestore()
        .collection('scans')
        .doc(scanId)
        .onSnapshot((doc) => {
            if (!doc.exists || !DRONE_STATE.videoMode || DRONE_STATE.scanId !== scanId ||
                !['buffering', 'active'].includes(DRONE_STATE.status)) return;
            const data = doc.data();

            // Only an uploaded MP4 uses the scan-document analysis progress.
            if (
                DRONE_STATE.videoMode === true &&
                typeof data.scanProgress === 'number'
            ) {
                updateAnalysisProgress(data.scanProgress);
            }

            // Failed scan — backend worker crashed or was aborted
            if (data.status === 'failed') {
                handleVideoFailed(data.error || 'Analysis failed on the server. Check server logs.');
                return;
            }

            // Keep final statistics even if fetching overlay results fails.
            if (data.status === 'completed') {
                DRONE_STATE.stats.total      = data.total || 0;
                DRONE_STATE.stats.bearing    = data.bearingPercent    || 0;
                DRONE_STATE.stats.nonBearing = data.nonBearingPercent || 0;
                DRONE_STATE.stats.discolored = data.nonViablePercent  || 0;
                DRONE_STATE.stats.progress = 100;
                updateStatDisplay();
                checkVideoScanComplete();
            }

            // Upload results may arrive before or after playback starts.
            if (data.manifestReady && !DRONE_STATE.backendCompleted) {
                if (!DRONE_STATE.manifestRetryTimer) loadUploadManifest(data);
            }
        }, (error) => {
            console.error('❌ Scan listener error:', error);
            if (DRONE_STATE.videoMode && DRONE_STATE.scanId === scanId &&
                ['buffering', 'active'].includes(DRONE_STATE.status)) {
                setUploadStatus('Processing status unavailable — boxes hidden until results arrive.');
            }
        });
}

function checkVideoScanComplete() {
    if (DRONE_STATE.status !== 'active' || !DRONE_STATE.videoMode) return;
    // Wait for playback and background results (or exhausted fetch retries).
    if (!DRONE_STATE.backendCompleted) return;
    if (!DRONE_STATE.videoEnded || !document.getElementById('drone-feed').ended) return;
    if (DRONE_STATE.videoFinishedShown) return;
    DRONE_STATE.videoFinishedShown = true;
    clearTimeout(DRONE_STATE.uploadEndTimer);
    DRONE_STATE.uploadEndTimer = null;

    stopScanIntervals();
    showScanFinishedModal();
}

function updateStatsFromFirebase(data) {
    DRONE_STATE.stats.bearing    = data.bearingPercent    || 0;
    DRONE_STATE.stats.nonBearing = data.nonBearingPercent || 0;
    DRONE_STATE.stats.discolored = data.nonViable         || 0;
    DRONE_STATE.stats.total      = data.totalPineapples   || 0;

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
                loadHlsStream(DRONE_STATE.streamUrl, true);
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
        cleanupUploadedPlayback();
    }

    // For live drone: signals the backend to stop.
    // For video mode: signals backend to abort the analysis worker.
    const scanFinalizedOk = await stopDetection();

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
    if (DRONE_STATE.uploadVideoSettings) restoreUploadedVideoSettings();

    DRONE_STATE.stats             = { total: 0, bearing: 0, nonBearing: 0, discolored: 0, progress: 0 };
    DRONE_STATE.scanStartTime     = null;
    DRONE_STATE.streamUrl         = null;
    DRONE_STATE.rtmpUrl           = null;
    DRONE_STATE.streamPath        = null;
    DRONE_STATE.reconnectAttempts = 0;
    DRONE_STATE.scanId            = null;
    DRONE_STATE.countingStarting  = false;
    DRONE_STATE.videoEnded        = false;
    DRONE_STATE.backendCompleted  = false;

    setEndScanButtonLoading(false);
    closeBsModal('modal-end-scan');
    transitionTo('idle');
    if (scanFinalizedOk) {
        utils.showToast('Scan session ended', 'info');
    } else {
        utils.showToast('Scan ended, but the final save may not have completed. Check Scans history to confirm.', 'error');
    }

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
    clearInterval(DRONE_STATE.statsInterval);
    DRONE_STATE.statsInterval = null;
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
    document.getElementById('btn-start-counting')
        .addEventListener('click', handleStartCounting);
    document.getElementById('input-rtmp-url')
        .addEventListener('keydown', e => { if (e.key === 'Enter') handleConnect(); });
    document.getElementById('input-rtmp-url')
        .addEventListener('input', () => clearInputError('input-rtmp-url'));

    const endScanModalEl = document.getElementById('modal-end-scan');
    endScanModalEl.addEventListener('show.bs.modal', () => {
        const s = DRONE_STATE.status;
        if (s === 'active' || s === 'reconnecting' || s === 'buffering') onEndScanModalShow();
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

    const urlParams = new URLSearchParams(window.location.search);
    DRONE_STATE.blockId = urlParams.get('blockId');

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

    document.getElementById('btn-upload-video')
        .addEventListener('click', handleVideoUploadClick);
    document.getElementById('input-video-file')
        .addEventListener('change', handleFileSelect);

    renderUI();
}
