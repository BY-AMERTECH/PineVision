"""
Real-time pineapple detection with YOLO + DeepSORT tracking.
Prevents duplicate counting and updates Firebase in real-time.
"""

import torch
import cv2
import numpy as np
from deep_sort_realtime.deepsort_tracker import DeepSort
import time
import threading
from typing import Dict, Set, Optional
from pathlib import Path

from .stream_capture import HLSStreamCapture
from .firebase_client import (
    get_firestore_client,
    get_block_population,
    update_detection_batch,
    create_scan_session,
    complete_scan_session,
)


def _compute_population_estimates(
    bearing: int,
    non_bearing: int,
    registered_population: int,
) -> tuple:
    """
    Extrapolate detected counts to full plantation size.

    Returns (estimated_bearing, estimated_non_bearing, detection_coverage).
    detection_coverage is a percentage (0–100+) of how much of the registered
    population was actually observed during the scan.
    """
    detected_total = bearing + non_bearing

    if detected_total > 0 and registered_population > 0:
        bearing_ratio      = bearing      / detected_total
        non_bearing_ratio  = non_bearing  / detected_total
        estimated_bearing     = round(registered_population * bearing_ratio)
        estimated_non_bearing = round(registered_population * non_bearing_ratio)
    else:
        estimated_bearing     = 0
        estimated_non_bearing = 0

    detection_coverage = (
        (detected_total / registered_population * 100)
        if registered_population > 0
        else 0.0
    )

    return estimated_bearing, estimated_non_bearing, detection_coverage


def check_thresholds_and_create_alerts(
    block_id: str,
    bearing_percent: float,
    non_bearing_percent: float,
    non_viable_percent: float,
    user_id: str = '',
):
    """
    Check detection percentages against thresholds and create or
    auto-resolve monitoring_alerts documents accordingly.

    OPTIMIZED: Uses a single Firestore query to fetch all open alerts
    for this block, then processes everything in-memory, and commits
    all creates + resolves in a single batch write.

    Previous implementation: 6 sequential compound queries (one per
    threshold × check/resolve) — each requiring a network round-trip.
    Current implementation: 1 query + 1 batch commit regardless of
    how many alerts need to change.

    Requires a Firestore composite index on monitoring_alerts:
      blockId  ASC
      resolved ASC
    (Create once in Firebase Console → Firestore → Indexes → Composite)
    """
    from firebase_admin import firestore as _fs

    db = get_firestore_client()

    thresholds = {
        'bearing':    {'watch': 75,  'critical': 60},
        'nonbearing': {'watch': 18,  'critical': 25},
        'nonViable':  {'watch': 10,  'critical': 15},
    }

    print(f"\n🔍 Checking thresholds for block {block_id}:")
    print(f"   Bearing: {bearing_percent:.1f}%")
    print(f"   Non-bearing: {non_bearing_percent:.1f}%")
    print(f"   Non-viable: {non_viable_percent:.1f}%")

    # ── Single query: all open alerts for this block ─────────────────
    # Replaces 6 separate compound queries (2 per threshold type).
    open_docs = db.collection('monitoring_alerts') \
        .where('blockId', '==', block_id) \
        .where('resolved', '==', False) \
        .get()

    # Build in-memory map: title → document reference (O(1) lookup)
    open_by_title = {doc.data().get('title'): doc.reference for doc in open_docs}

    # ── Determine which alerts SHOULD currently be active ────────────
    desired: list[tuple[str, str, str]] = []  # (severity, title, description)

    if bearing_percent < thresholds['bearing']['critical']:
        desired.append(('crit', 'Critical bearing rate',
            f'Bearing rate at {bearing_percent:.1f}% — below critical threshold of '
            f'{thresholds["bearing"]["critical"]}%'))
    elif bearing_percent < thresholds['bearing']['watch']:
        desired.append(('warn', 'Low bearing rate',
            f'Bearing rate at {bearing_percent:.1f}% — below watch threshold of '
            f'{thresholds["bearing"]["watch"]}%'))

    if non_bearing_percent > thresholds['nonbearing']['critical']:
        desired.append(('crit', 'Critical non-bearing rate',
            f'Non-bearing rate at {non_bearing_percent:.1f}% — above critical threshold of '
            f'{thresholds["nonbearing"]["critical"]}%'))
    elif non_bearing_percent > thresholds['nonbearing']['watch']:
        desired.append(('warn', 'High non-bearing rate',
            f'Non-bearing rate at {non_bearing_percent:.1f}% — above watch threshold of '
            f'{thresholds["nonbearing"]["watch"]}%'))

    if non_viable_percent > thresholds['nonViable']['critical']:
        desired.append(('crit', 'Critical non-viable rate',
            f'Non-viable rate at {non_viable_percent:.1f}% — above critical threshold of '
            f'{thresholds["nonViable"]["critical"]}%'))
    elif non_viable_percent > thresholds['nonViable']['watch']:
        desired.append(('warn', 'High non-viable rate',
            f'Non-viable rate at {non_viable_percent:.1f}% — above watch threshold of '
            f'{thresholds["nonViable"]["watch"]}%'))

    desired_titles = {title for _, title, _ in desired}

    # ── Build a single batch for all creates + resolves ──────────────
    batch = db.batch()
    ops   = 0

    for severity, title, description in desired:
        if title not in open_by_title:
            new_ref = db.collection('monitoring_alerts').document()
            batch.set(new_ref, {
                'blockId':      block_id,
                'userId':       user_id,
                'severity':     severity,
                'title':        title,
                'description':  description,
                'method':       'Automated Threshold Check',
                'operator':     'System Auto-Flag',
                'resolved':     False,
                'detectedDate': _fs.SERVER_TIMESTAMP,
            })
            ops += 1
            print(f"   🚨 Creating {severity.upper()} alert: {title}")

    for title, ref in open_by_title.items():
        if title not in desired_titles:
            batch.update(ref, {
                'resolved':     True,
                'resolvedDate': _fs.SERVER_TIMESTAMP,
            })
            ops += 1
            print(f"   ✅ Auto-resolving: {title}")

    if ops > 0:
        batch.commit()
        print(f"   📝 Committed {ops} alert operation(s) in one batch")
    else:
        print("   ✓ No alert changes needed")


