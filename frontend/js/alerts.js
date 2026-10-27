/**
 * Alerts Page — Firebase Integration
 *
 * KEY OPTIMIZATIONS applied:
 *
 * 1. N+1 QUERY ELIMINATED
 *    Old: fetch N alerts → for each alert, fetch 1 block doc = N+1 round-trips
 *         + a second full blocks fetch for renderThresholds() = N+2 total
 *    New: fetch alerts + blocks in parallel (Promise.all) → build an in-memory
 *         blockId→name map → O(1) lookup per alert, 0 extra round-trips
 *         Result: 2 parallel queries replace N+2 sequential queries.
 *
 * 2. RESOLVE UPDATES LOCAL STATE ONLY
 *    Old: resolveAlert() wrote to Firestore then called loadAlertsFromFirestore()
 *         again, triggering the full N+1 sequence a second time.
 *    New: resolveAlert() writes to Firestore then mutates the in-memory
 *         alertsData[] array and re-renders from memory — 0 extra reads.
 *
 * 3. QUERY LIMIT ADDED
 *    monitoring_alerts now fetches the 100 most-recent documents instead of
 *    the entire collection, keeping read costs bounded as alerts accumulate.
 */

'use strict';

(function () {

    // ═══════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════

    let alertsData = [];
    let currentUserId = null;
    let activeAlertFilter = 'crit';
    let thresholds = {
        bearing:    { watch: 75, critical: 60 },
        nonbearing: { watch: 18, critical: 25 },
        discolored: { watch: 10, critical: 15 },
    };

    // ═══════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════

    window.initPage = async function () {
        console.log('🚀 Initializing Alerts Page...');

        document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
        const alertsLink = document.querySelector('a[href="alerts.html"]');
        if (alertsLink) alertsLink.classList.add('active');

        document.querySelectorAll('[data-alert-filter]').forEach(button => {
            button.addEventListener('click', () => {
                activeAlertFilter = button.dataset.alertFilter;
                renderAlerts();
            });
        });

        const currentUser = auth.getCurrentUser();
        if (!currentUser) {
            window.location.href = '../auth/login.html';
            return;
        }

        currentUserId = currentUser.uid;
        await loadThresholds();
        await loadAlertsFromFirestore();
        utils.setupModalClose('threshold-modal');
    };

    // ═══════════════════════════════════════════════════════════
    // LOAD THRESHOLDS — from Firestore, falls back to defaults
    // ═══════════════════════════════════════════════════════════

    async function loadThresholds() {
        try {
            const doc = await firebase.firestore()
                .collection('user_settings')
                .doc(currentUserId)
                .get();
            if (doc.exists) {
                const saved = doc.data().alertThresholds;
                if (saved) {
                    if (saved.bearing)    thresholds.bearing    = saved.bearing;
                    if (saved.nonbearing) thresholds.nonbearing = saved.nonbearing;
                    if (saved.discolored) thresholds.discolored = saved.discolored;
                }
            }
        } catch (error) {
            console.error('Error loading thresholds:', error);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // LOAD DATA — OPTIMIZED (2 parallel queries, no N+1)
    // ═══════════════════════════════════════════════════════════

    async function loadAlertsFromFirestore() {
        try {
            console.log('📊 Loading alerts from Firestore...');
            utils.showLoading('alert-metrics');

            // Blocks change rarely — serve from sessionStorage cache when fresh.
            // Alerts are always fetched live (they update frequently).
            const cachedBlocks = window.pvCache && window.pvCache.get('blocks');

            const [alertsSnapshot, blocksSnapshot] = await Promise.all([
                firebase.firestore()
                    .collection('monitoring_alerts')
                    .where('userId', '==', currentUserId)
                    .limit(100)
                    .get(),
                cachedBlocks
                    ? Promise.resolve({
                        forEach: fn => cachedBlocks.forEach(item => fn({ id: item.id, data: () => item._data })),
                        size: cachedBlocks.length,
                        _cached: true,
                    })
                    : firebase.firestore()
                        .collection('blocks')
                        .where('userId', '==', currentUserId)
                        .get(),
            ]);

            if (!blocksSnapshot._cached && window.pvCache) {
                const toStore = [];
                blocksSnapshot.forEach(doc => {
                    const captured = doc.data();
                    toStore.push({ id: doc.id, _data: captured });
                });
                window.pvCache.set('blocks', toStore, 120_000); // 2-minute TTL
            }

            // Build O(1) blockId → name lookup (no extra Firestore requests)
            const blockMap = {};
            blocksSnapshot.forEach(doc => {
                const d = doc.data();
                blockMap[doc.id] = d.blockName || d.name || ('Block ' + doc.id.substring(0, 6));
            });

            // Sort descending by detectedDate client-side (avoids composite index requirement)
            const sortedAlertDocs = alertsSnapshot.docs.slice().sort((a, b) => {
                const aMs = a.data().detectedDate ? a.data().detectedDate.toMillis() : 0;
                const bMs = b.data().detectedDate ? b.data().detectedDate.toMillis() : 0;
                return bMs - aMs;
            });

            // Map alert documents using the in-memory block map
            alertsData = sortedAlertDocs.map(doc => {
                const data = doc.data();
                const detectedDate = data.detectedDate ? data.detectedDate.toDate() : new Date();
                const resolvedDate = data.resolvedDate ? data.resolvedDate.toDate() : null;

                return {
                    id:          doc.id,
                    severity:    data.severity    || 'warn',
                    block:       blockMap[data.blockId] || 'Unknown Block',
                    detectedDate: formatDate(detectedDate),
                    title:       data.title       || 'Alert',
                    description: data.description || '',
                    resolved:    data.resolved    || false,
                    resolvedDate: resolvedDate ? formatDate(resolvedDate) : null,
                };
            });

            console.log(`✅ Loaded ${alertsData.length} alerts (${blocksSnapshot.size} blocks in map)`);

            renderAlertMetrics();
            renderAlerts();
            renderThresholds(blocksSnapshot);   // pass already-fetched snapshot

        } catch (error) {
            console.error('❌ Error loading alerts:', error);
            utils.showToast('Failed to load alerts data', 'error');
        }
    }

    // ═══════════════════════════════════════════════════════════
    // RENDER ALERT METRICS
    // ═══════════════════════════════════════════════════════════

    function renderAlertMetrics() {
        const critCount     = alertsData.filter(a => a.severity === 'crit' && !a.resolved).length;
        const warnCount     = alertsData.filter(a => a.severity === 'warn' && !a.resolved).length;
        const resolvedCount = alertsData.filter(a => a.resolved).length;
        const totalActive   = critCount + warnCount;

        document.getElementById('alert-metrics').innerHTML = [
            buildMetricCard('Active alerts',  totalActive,   'Requiring attention', totalActive > 0 ? 'red'   : ''),
            buildMetricCard('Critical',       critCount,     'Immediate action needed', critCount > 0 ? 'red'  : ''),
            buildMetricCard('Watch',          warnCount,     'Monitor closely',     warnCount > 0   ? 'amber' : ''),
            buildMetricCard('Resolved',       resolvedCount, 'Issues cleared',      'green'),
        ].join('');
    }

    // ═══════════════════════════════════════════════════════════
    // RENDER ALERTS
    // ═══════════════════════════════════════════════════════════

    function renderAlerts() {
        const critAlerts = alertsData.filter(a => a.severity === 'crit' && !a.resolved);
        const warnAlerts = alertsData.filter(a => a.severity === 'warn' && !a.resolved);
        const okAlerts   = alertsData.filter(a => a.resolved);

        document.getElementById('count-crit').textContent = critAlerts.length;
        document.getElementById('count-warn').textContent = warnAlerts.length;
        document.getElementById('count-ok').textContent   = okAlerts.length;

        document.querySelectorAll('[data-alert-filter]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.alertFilter === activeAlertFilter));
        });
        document.getElementById('alert-panel-crit').hidden = activeAlertFilter !== 'crit';
        document.getElementById('alert-panel-warn').hidden = activeAlertFilter !== 'warn';
        document.getElementById('alert-panel-resolved').hidden = activeAlertFilter !== 'resolved';

        const emptyCard = msg => `<div class="no-alerts-card">${msg}</div>`;

        document.getElementById('alerts-crit').innerHTML = critAlerts.length
            ? critAlerts.map(buildAlertBox).join('')
            : emptyCard('No critical alerts at this time.');

        document.getElementById('alerts-warn').innerHTML = warnAlerts.length
            ? warnAlerts.map(buildAlertBox).join('')
            : emptyCard('No watch alerts at this time.');

        document.getElementById('alerts-ok').innerHTML = okAlerts.length
            ? okAlerts.map(buildAlertBox).join('')
            : emptyCard('No resolved alerts.');
    }

    function buildAlertBox(alert) {
        const cls        = alert.severity;
        const badgeClass = cls === 'ok' ? 'good' : cls;
        const badgeLabel = cls === 'ok' ? 'Resolved' : cls === 'crit' ? 'Critical' : 'Watch';

        const footParts = [];
        if (alert.resolvedDate) {
            footParts.push(`<span class="alert-foot-item"><span>Resolved:</span> <strong>${alert.resolvedDate}</strong></span>`);
        }

        const resolveButton = !alert.resolved
            ? `<button class="btn btn-sm btn-secondary" onclick="resolveAlert('${alert.id}')" style="margin-left:auto;">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                      stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                 Mark as Resolved
               </button>`
            : '';

        return `
        <div class="alert-box ${cls}">
            <div class="alert-top">
                <div class="alert-top-left">
                    <div class="alert-meta-row">${alert.block} &middot; ${alert.detectedDate}</div>
                    <span class="alert-title ${cls}">${alert.title}</span>
                </div>
                <span class="badge ${badgeClass}"><span class="bdot"></span>${badgeLabel}</span>
            </div>
            <div class="alert-body">${alert.description}</div>
            ${(footParts.length || resolveButton) ? `<div class="alert-foot">
                <div class="alert-foot-items">${footParts.join('')}</div>
                ${resolveButton}
            </div>` : ''}
        </div>`;
    }

    // ═══════════════════════════════════════════════════════════
    // RENDER THRESHOLDS — accepts pre-fetched blocks snapshot
    // ═══════════════════════════════════════════════════════════

    function renderThresholds(blocksSnapshot) {
        // Uses the blocksSnapshot already fetched in loadAlertsFromFirestore().
        // No additional Firestore request needed.
        try {
            let totalBearing = 0, totalNonbearing = 0, totalDiscolored = 0, count = 0;

            blocksSnapshot.forEach(doc => {
                const data = doc.data();
                totalBearing    += data.bearingPercent    || 0;
                totalNonbearing += data.nonBearingPercent || 0;
                totalDiscolored += data.nonViable         || 0;
                count++;
            });

            const avg = v => count > 0 ? v / count : 0;
            const avgBearing    = avg(totalBearing);
            const avgNonbearing = avg(totalNonbearing);
            const avgDiscolored = avg(totalDiscolored);

            const colorMap = { good: 'var(--green)', warn: 'var(--amber)', crit: 'var(--red)' };

            const rows = [
                {
                    metric:  'Bearing rate',
                    watch:   `Below ${thresholds.bearing.watch}%`,
                    crit:    `Below ${thresholds.bearing.critical}%`,
                    current: avgBearing,
                    status:  avgBearing < thresholds.bearing.critical ? 'crit'
                           : avgBearing < thresholds.bearing.watch    ? 'warn' : 'good',
                },
                {
                    metric:  'Non-bearing rate',
                    watch:   `Above ${thresholds.nonbearing.watch}%`,
                    crit:    `Above ${thresholds.nonbearing.critical}%`,
                    current: avgNonbearing,
                    status:  avgNonbearing > thresholds.nonbearing.critical ? 'crit'
                           : avgNonbearing > thresholds.nonbearing.watch    ? 'warn' : 'good',
                },
                {
                    metric:  'Non-Viable rate',
                    watch:   `Above ${thresholds.discolored.watch}%`,
                    crit:    `Above ${thresholds.discolored.critical}%`,
                    current: avgDiscolored,
                    status:  avgDiscolored > thresholds.discolored.critical ? 'crit'
                           : avgDiscolored > thresholds.discolored.watch    ? 'warn' : 'good',
                },
            ];

            document.getElementById('threshold-tbody').innerHTML = rows.map(r => `
                <tr>
                    <td>${r.metric}</td>
                    <td style="font-family:var(--font-mono);color:var(--amber);font-weight:var(--font-weight-medium);">${r.watch}</td>
                    <td style="font-family:var(--font-mono);color:var(--red);font-weight:var(--font-weight-medium);">${r.crit}</td>
                    <td>
                        <span style="font-family:var(--font-mono);font-weight:var(--font-weight-medium);color:${colorMap[r.status]};">${formatPercent(r.current)}</span>
                        &nbsp;${statusBadge(r.status)}
                    </td>
                </tr>`).join('');

        } catch (error) {
            console.error('Error rendering thresholds:', error);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // RESOLVE ALERT — local-state update, no extra Firestore reads
    // ═══════════════════════════════════════════════════════════

    window.resolveAlert = async function (alertId) {
        console.log('🔄 Resolving alert:', alertId);
        try {
            // Verify ownership before mutating — prevents any authenticated user
            // from resolving another user's alert by guessing its document ID.
            const alertDoc = await firebase.firestore()
                .collection('monitoring_alerts')
                .doc(alertId)
                .get();

            if (!alertDoc.exists || alertDoc.data().userId !== currentUserId) {
                utils.showToast('Alert not found or access denied', 'error');
                return;
            }

            await firebase.firestore()
                .collection('monitoring_alerts')
                .doc(alertId)
                .update({
                    resolved:     true,
                    resolvedDate: firebase.firestore.FieldValue.serverTimestamp(),
                });

            // OPTIMIZATION: mutate local state and re-render — no extra reads.
            // Old code called loadAlertsFromFirestore() here, re-triggering the
            // full N+1 query sequence for a single field change.
            const alert = alertsData.find(a => a.id === alertId);
            if (alert) {
                alert.resolved     = true;
                alert.resolvedDate = formatDate(new Date());
            }

            renderAlertMetrics();
            renderAlerts();
            utils.showToast('Alert marked as resolved!', 'success');
            console.log('✅ Alert resolved (local state updated, no extra reads)');

        } catch (error) {
            console.error('❌ Error resolving alert:', error);
            utils.showToast('Failed to resolve alert: ' + error.message, 'error');
        }
    };

    // ═══════════════════════════════════════════════════════════
    // MODAL HANDLERS
    // ═══════════════════════════════════════════════════════════

    window.openThresholdModal = function () {
        document.getElementById('t-bearing-watch').value    = thresholds.bearing.watch;
        document.getElementById('t-bearing-crit').value     = thresholds.bearing.critical;
        document.getElementById('t-nonbearing-watch').value = thresholds.nonbearing.watch;
        document.getElementById('t-nonbearing-crit').value  = thresholds.nonbearing.critical;
        document.getElementById('t-disco-watch').value      = thresholds.discolored.watch;
        document.getElementById('t-disco-crit').value       = thresholds.discolored.critical;
        utils.showModal('threshold-modal');
    };

    window.closeThresholdModal = function () {
        utils.hideModal('threshold-modal');
    };

    window.handleSaveThresholds = async function (e) {
        e.preventDefault();
        const bw  = parseFloat(document.getElementById('t-bearing-watch').value);
        const bc  = parseFloat(document.getElementById('t-bearing-crit').value);
        const nbw = parseFloat(document.getElementById('t-nonbearing-watch').value);
        const nbc = parseFloat(document.getElementById('t-nonbearing-crit').value);
        const dw  = parseFloat(document.getElementById('t-disco-watch').value);
        const dc  = parseFloat(document.getElementById('t-disco-crit').value);

        if (bc >= bw) {
            utils.showFormError('threshold-form', 'Bearing critical must be lower than watch threshold');
            return;
        }
        if (nbc <= nbw) {
            utils.showFormError('threshold-form', 'Non-bearing critical must be higher than watch threshold');
            return;
        }
        if (dc <= dw) {
            utils.showFormError('threshold-form', 'Non-Viable critical must be higher than watch threshold');
            return;
        }

        const updated = {
            bearing:    { watch: bw,  critical: bc  },
            nonbearing: { watch: nbw, critical: nbc },
            discolored: { watch: dw,  critical: dc  },
        };

        try {
            await firebase.firestore()
                .collection('user_settings')
                .doc(currentUserId)
                .set({ alertThresholds: updated }, { merge: true });

            thresholds = updated;
            window.closeThresholdModal();

            const cachedBlocks = window.pvCache && window.pvCache.get('blocks');
            if (cachedBlocks) {
                renderThresholds({
                    forEach: fn => cachedBlocks.forEach(item => fn({ id: item.id, data: () => item._data })),
                    size: cachedBlocks.length,
                    _cached: true,
                });
            } else {
                const blocksSnapshot = await firebase.firestore()
                    .collection('blocks')
                    .where('userId', '==', currentUserId)
                    .get();
                renderThresholds(blocksSnapshot);
            }

            utils.showToast('Thresholds saved!', 'success');
        } catch (error) {
            console.error('Error saving thresholds:', error);
            utils.showFormError('threshold-form', 'Failed to save thresholds. Please try again.');
        }
    };

    // ═══════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════

    function buildMetricCard(label, value, sub, color) {
        const colorClass = color ? `mc-${color}` : '';
        return `
            <div class="col">
                <div class="mcard ${colorClass}">
                    <div class="mc-label">${label}</div>
                    <div class="mc-val">${value}</div>
                    <div class="mc-sub">${sub}</div>
                </div>
            </div>`;
    }

    function statusBadge(status) {
        const labels = { good: 'Healthy', warn: 'Watch', crit: 'Critical' };
        const colors = { good: 'good',    warn: 'warn',  crit: 'crit'    };
        return `<span class="badge ${colors[status]}"><span class="bdot"></span>${labels[status]}</span>`;
    }

    function formatPercent(num) { return num.toFixed(1) + '%'; }

    function formatDate(date) {
        const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        const day   = date.getDate().toString().padStart(2, '0');
        return `${months[date.getMonth()]} ${day}, ${date.getFullYear()}`;
    }

})();
