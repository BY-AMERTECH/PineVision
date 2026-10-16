# PineVision — Full Codebase Analysis Report

> Historical analysis: its Schedule Scan section describes an earlier implementation state. The Schedule Scan feature has since been removed.

> **Analysis date:** 2026-05-30
> **Scope:** All backend Python, frontend HTML/JS/CSS, Firestore rules
> **Purpose:** Read-only audit — no code was modified

---

## Summary Table

| Category | Issues Found | Severity |
|---|---|---|
| Duplicate logic / functions | 9 | Medium – High |
| Naming inconsistencies | 5 | Medium |
| Bugs & logic errors | 10 | Medium – High |
| Redundant / unused code | 7 | Low – Medium |
| UI elements not wired to backend | 8 | Medium |
| Backend–frontend data flow gaps | 5 | Medium |
| Security concerns | 4 | Medium |

**Most critical issues:**
1. Auth redirect to non-existent `../auth/login.html` — unauthenticated users get a 404 instead of the login page
2. `buildInlineBar()` in `utils.js` has a ReferenceError when `color` is omitted
3. Singleton `PineappleDetector` shared across concurrent requests — data corruption in multi-user scenario
4. Block deletion is localStorage-only — Firestore data persists indefinitely
5. Inconsistent status thresholds cause different health classifications for the same block on different pages

---

## 1. Duplicate Logic & Functions

### 1.1 `getStatusClass()` defined in 4 places with different thresholds

| Location | Thresholds |
|---|---|
| `frontend/js/utils.js:16` | From `window.data.getThresholds()` — 60 crit / 75 watch |
| `frontend/pages/client/blocks.html:808` | Hardcoded: `>=80` = good, `>=60` = warn |
| `frontend/pages/client/blocks-view.html:1232` | Same as blocks.html — 80 / 60 |
| `frontend/js/dashboard.js:504` | Hardcoded: `>=75` = healthy, `>=60` = warning |

**Why it's a problem:** A block at 72% bearing is classified as `good` on `blocks.html` (threshold 60), `warn` on `dashboard.js` (threshold 75), and follows configured thresholds on `utils.js`. Users see inconsistent health status for the same block on different pages.

---

### 1.2 `buildMetricCard()` defined in 5 places with a CSS class mismatch

| Location | CSS class used |
|---|---|
| `frontend/js/utils.js:143` | `.mc` |
| `frontend/js/alerts.js:452` | `.mcard` |
| `frontend/js/dashboard.js:472` | `.mcard` |
| `frontend/js/scans.js:268` | `.mcard` |
| `frontend/pages/client/blocks-view.html:1250` | `.mcard` |

**Why it's a problem:** The canonical `utils.buildMetricCard()` generates a different CSS class (`.mc`) than every page that actually uses this pattern (`.mcard`). The utility version is effectively unused for metric cards.

---

### 1.3 `formatNumber()`, `formatPercent()`, `formatArea()` redefined in every file

Canonical versions live in `frontend/js/utils.js:76`–109. Identical private copies exist in:
- `frontend/pages/client/blocks.html:844`
- `frontend/pages/client/blocks-view.html:1268`
- `frontend/js/dashboard.js:516`
- `frontend/js/scans.js:281`

---

### 1.4 `buildInlineBar()` defined in 4 places using 3 different CSS class families

| Location | CSS classes |
|---|---|
| `frontend/js/utils.js:126` | `.ibar`, `.it`, `.if` |
| `frontend/pages/client/blocks.html:832` | `.bar-wrap`, `.bar-fill` |
| `frontend/pages/client/blocks-view.html:1264` | `.bar-wrap`, `.bar-fill` |
| `frontend/js/dashboard.js:485` | `.inline-bar-container`, `.inline-bar` |

**Why it's a problem:** Three separate CSS class families for the same conceptual component. Only one matches `utils.js`.

---

### 1.5 `statusBadge()` defined in 3 places

`frontend/js/utils.js:43`, `frontend/pages/client/blocks.html:820`, `frontend/pages/client/blocks-view.html:1238` — all produce slightly different markup.

---