class PineappleDetector:
    """
    Real-time pineapple detection with duplicate prevention.
    Uses YOLOv5 for detection and DeepSORT for tracking.
    """
    
    def __init__(self, model_path: str, confidence_threshold: float = 0.5):
        """
        Initialize detector with YOLO model.
        
        Args:
            model_path: Path to your best.pt model file
            confidence_threshold: Minimum confidence for detections (0.0-1.0)
        """
        self.model_path = model_path
        self.confidence_threshold = confidence_threshold
        
        # Select compute device — prefer CUDA, fall back to CPU
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        print(f"🔧 Using device: {self.device}")

        # Load YOLO model
        print(f"📦 Loading YOLO model from {model_path}...")
        try:
            # Try using ultralytics YOLO (newer, more stable)
            from ultralytics import YOLO
            self.model = YOLO(model_path)
            self.model.conf = confidence_threshold
            self.model.to(self.device)
            self.use_ultralytics = True
            print(f"✅ YOLO model loaded successfully (using Ultralytics, device={self.device})")
        except Exception as e:
            # Fallback to torch.hub (older method)
            print(f"⚠️ Ultralytics failed ({e}), using torch.hub...")
            self.model = torch.hub.load('ultralytics/yolov5', 'custom', path=model_path, force_reload=True, trust_repo=True)
            self.model.conf = confidence_threshold
            self.model.to(self.device)
            self.use_ultralytics = False
            print(f"✅ YOLO model loaded successfully (using torch.hub, device={self.device})")
        
        # Initialize DeepSORT tracker
        print(f"🔄 Initializing DeepSORT tracker...")
        self.tracker = DeepSort(
            max_age=30,           # Keep track for 30 frames without detection
            n_init=3,             # Confirm track after 3 consecutive detections
            max_iou_distance=0.7  # IoU threshold for matching
        )
        print(f"✅ DeepSORT tracker initialized")
        
        # Track unique pineapple IDs (prevents duplicates!)
        self.unique_ids: Dict[str, Set[int]] = {
            'bearing': set(),
            'non_bearing': set(),
            'non_viable': set()
        }
        
        # Detection statistics
        self.total_frames_processed = 0
        self.detection_active = False
        self.detection_thread = None

        # Time-sync state — retained as stubs for API backwards-compatibility
        self._current_scan_id: Optional[str] = None
        
    def reset_tracking(self):
        """Reset all tracking data for a new scan"""
        self.unique_ids = {
            'bearing': set(),
            'non_bearing': set(),
            'non_viable': set()
        }
        self.total_frames_processed = 0
        # Re-initialize the tracker so Kalman filter state and track-ID counters
        # from a previous scan don't influence the new one.  Without this, the
        # same video produces different unique-ID assignments on every run.
        self.tracker = DeepSort(
            max_age=30,
            n_init=3,
            max_iou_distance=0.7,
        )
        print("🔄 Tracking data reset")

    def push_video_time(self, scan_id: str, video_time: float, is_ended: bool = False):
        """
        No-op stub retained for API backwards-compatibility.

        The time-synced seek-based loop has been replaced with a deterministic
        sequential reader (_video_scan_loop_sequential) that reads frames via
        cap.read() without seeking.  Frontend video timestamps are no longer
        needed and are intentionally ignored here.
        """
        pass  # intentional no-op — sequential scan drives itself
    
    # Maximum dimension (pixels) passed to YOLO and DeepSORT.
    # YOLOv8 is trained at 640×640; processing larger frames wastes compute
    # without improving accuracy. Resizing 1080p → 640px is ~9× fewer pixels.
    _INFERENCE_SIZE = 640

    def detect_frame(self, frame: np.ndarray) -> Dict:
        """
        Run detection on a single frame.

        Args:
            frame: Video frame as numpy array (BGR format)

        Returns:
            Dictionary with detection results and counts
        """
        # Downscale to inference size if the source frame is larger.
        # Both YOLO and DeepSORT receive the same smaller frame so
        # DeepSORT's feature extractor also benefits from the resize.
        h, w = frame.shape[:2]
        max_dim = max(h, w)
        if max_dim > self._INFERENCE_SIZE:
            scale = self._INFERENCE_SIZE / max_dim
            inference_frame = cv2.resize(
                frame,
                (int(w * scale), int(h * scale)),
                interpolation=cv2.INTER_LINEAR,
            )
        else:
            inference_frame = frame

        # Run YOLO detection on the (possibly resized) frame
        results = self.model(inference_frame, verbose=False)

        # Prepare detections for DeepSORT
        detections_list = []

        if self.use_ultralytics:
            # Ultralytics YOLO format
            for result in results:
                boxes = result.boxes
                for box in boxes:
                    # Get bounding box coordinates
                    x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                    bbox = [float(x1), float(y1), float(x2 - x1), float(y2 - y1)]  # [x, y, width, height]
                    
                    # Get confidence and class
                    confidence = float(box.conf[0])
                    class_id = int(box.cls[0])
                    class_name = result.names[class_id]
                    
                    detections_list.append((bbox, confidence, class_name))
        else:
            # torch.hub format (fallback)
            detections_df = results.pandas().xyxy[0]
            for _, row in detections_df.iterrows():
                bbox = [
                    row['xmin'],
                    row['ymin'],
                    row['xmax'] - row['xmin'],  # width
                    row['ymax'] - row['ymin']   # height
                ]
                confidence = row['confidence']
                class_name = row['name']
                
                detections_list.append((bbox, confidence, class_name))
        
        # Update tracks (assigns unique IDs!)
        # Pass inference_frame so DeepSORT's feature extractor runs on the
        # smaller image — same speedup as YOLO.
        tracks = self.tracker.update_tracks(detections_list, frame=inference_frame)
        
        # Count only confirmed unique tracks
        new_detections = 0
        for track in tracks:
            if not track.is_confirmed():
                continue

            track_id = track.track_id
            class_name = track.det_class

            # Normalize class name
            if class_name in ['bearing', 'Bearing']:
                category = 'bearing'
            elif class_name in ['non-bearing', 'non_bearing', 'Non-Bearing', 'nonbearing']:
                category = 'non_bearing'
            elif class_name in ['non-viable', 'non_viable', 'Non-Viable', 'nonviable', 'discolored']:
                category = 'non_viable'
            else:
                print(f"⚠️ Unknown class: {class_name}")
                continue

            # Add to unique set (automatically prevents duplicates!)
            if track_id not in self.unique_ids[category]:
                self.unique_ids[category].add(track_id)
                new_detections += 1

        # Calculate current counts
        bearing_count = len(self.unique_ids['bearing'])
        non_bearing_count = len(self.unique_ids['non_bearing'])
        non_viable_count = len(self.unique_ids['non_viable'])
        total_count = bearing_count + non_bearing_count + non_viable_count

        self.total_frames_processed += 1

        # Collect per-track bboxes for the frontend overlay.
        # Coordinates are normalized (0–1) relative to the inference frame so the
        # frontend can map them onto the <video> element at any display resolution.
        inf_h_px, inf_w_px = inference_frame.shape[:2]
        bbox_detections = []
        for track in tracks:
            if not track.is_confirmed():
                continue
            cls = track.det_class or ''
            if cls in ('bearing', 'Bearing'):
                cls_key = 'bearing'
            elif cls in ('non-bearing', 'non_bearing', 'Non-Bearing', 'nonbearing'):
                cls_key = 'non_bearing'
            elif cls in ('non-viable', 'non_viable', 'Non-Viable', 'nonviable', 'discolored'):
                cls_key = 'non_viable'
            else:
                continue
            try:
                x1, y1, x2, y2 = (float(v) for v in track.to_ltrb())
                x1 = max(0.0, min(x1, inf_w_px))
                y1 = max(0.0, min(y1, inf_h_px))
                x2 = max(0.0, min(x2, inf_w_px))
                y2 = max(0.0, min(y2, inf_h_px))
                if x2 > x1 and y2 > y1:
                    bbox_detections.append({
                        'id':   int(track.track_id),
                        'cls':  cls_key,
                        'conf': round(float(getattr(track, 'det_conf', 0) or 0), 3),
                        'b':    [
                            round(x1 / inf_w_px, 4),
                            round(y1 / inf_h_px, 4),
                            round((x2 - x1) / inf_w_px, 4),
                            round((y2 - y1) / inf_h_px, 4),
                        ],
                    })
            except Exception:
                pass

        return {
            'bearing':         bearing_count,
            'non_bearing':     non_bearing_count,
            'non_viable':      non_viable_count,
            'total':           total_count,
            'new_detections':  new_detections,
            'frame_number':    self.total_frames_processed,
            'bbox_detections': bbox_detections,
        }
    
    def start_detection(
        self,
        hls_url: str,
        block_id: str,
        user_id: str,
        fps: int = 1,
        update_interval: float = 2.0
    ) -> Optional[str]:
        """
        Start real-time detection from HLS stream.

        Args:
            hls_url: HLS stream URL (e.g., http://localhost:8888/stream/index.m3u8)
            block_id: Firestore block document ID
            user_id: User ID for the scan session
            fps: Frames per second to process (default: 1)
            update_interval: Seconds between Firebase updates (default: 2.0)

        Returns:
            Scan session ID if successful, None otherwise
        """
        # Create scan session (Firebase app is already initialized by app.py)
        scan_id = create_scan_session(block_id, user_id)
        if not scan_id:
            print("❌ Failed to create scan session")
            return None

        # Reset tracking data
        self.reset_tracking()

        # Start detection in background thread
        self.detection_active = True
        self.detection_thread = threading.Thread(
            target=self._detection_loop,
            args=(hls_url, block_id, scan_id, user_id, fps, update_interval),
            daemon=True
        )
        self.detection_thread.start()
        
        print(f"✅ Detection started - Scan ID: {scan_id}")
        return scan_id
    
    def _detection_loop(
        self,
        hls_url: str,
        block_id: str,
        scan_id: str,
        user_id: str,
        fps: int,
        update_interval: float
    ):
        """
        Main detection loop (runs in background thread).
        """
        # Initialize stream capture
        stream = HLSStreamCapture(hls_url, fps=fps)
        
        if not stream.start():
            print("❌ Failed to start stream capture")
            self.detection_active = False
            try:
                db = get_firestore_client()
                from firebase_admin import firestore as _fs
                db.collection('scans').document(scan_id).update({
                    'status': 'failed',
                    'endTime': _fs.SERVER_TIMESTAMP,
                })
            except Exception:
                pass
            return

        print(f"🎥 Stream capture started - Processing at {fps} FPS")

        last_update_time = 0
        completed_normally = False

        try:
            while self.detection_active and stream.is_running():
                # Get next frame
                frame = stream.get_frame(timeout=5.0)

                if frame is None:
                    print("⚠️ No frame received, retrying...")
                    continue

                # Run detection on frame
                results = self.detect_frame(frame)

                # Check if it's time to update Firebase
                current_time = time.time()
                if current_time - last_update_time >= update_interval:
                    # Fire-and-forget: write in a daemon thread so the
                    # detection loop never blocks on a Firestore round-trip.
                    _b  = results['bearing']
                    _nb = results['non_bearing']
                    _nv = results['non_viable']
                    _t  = results['total']
                    threading.Thread(
                        target=update_detection_batch,
                        kwargs=dict(
                            block_id=block_id,
                            scan_id=scan_id,
                            bearing_count=_b,
                            non_bearing_count=_nb,
                            non_viable_count=_nv,
                            total_count=_t,
                        ),
                        daemon=True,
                    ).start()
                    last_update_time = current_time

                    # Only log when new objects are found to keep output lean
                    if results['new_detections'] > 0:
                        print(f"📊 Frame {results['frame_number']}: "
                              f"Total={results['total']} "
                              f"(B:{results['bearing']}, "
                              f"NB:{results['non_bearing']}, "
                              f"NV:{results['non_viable']}) "
                              f"[+{results['new_detections']} new]")
            # True only when detection_active was set False by stop_detection();
            # if the loop exited because the stream permanently died,
            # detection_active is still True → completed_normally stays False
            # → finally block marks the scan as 'failed'.
            completed_normally = not self.detection_active

        except Exception as e:
            print(f"❌ Error in detection loop: {e}")
            import traceback
            traceback.print_exc()

        finally:
            stream.stop()
            print("🛑 Detection loop stopped")
            if not completed_normally:
                try:
                    db = get_firestore_client()
                    from firebase_admin import firestore as _fs
                    db.collection('scans').document(scan_id).update({
                        'status': 'failed',
                        'endTime': _fs.SERVER_TIMESTAMP,
                    })
                except Exception:
                    pass
    
    def stop_detection(self, block_id: str, scan_id: str, user_id: str = '') -> bool:
        """
        Stop detection and finalize scan session.

        Args:
            block_id: Firestore block document ID
            scan_id: Scan session ID
            user_id: Owner UID — forwarded to alert creation so every
                     monitoring_alert document gets a userId field.

        Returns:
            True if stopped successfully, False otherwise
        """
        if not self.detection_active:
            print("⚠️ Detection is not active")
            return False
        
        print("🛑 Stopping detection...")
        self.detection_active = False
        
        # Wait for detection thread to finish
        if self.detection_thread:
            self.detection_thread.join(timeout=5.0)
        
        # Get final counts
        bearing_count = len(self.unique_ids['bearing'])
        non_bearing_count = len(self.unique_ids['non_bearing'])
        non_viable_count = len(self.unique_ids['non_viable'])
        total_count = bearing_count + non_bearing_count + non_viable_count
        
        # Calculate percentages
        if total_count > 0:
            bearing_percent = (bearing_count / total_count) * 100
            non_bearing_percent = (non_bearing_count / total_count) * 100
            non_viable_percent = (non_viable_count / total_count) * 100
        else:
            bearing_percent = 0.0
            non_bearing_percent = 0.0
            non_viable_percent = 0.0

        # Population-based estimation
        registered_population = get_block_population(block_id)
        est_bearing, est_non_bearing, det_coverage = _compute_population_estimates(
            bearing_count, non_bearing_count, registered_population
        )

        # Complete scan session
        success = complete_scan_session(
            scan_id=scan_id,
            block_id=block_id,
            bearing_count=bearing_count,
            non_bearing_count=non_bearing_count,
            non_viable_count=non_viable_count,
            total_count=total_count,
            registered_population=registered_population,
            estimated_bearing=est_bearing,
            estimated_non_bearing=est_non_bearing,
            detection_coverage=det_coverage,
        )
        
        if success:
            print(f"✅ Scan completed successfully")
            print(f"📊 Final Results:")
            print(f"   Total Pineapples: {total_count}")
            if total_count > 0:
                print(f"   Bearing: {bearing_count} ({bearing_percent:.1f}%)")
                print(f"   Non-Bearing: {non_bearing_count} ({non_bearing_percent:.1f}%)")
                print(f"   Non-Viable: {non_viable_count} ({non_viable_percent:.1f}%)")
            print(f"   Unique IDs tracked: {len(self.unique_ids['bearing']) + len(self.unique_ids['non_bearing']) + len(self.unique_ids['non_viable'])}")
            if registered_population > 0:
                print(f"📈 Population Estimates (registered: {registered_population}):")
                print(f"   Est. Bearing:     {est_bearing}")
                print(f"   Est. Non-Bearing: {est_non_bearing}")
                print(f"   Detection Coverage: {det_coverage:.1f}%")
            
            # ✅ CHECK THRESHOLDS AND CREATE/RESOLVE ALERTS
            print("\n🔔 Checking alert thresholds...")
            try:
                check_thresholds_and_create_alerts(
                    block_id=block_id,
                    bearing_percent=bearing_percent,
                    non_bearing_percent=non_bearing_percent,
                    non_viable_percent=non_viable_percent,
                    user_id=user_id,
                )
            except Exception as e:
                print(f"⚠️ Error checking thresholds: {e}")
        
        return success

    def start_video_scan(
        self,
        video_path: str,
        block_id: str,
        user_id: str,
        process_every_n_frames: int = 5,
        update_interval: float = 2.0,
    ) -> Optional[str]:
        """
        Start a deterministic sequential video-file scan. Returns scan_id
        immediately; frame processing runs in a background daemon thread that
        reads frames sequentially via cap.read() — identical to the pipeline
        used in test_video_firebase.py — guaranteeing the same video always
        produces the same detection results regardless of CPU load or browser
        playback timing.

        process_every_n_frames: process 1 frame out of every N sequential
            frames (default 5, matching test_video_firebase.py). Higher values
            are faster but may miss fast-moving plants.
        """
        import os
        if not os.path.isfile(video_path):
            print(f"❌ Video file not found: {video_path}")
            return None

        scan_id = create_scan_session(block_id, user_id)
        if not scan_id:
            print("❌ Failed to create scan session")
            return None

        self.reset_tracking()
        self._current_scan_id = scan_id

        self.detection_active = True
        self.detection_thread = threading.Thread(
            target=self._video_scan_loop_sequential,
            args=(video_path, block_id, scan_id, user_id,
                  process_every_n_frames, update_interval),
            daemon=True,
        )
        self.detection_thread.start()
        print(f"✅ Deterministic sequential video scan started — Scan ID: {scan_id}")
        return scan_id

    def _video_scan_loop(
        self,
        video_path: str,
        block_id: str,
        scan_id: str,
        user_id: str,
        frame_skip: int,
        update_interval: float,
    ):
        """
        Background thread for async video-file scanning.
        Respects self.detection_active so stop_detection() can cancel early.
        """
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(f"❌ OpenCV could not open: {video_path}")
            self.detection_active = False
            return

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        source_fps   = cap.get(cv2.CAP_PROP_FPS) or 25.0
        print(f"🎬 Video scan loop: {total_frames} frames @ {source_fps:.1f} FPS, "
              f"frame_skip={frame_skip}, block={block_id}")

        frame_index  = 0
        last_update  = time.time()
        success_flag = False

        try:
            while self.detection_active:
                ret, frame = cap.read()
                if not ret:
                    break

                frame_index += 1
                if frame_index % frame_skip != 0:
                    continue

                try:
                    results = self.detect_frame(frame)
                except Exception as e:
                    print(f"⚠️  Frame {frame_index}: detection error — {e}")
                    continue

                now = time.time()
                if now - last_update >= update_interval:
                    threading.Thread(
                        target=update_detection_batch,
                        kwargs=dict(
                            block_id=block_id,
                            scan_id=scan_id,
                            bearing_count=results['bearing'],
                            non_bearing_count=results['non_bearing'],
                            non_viable_count=results['non_viable'],
                            total_count=results['total'],
                        ),
                        daemon=True,
                    ).start()
                    last_update = now

            success_flag = True

        except Exception as e:
            print(f"❌ Video scan loop error: {e}")
            import traceback
            traceback.print_exc()

        finally:
            cap.release()
            self.detection_active = False

        # ── Final counts ─────────────────────────────────────────────
        bearing_count     = len(self.unique_ids['bearing'])
        non_bearing_count = len(self.unique_ids['non_bearing'])
        non_viable_count  = len(self.unique_ids['non_viable'])
        total_count       = bearing_count + non_bearing_count + non_viable_count

        if total_count > 0:
            bearing_pct     = (bearing_count     / total_count) * 100
            non_bearing_pct = (non_bearing_count / total_count) * 100
            non_viable_pct  = (non_viable_count  / total_count) * 100
        else:
            bearing_pct = non_bearing_pct = non_viable_pct = 0.0

        # Population-based estimation
        registered_population = get_block_population(block_id)
        est_bearing, est_non_bearing, det_coverage = _compute_population_estimates(
            bearing_count, non_bearing_count, registered_population
        )

        if success_flag:
            committed = complete_scan_session(
                scan_id=scan_id,
                block_id=block_id,
                bearing_count=bearing_count,
                non_bearing_count=non_bearing_count,
                non_viable_count=non_viable_count,
                total_count=total_count,
                registered_population=registered_population,
                estimated_bearing=est_bearing,
                estimated_non_bearing=est_non_bearing,
                detection_coverage=det_coverage,
            )
            if committed:
                print(f"✅ Video scan loop done — {frame_index} frames processed")
                if registered_population > 0:
                    print(f"📈 Population Estimates (registered: {registered_population}): "
                          f"Est. Bearing={est_bearing}, Est. Non-Bearing={est_non_bearing}, "
                          f"Coverage={det_coverage:.1f}%")
                try:
                    check_thresholds_and_create_alerts(
                        block_id=block_id,
                        bearing_percent=bearing_pct,
                        non_bearing_percent=non_bearing_pct,
                        non_viable_percent=non_viable_pct,
                        user_id=user_id,
                    )
                except Exception as e:
                    print(f"⚠️  Threshold check failed: {e}")
            else:
                print("❌ complete_scan_session failed in video loop")
        else:
            try:
                db = get_firestore_client()
                from firebase_admin import firestore as _fs
                db.collection('scans').document(scan_id).update({
                    'status': 'failed',
                    'endTime': _fs.SERVER_TIMESTAMP,
                })
            except Exception:
                pass

        # Clean up temp file
        try:
            import os as _os
            if _os.path.isfile(video_path):
                _os.remove(video_path)
                print(f"🗑️  Removed temp file: {video_path}")
        except Exception as e:
            print(f"⚠️  Could not remove temp file: {e}")

    def _video_scan_loop_sequential(
        self,
        video_path: str,
        block_id: str,
        scan_id: str,
        user_id: str,
        process_every_n_frames: int,
        update_interval: float,
    ):
        """
        Deterministic sequential background scan loop.

        Reads every frame in order via cap.read() — never seeks — so the
        exact same set of frames is always decoded in the exact same order.
        This mirrors test_video_firebase.py exactly and makes results fully
        reproducible across repeated scans of the same video.

        Non-determinism sources eliminated vs. the old time-synced loop:
          • No cv2.CAP_PROP_POS_MSEC seeks (seek accuracy is codec-dependent)
          • No dependency on browser timeupdate event timing or CPU load
          • No queue-drain that could drop or reorder frames between runs
          • DeepSORT receives frames in a fixed, repeatable sequence so its
            Kalman filter and appearance features converge identically every run
        """
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(f"❌ OpenCV could not open: {video_path}")
            self.detection_active = False
            self._current_scan_id = None
            try:
                db = get_firestore_client()
                from firebase_admin import firestore as _fs
                db.collection('scans').document(scan_id).update({
                    'status': 'failed',
                    'endTime': _fs.SERVER_TIMESTAMP,
                })
            except Exception:
                pass
            return

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        source_fps   = cap.get(cv2.CAP_PROP_FPS) or 25.0
        print(f"🎬 Deterministic sequential scan: {total_frames} frames @ {source_fps:.1f} FPS | "
              f"process_every={process_every_n_frames} frames | block={block_id}")

        frame_count       = 0
        frames_processed  = 0
        last_firebase_update = time.time()
        success_flag      = False
        recent_frames_buf = []   # per-frame bbox data accumulated between batch writes

        try:
            while self.detection_active:
                ret, frame = cap.read()
                if not ret:
                    # End of video — natural completion
                    success_flag = True
                    break

                frame_count += 1

                # Process every Nth frame — identical stride to test_video_firebase.py
                if frame_count % process_every_n_frames != 0:
                    continue

                try:
                    results = self.detect_frame(frame)
                    frames_processed += 1

                    progress = (frame_count / total_frames * 100) if total_frames > 0 else 0
                    if results['new_detections'] > 0:
                        print(f"📊 Frame {frame_count}/{total_frames} ({progress:.1f}%) — "
                              f"Total={results['total']} "
                              f"(B:{results['bearing']}, "
                              f"NB:{results['non_bearing']}, "
                              f"NV:{results['non_viable']}) "
                              f"[+{results['new_detections']} new]")

                    # Accumulate bbox snapshot for this processed frame
                    recent_frames_buf.append({
                        't': round(frame_count / source_fps, 3),
                        'd': results.get('bbox_detections', []),
                    })

                    now = time.time()
                    if now - last_firebase_update >= update_interval:
                        frames_to_write = recent_frames_buf.copy()
                        recent_frames_buf = []
                        threading.Thread(
                            target=update_detection_batch,
                            kwargs=dict(
                                block_id=block_id,
                                scan_id=scan_id,
                                bearing_count=results['bearing'],
                                non_bearing_count=results['non_bearing'],
                                non_viable_count=results['non_viable'],
                                total_count=results['total'],
                                scan_progress=progress,
                                recent_frames=frames_to_write,
                            ),
                            daemon=True,
                        ).start()
                        last_firebase_update = now

                except Exception as e:
                    print(f"⚠️  Detection error at frame {frame_count}: {e}")
                    continue

        except Exception as e:
            print(f"❌ Sequential scan loop error: {e}")
            import traceback
            traceback.print_exc()

        finally:
            cap.release()
            self._current_scan_id = None
            self.detection_active = False

        print(f"🛑 Sequential scan loop stopped "
              f"({frame_count} frames read, {frames_processed} frames processed)")

        # ── Final counts ─────────────────────────────────────────────
        bearing_count     = len(self.unique_ids['bearing'])
        non_bearing_count = len(self.unique_ids['non_bearing'])
        non_viable_count  = len(self.unique_ids['non_viable'])
        total_count       = bearing_count + non_bearing_count + non_viable_count

        if total_count > 0:
            bearing_pct     = (bearing_count     / total_count) * 100
            non_bearing_pct = (non_bearing_count / total_count) * 100
            non_viable_pct  = (non_viable_count  / total_count) * 100
        else:
            bearing_pct = non_bearing_pct = non_viable_pct = 0.0

        registered_population = get_block_population(block_id)
        est_bearing, est_non_bearing, det_coverage = _compute_population_estimates(
            bearing_count, non_bearing_count, registered_population
        )

        if success_flag:
            committed = complete_scan_session(
                scan_id=scan_id,
                block_id=block_id,
                bearing_count=bearing_count,
                non_bearing_count=non_bearing_count,
                non_viable_count=non_viable_count,
                total_count=total_count,
                registered_population=registered_population,
                estimated_bearing=est_bearing,
                estimated_non_bearing=est_non_bearing,
                detection_coverage=det_coverage,
            )
            if committed:
                print(f"✅ Sequential scan complete — {frames_processed} frames processed")
                print(f"📊 Final Results: Total={total_count} "
                      f"(B:{bearing_count} {bearing_pct:.1f}%, "
                      f"NB:{non_bearing_count} {non_bearing_pct:.1f}%, "
                      f"NV:{non_viable_count} {non_viable_pct:.1f}%)")
                if registered_population > 0:
                    print(f"📈 Population Estimates (registered: {registered_population}): "
                          f"Est. Bearing={est_bearing}, Est. Non-Bearing={est_non_bearing}, "
                          f"Coverage={det_coverage:.1f}%")
                try:
                    check_thresholds_and_create_alerts(
                        block_id=block_id,
                        bearing_percent=bearing_pct,
                        non_bearing_percent=non_bearing_pct,
                        non_viable_percent=non_viable_pct,
                        user_id=user_id,
                    )
                except Exception as e:
                    print(f"⚠️  Threshold check failed: {e}")
            else:
                print("❌ complete_scan_session failed in sequential loop")
        else:
            try:
                db = get_firestore_client()
                from firebase_admin import firestore as _fs
                db.collection('scans').document(scan_id).update({
                    'status': 'failed',
                    'endTime': _fs.SERVER_TIMESTAMP,
                })
            except Exception:
                pass

        # Clean up temp file
        try:
            import os as _os
            if _os.path.isfile(video_path):
                _os.remove(video_path)
                print(f"🗑️  Removed temp file: {video_path}")
        except Exception as e:
            print(f"⚠️  Could not remove temp file: {e}")

    def run_video_scan(
        self,
        video_path: str,
        block_id: str,
        user_id: str,
        frame_skip: int = 1,
        update_interval: float = 2.0,
    ) -> bool:
        """
        Run detection on a local MP4 file (no HLS/RTMP/MediaMTX required).

        Reads frames sequentially via OpenCV, runs YOLO+DeepSORT per frame
        (or every ``frame_skip`` frames), and writes to Firestore identically
        to the live stream pipeline.

        Args:
            video_path: Path to the MP4 (or any OpenCV-readable) video file.
            block_id:   Firestore block document ID.
            user_id:    UID of the user who owns this scan.
            frame_skip: Process every Nth frame (1 = every frame, 2 = every other, …).
            update_interval: Seconds between intermediate Firestore writes.

        Returns:
            True if the scan completed and was committed, False on failure.
        """
        import os
        if not os.path.isfile(video_path):
            print(f"❌ Video file not found: {video_path}")
            return False

        scan_id = create_scan_session(block_id, user_id)
        if not scan_id:
            print("❌ Failed to create scan session")
            return False

        self.reset_tracking()
        print(f"🎬 Opening video: {video_path}")

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            print(f"❌ OpenCV could not open: {video_path}")
            return False

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        source_fps   = cap.get(cv2.CAP_PROP_FPS) or 25.0
        print(f"   Total frames : {total_frames}")
        print(f"   Source FPS   : {source_fps:.1f}")
        print(f"   Frame skip   : {frame_skip} (processing every {frame_skip} frame(s))")
        print(f"   Block ID     : {block_id}")
        print(f"   Scan ID      : {scan_id}\n")

        frame_index   = 0
        last_update   = time.time()
        success_flag  = False

        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    break

                frame_index += 1

                # Skip frames for performance throttling
                if frame_index % frame_skip != 0:
                    continue

                try:
                    results = self.detect_frame(frame)
                except Exception as e:
                    print(f"⚠️  Frame {frame_index}: detection error — {e}")
                    continue

                # Progress log every processed frame
                det_msg = (
                    f"[+{results['new_detections']} new]"
                    if results['new_detections'] > 0
                    else ""
                )
                print(
                    f"Frame {frame_index}/{total_frames} processed — "
                    f"Total={results['total']} "
                    f"(B:{results['bearing']}, NB:{results['non_bearing']}, NV:{results['non_viable']}) "
                    + det_msg
                )

                # Periodic intermediate Firestore write
                now = time.time()
                if now - last_update >= update_interval:
                    try:
                        update_detection_batch(
                            block_id=block_id,
                            scan_id=scan_id,
                            bearing_count=results['bearing'],
                            non_bearing_count=results['non_bearing'],
                            non_viable_count=results['non_viable'],
                            total_count=results['total'],
                        )
                    except Exception as e:
                        print(f"⚠️  Firestore intermediate update failed: {e}")
                    last_update = now

            success_flag = True

        except KeyboardInterrupt:
            print("\n⚠️  Interrupted by user — finalizing scan with partial data...")
            success_flag = True  # still commit what we have

        finally:
            cap.release()

        # ── Final counts ─────────────────────────────────────────────────
        bearing_count     = len(self.unique_ids['bearing'])
        non_bearing_count = len(self.unique_ids['non_bearing'])
        non_viable_count  = len(self.unique_ids['non_viable'])
        total_count       = bearing_count + non_bearing_count + non_viable_count

        if total_count > 0:
            bearing_percent     = (bearing_count     / total_count) * 100
            non_bearing_percent = (non_bearing_count / total_count) * 100
            non_viable_percent  = (non_viable_count  / total_count) * 100
        else:
            bearing_percent = non_bearing_percent = non_viable_percent = 0.0

        # Population-based estimation
        registered_population = get_block_population(block_id)
        est_bearing, est_non_bearing, det_coverage = _compute_population_estimates(
            bearing_count, non_bearing_count, registered_population
        )

        if success_flag:
            committed = complete_scan_session(
                scan_id=scan_id,
                block_id=block_id,
                bearing_count=bearing_count,
                non_bearing_count=non_bearing_count,
                non_viable_count=non_viable_count,
                total_count=total_count,
                registered_population=registered_population,
                estimated_bearing=est_bearing,
                estimated_non_bearing=est_non_bearing,
                detection_coverage=det_coverage,
            )
            if committed:
                print(f"\n✅ Video scan complete — {frame_index} frames read, "
                      f"{self.total_frames_processed} frames processed")
                print(f"📊 Final Results:")
                print(f"   Total Pineapples : {total_count}")
                if total_count > 0:
                    print(f"   Bearing          : {bearing_count} ({bearing_percent:.1f}%)")
                    print(f"   Non-Bearing      : {non_bearing_count} ({non_bearing_percent:.1f}%)")
                    print(f"   Non-Viable       : {non_viable_count} ({non_viable_percent:.1f}%)")
                if registered_population > 0:
                    print(f"📈 Population Estimates (registered: {registered_population}):")
                    print(f"   Est. Bearing     : {est_bearing}")
                    print(f"   Est. Non-Bearing : {est_non_bearing}")
                    print(f"   Detection Coverage: {det_coverage:.1f}%")

                print("\n🔔 Checking alert thresholds...")
                try:
                    check_thresholds_and_create_alerts(
                        block_id=block_id,
                        bearing_percent=bearing_percent,
                        non_bearing_percent=non_bearing_percent,
                        non_viable_percent=non_viable_percent,
                        user_id=user_id,
                    )
                except Exception as e:
                    print(f"⚠️  Threshold check failed: {e}")

                return True
            else:
                print("❌ complete_scan_session failed")
                return False
        else:
            # Hard failure path — mark scan failed in Firestore
            try:
                db = get_firestore_client()
                from firebase_admin import firestore as _fs
                db.collection('scans').document(scan_id).update({
                    'status': 'failed',
                    'endTime': _fs.SERVER_TIMESTAMP,
                })
            except Exception:
                pass
            return False