### 1.6 `_video_scan_loop` is dead code alongside the active `_video_scan_loop_sequential`

`backend/drone_conn/detection.py:698`–838 — the old time-synced loop is never called. `start_video_scan()` only invokes `_video_scan_loop_sequential()`. The dead method still contains ~140 lines including its own `complete_scan_session()` and `check_thresholds_and_create_alerts()` calls.

---

### 1.7 Final-counts calculation block copy-pasted 3 times

The pattern of computing percentages, calling `_compute_population_estimates()`, `complete_scan_session()`, and `check_thresholds_and_create_alerts()` is duplicated in:

- `backend/drone_conn/detection.py:768` — `_video_scan_loop` (dead)
- `backend/drone_conn/detection.py:960` — `_video_scan_loop_sequential`
- `backend/drone_conn/detection.py:1143` — `run_video_scan`

---

### 1.8 Two Firebase credential files exist simultaneously

`backend/firebase-service-account.json` and `backend/serviceAccountKey.json` both exist. `backend/app.py:59` loads only `serviceAccountKey.json`. The other file may be a stale or different-generation key — a security risk if committed to version control.

---

### 1.9 `update_block_stats()` and `update_scan_progress()` are dead code

`backend/drone_conn/firebase_client.py:230`–277 — marked "kept for backward compatibility" but no caller exists anywhere in the codebase.

---

## 2. Naming Inconsistencies

### 2.1 `nonViable` vs `nonViablePercent` vs `discolored` — three names for one concept

| Layer | Field name | Stored value |
|---|---|---|
| `blocks` Firestore doc | `nonViable` | Percentage (e.g., `8.5` means 8.5%) |
| `scans` Firestore doc (during scan) | `nonViable` | Raw count |
| `scans` Firestore doc (on completion) | `nonViablePercent` | Percentage |
| `frontend/js/data.js` mock data | `discolored` | Percentage |
| `frontend/js/data.js` THRESHOLDS | `discolored` | Threshold key name |
| `frontend/js/alerts.js:38` | `thresholds.discolored` | Threshold key name |
| `frontend/js/drone-view.js:52` | `DRONE_STATE.stats.discolored` | Runtime stat |

**Why it's a problem:** The concept has three names across layers. `nonViable` in `blocks` means a percentage but in `scans` means a count — same field name, different semantics.

---

### 2.2 `bearingPercent` and `nonBearingPercent` use a "Percent" suffix but `nonViable` does not

In the `blocks` Firestore collection: `bearingPercent`, `nonBearingPercent`, `nonViable`. The missing "Percent" suffix on `nonViable` makes the schema ambiguous — it is unclear whether the field stores a count or a percentage without reading the backend code.

---

### 2.3 `data.name` vs `blockName` — dashboard reads a field that doesn't exist

`frontend/js/dashboard.js:56`:
```javascript
name: data.name || `Block ${doc.id.substring(0, 6)}`
```

Firestore blocks store `blockName`, not `name`. So `data.name` is always `undefined`, and every block on the dashboard falls back to a truncated Firestore document ID (e.g., "Block Ka9Qfs") instead of the human-readable block name set by the user.

---

### 2.4 "Block ID" label in edit modal saves to `blockName` field

In `frontend/pages/client/blocks-view.html:681`, the edit modal label reads "Block ID \*" but the input is `id="edit-blockName"` and the Firestore update saves to `blockName`. A user editing what they believe is the block identifier is actually changing `blockName`.

---

### 2.5 Two separate alert collections — `alerts` vs `monitoring_alerts`

| Collection | Written by | Displayed by |
|---|---|---|
| `alerts` | `frontend/js/auth.js:258` — failed login events | Nothing — no UI reads it |
| `monitoring_alerts` | Backend detection engine | `frontend/js/alerts.js` |

Failed-login security events are written to `alerts` but are never surfaced in any admin or client UI.

---

## 3. Bugs & Logic Errors

### 3.1 Auth redirect goes to non-existent path on multiple pages

Three pages redirect unauthenticated users to `'../auth/login.html'`, which does not exist in the project:

- `frontend/js/dashboard.js:29`
- `frontend/js/flight.js:29`
- `frontend/js/alerts.js:53`

The login page is at `pages/index.html`. An unauthenticated user reaching these pages sees a 404 instead of the login form.

---

### 3.2 `buildInlineBar()` in `utils.js` triggers a ReferenceError on falsy color

`frontend/js/utils.js:128`:
```javascript
const barColor = color || barColor(percentage);
```

The `const barColor` variable shadows the outer function `barColor` defined at `utils.js:56`. When `color` is falsy, JavaScript attempts to call `barColor(percentage)` before the `const` binding is fully initialized, causing:
```
ReferenceError: Cannot access 'barColor' before initialization
```

---

### 3.3 Singleton `PineappleDetector` — concurrent scans corrupt each other's state

`backend/drone_conn/detection.py:1222`–1244: `get_detector()` returns a single module-level instance. The instance holds `unique_ids`, `detection_active`, and `detection_thread` as shared state. If two users start scans simultaneously:
- `reset_tracking()` for one user wipes the other user's tracking data
- `stop_detection()` stops whichever scan is active — potentially the wrong one

---

### 3.4 Block deletion is localStorage-only — Firestore data persists

`frontend/pages/client/blocks-view.html:1461` (`handleDeleteBlock()`): pushes the block ID into `localStorage["pinevision_deleted_blocks"]` — no Firestore delete is performed. Consequences:
- The block document remains in Firestore
- Associated scans, alerts, and missions continue to accumulate
- The block reappears on any other device or browser, or after clearing storage

---

### 3.5 Harvest status is device-local — not synced to Firestore or other users

`frontend/pages/client/blocks-view.html:1344` (`saveBlockStatus()`): stores harvest status in `localStorage`. If a farmer marks a block "Harvested" on one device, all other devices still show "Still Growing".

---

### 3.6 `calculateFarmTotals()` produces `NaN` metrics when all blocks have 0 detected pineapples

`frontend/js/dashboard.js:111`:
```javascript
const weight = (block.totalPineapples || 0) / totalPlants;
```
If every block has `totalPineapples = 0`, then `totalPlants = 0` and every weight is `NaN`. This cascades into all weighted averages (bearing, non-bearing, non-viable) and renders as "NaN%" in every metric card.

---

### 3.7 `scans.js` makes N identical Firestore reads for the operator's full name

`frontend/js/scans.js:88`–98: for every scan in the result set, a `users/{userId}` document is fetched. Since the query filters by `userId == currentUserId`, every fetch hits the same document. For 20 scans this is 20 redundant round-trips to Firestore.

---

### 3.8 `handleEditBlock` desync — in-memory state mutated before Firestore confirms

`frontend/pages/client/blocks-view.html:1412`–1446: `currentBlock` is mutated in memory before the `.update()` call resolves. If Firestore returns an error, the UI shows the "updated" values but the database still holds the old ones. There is no rollback of the in-memory state on failure.

---

### 3.9 Race condition — `stop_detection()` and `_video_scan_loop_sequential` can both call `complete_scan_session()`

`backend/drone_conn/detection.py:564`–652: `stop_detection()` joins the background thread then calls `complete_scan_session()`. Meanwhile, `_video_scan_loop_sequential` also calls `complete_scan_session()` when the video ends naturally. If the video finishes and the user presses "End Scan" within the 5-second join window, `complete_scan_session()` can be invoked twice for the same `scan_id`, potentially writing duplicate or overwritten final data to Firestore.

---

### 3.10 Mission number assignment produces duplicates after deletion