# Global detector instance
_detector: Optional[PineappleDetector] = None


def get_detector(model_path: str = None) -> PineappleDetector:
    """
    Get or create global detector instance.
    
    Args:
        model_path: Path to best.pt model (only needed on first call)
    
    Returns:
        PineappleDetector instance
    """
    global _detector
    
    if _detector is None:
        if model_path is None:
            # Default path
            model_path = Path(__file__).parent.parent / 'best.pt'
        
        _detector = PineappleDetector(str(model_path))
    
    return _detector


# CLI entry point — supports two modes:
#   Mode 1 (live HLS):  python -m drone_conn.detection <hls_url> [block_id] [user_id]
#   Mode 2 (MP4 file):  python -m drone_conn.detection --video path/to/file.mp4
#                           --block_id <id> --user_id <id> [--frame_skip N]
if __name__ == "__main__":
    import sys
    import argparse

    parser = argparse.ArgumentParser(
        prog="drone_conn.detection",
        description="PineVision YOLO detection — HLS stream or MP4 file",
    )
    parser.add_argument("--video",      help="Path to MP4 file (enables MP4 mode)")
    parser.add_argument("--block_id",   default="test_block")
    parser.add_argument("--user_id",    default="test_user")
    parser.add_argument("--frame_skip", type=int, default=1,
                        help="Process every Nth frame (MP4 mode only, default 1)")
    # Positional for backward-compatible HLS mode
    parser.add_argument("hls_url",      nargs="?", help="HLS stream URL (live mode)")
    parser.add_argument("pos_block_id", nargs="?", help="block_id positional (live mode)")
    parser.add_argument("pos_user_id",  nargs="?", help="user_id positional (live mode)")

    args = parser.parse_args()

    # Resolve block_id / user_id (named flags take priority over positional)
    block_id = args.block_id if args.block_id != "test_block" else (args.pos_block_id or args.block_id)
    user_id  = args.user_id  if args.user_id  != "test_user"  else (args.pos_user_id  or args.user_id)

    detector = get_detector()

    # ── Mode 2: MP4 file ────────────────────────────────────────────────
    if args.video:
        print("\n🎬 MP4 scan mode")
        print(f"   Video      : {args.video}")
        print(f"   Block ID   : {block_id}")
        print(f"   User ID    : {user_id}")
        print(f"   Frame skip : {args.frame_skip}\n")
        ok = detector.run_video_scan(
            video_path=args.video,
            block_id=block_id,
            user_id=user_id,
            frame_skip=args.frame_skip,
        )
        sys.exit(0 if ok else 1)

    # ── Mode 1: live HLS stream ─────────────────────────────────────────
    if not args.hls_url:
        parser.print_help()
        print("\nExamples:")
        print("  Live mode : python -m drone_conn.detection http://localhost:8888/live/index.m3u8 block_123 user_abc")
        print("  MP4 mode  : python -m drone_conn.detection --video farm.mp4 --block_id block_123 --user_id user_abc")
        sys.exit(1)

    hls_url = args.hls_url
    print("\n🚀 Starting live HLS detection...")
    print(f"   HLS URL  : {hls_url}")
    print(f"   Block ID : {block_id}")
    print(f"   User ID  : {user_id}")
    print("\n   Press Ctrl+C to stop...\n")

    scan_id = detector.start_detection(hls_url, block_id, user_id, fps=1)

    if scan_id:
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n\n⚠️ Stopping detection...")
            detector.stop_detection(block_id, scan_id, user_id)
    else:
        print("❌ Failed to start detection")