`frontend/js/flight.js:304`:
```javascript
const missionNumber = `MISSION #${allMissions.length + 1}`;
```
If a user has 5 missions, deletes mission 2, then creates a new mission, the new mission becomes "MISSION #5" — a duplicate number. The counter is based on the current array length, not an incrementing persistent counter.

---

## 4. Redundant / Unused Code

### 4.1 `data.js` is almost entirely unused in production

`frontend/js/data.js` contains 8 mock block objects, 6 mock scans, mock alerts, mock users, mock activity logs, and 10+ getter functions. Every real page fetches live data from Firestore directly. The only call from production code is `window.data.getThresholds()` from `utils.js`. All mock arrays and their getters are dead weight loaded on every page.

---

### 4.2 `updateVideoProgress()` in `drone-view.js` is never registered as an event listener

`frontend/js/drone-view.js:738`–751: the function exists but no `addEventListener('timeupdate', updateVideoProgress)` call appears in the file. `handleVideoFailed()` at line 724 calls `removeEventListener('timeupdate', updateVideoProgress)` — a no-op removing a listener that was never added.

---

### 4.3 `DRONE_STATE.scanProgressInterval` is never assigned

`frontend/js/drone-view.js:47`: `scanProgressInterval: null` is defined in state and cleared in `stopScanIntervals()`, but it is never set to an actual interval ID anywhere in the file.

---

### 4.4 `window.data.getFarmTotals` is exported but never called

`frontend/js/data.js:653`–660: `getFarmTotals` is exposed on `window.data` but never invoked. `dashboard.js` has its own `calculateFarmTotals()` using live Firestore data.

---

### 4.5 `auth.checkAuth` is a redundant alias for `auth.requireAuth`

`frontend/js/auth.js:370`: `checkAuth: requireAuth`. Two names for the same function. `app.js` calls `auth.checkAuth()` while other pages call `auth.requireAuth()`.

---

### 4.6 `_video_scan_loop` (~140 lines) is never called

`backend/drone_conn/detection.py:698`–838. `start_video_scan()` calls only `_video_scan_loop_sequential`. The old loop method is unreachable from any production code path.

---

### 4.7 `update_block_stats()` and `update_scan_progress()` in `firebase_client.py` (~45 lines)

`backend/drone_conn/firebase_client.py:230`–277. Marked as deprecated, no callers exist anywhere.

---

## 5. UI Elements Not Connected to Backend Logic

### 5.1 "Schedule Scan" button never opens its modal

`frontend/pages/client/blocks-view.html:1476`:
```javascript
function openScheduleScanModal() {
    utils.showToast("Schedule scan feature coming soon!", "info");
}
```
A complete Schedule Scan modal is defined in the HTML (lines 811–866) with a form and submit handler (`handleScheduleScan`), but the function that should open it shows a toast instead. The modal HTML and `handleScheduleScan()` are dead code.

---

### 5.2 "Bearing Rate Trend" modal shows the same hardcoded data for every block

`frontend/pages/client/blocks-view.html:1293`–1330: `renderTrendModal()` uses a `mockHistory` array hardcoded to March–May 2026 values. No Firestore query fetches actual historical scan data per block. Every block shows an identical trend.

---

### 5.3 PDF download button in trend modal has no event handler

Each row in the trend modal has a PDF icon button. The modal footer says "hover PDF icon to download." The buttons have no `onclick` or `addEventListener`. Clicking does nothing.

---

### 5.4 Bounding box overlay only works for MP4 mode — not live HLS

`frontend/js/drone-view.js:701`: `BboxOverlay.start()` is called only in `handleFileSelect()` (video upload path). In `onHlsReady()` (line 512), `startDetection()` is called but `BboxOverlay.start()` is not. Live drone scans never render detection bounding boxes on the video feed.

---

### 5.5 `alerts` collection (failed-login security events) has no UI reader

The `alerts` Firestore collection receives failed-login records from `frontend/js/auth.js:258` but no frontend page or admin view reads or displays it. The data is captured and stored but is invisible to all users.

---

### 5.6 Dashboard and scans pages always show the same hardcoded drone name

- `frontend/js/dashboard.js:172`: `"DJI Mavic 3 Multispectral"` hardcoded in `renderScanMeta()`
- `frontend/js/scans.js:128`: `drone: 'DJI Mavic 3 Multispectral'` hardcoded per scan entry

Neither page reads drone information from Firestore. The drone name displayed never reflects what was actually used.

---

### 5.7 Block detail page shows no per-block scan history

`frontend/pages/client/blocks-view.html` displays current block stats but has no list of individual scan sessions for that block. The only scan-related element is the "Bearing Rate Trend" section, which uses mock data (see §5.2).

---

### 5.8 "Field Operations" nav section includes Reports and Flight links with no drone-view or scan connection

The sidebar on client pages links to `reports.html` and `flight.html`, but neither page has any connection to the active scan session, block detection state, or real-time drone data. A user mid-scan has no visual indication if they navigate away.

---

## 6. Backend–Frontend Data Flow Gaps

### 6.1 Population estimates written but never displayed

`backend/drone_conn/firebase_client.py:197`–213: `complete_scan_session()` writes `estimatedBearing`, `estimatedNonBearing`, and `detectionCoverage` to both the `scans` and `blocks` documents. No frontend page reads or displays any of these fields. The population estimation pipeline runs end-to-end but its results are invisible to users.

---

### 6.2 `recentFrames` (bounding box data) only populated during video scans, not live HLS

`backend/drone_conn/firebase_client.py:106`–107: `recent_frames` is passed to `update_detection_batch()` from `_video_scan_loop_sequential`. The `_detection_loop` (live HLS path) never passes `recent_frames`. Consequently, `BboxOverlay.ingestFrames()` in the frontend only ever receives data for MP4 scans, never for live streams.

---

### 6.3 `scans.js` ignores stored `bearingPercent` / `nonBearingPercent` on scan documents

`frontend/js/scans.js:123`–128: reads `data.bearing` (count) and `data.nonBearing` (count), then recalculates percentages locally:
```javascript
const bearingPercent = scan.total > 0 ? (scan.bearing / scan.total) * 100 : 0;
```
`complete_scan_session()` already writes `bearingPercent` and `nonBearingPercent` to the scan document. These stored percentages are unused by `scans.js`, which recalculates them from raw counts. If the stored and recalculated values differ due to rounding, the displayed percentages are inconsistent with what the backend stored.

---

### 6.4 Mission number is frontend-assigned, not backend-assigned — no deduplication guarantee

`frontend/js/flight.js:304`: mission numbers like "MISSION #3" are assigned by the frontend at creation time based on the in-memory array length. The backend (`/api/missions`) is not involved. Two users creating missions simultaneously, or a user creating a mission from two tabs, can produce duplicate mission numbers.

---

### 6.5 `daysAfterFlowering` field alias in `dashboard.js` is never written

`frontend/js/dashboard.js:59`:
```javascript
daf: data.daysAfterFlowering || data.daf || 0,
```
No code path writes `daysAfterFlowering` to Firestore. `blocks.html` writes `daf`. So `data.daysAfterFlowering` is always `undefined` and the fallback `data.daf` is used. This is a dead field alias, likely leftover from a rename.

---

## 7. Security Concerns

### 7.1 `activity_logs` and `alerts` allow unauthenticated writes

`firestore.rules:74`: `allow create: if true` on both `activity_logs` and `alerts`. Any unauthenticated client on the internet can write arbitrary documents to these collections, consuming Firestore write quota and storage without any rate limiting or authentication check.

### 7.2 Backend Admin SDK bypasses all Firestore security rules for `monitoring_alerts`

The Flask backend uses `firebase-admin` with a service account. Alert documents created by `check_thresholds_and_create_alerts()` bypass all Firestore rules. The `userId` field is set manually by the backend code. If rules are later enforced via a client SDK (e.g., mobile app), the behavior diverges — backend alerts succeed while client attempts fail — making authorization behavior inconsistent.

### 7.3 Firebase API key exposed in client-side source

`frontend/js/auth.js:11`–19: `firebaseConfig` including `apiKey` is in plain client-side JavaScript. Firebase API keys are intended to be used this way, but the key should be restricted in the Firebase Console to specific HTTP referrers to prevent use from unauthorized domains.

### 7.4 Two Firebase service account credential files committed

`backend/firebase-service-account.json` and `backend/serviceAccountKey.json` both appear in the repository. If either represents an unused or revoked key that was committed, it is a credential exposure risk. Only one should exist and it should be in `.gitignore`.

---

*End of analysis — no code was modified.*
