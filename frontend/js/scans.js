/**
 * Scans Page - Real-time Firebase Data Integration
 * Fetches scan history from Firestore scans collection
 */

'use strict';

(function () {

    // ═══════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════

    let scansData = [];
    let currentUserId = null;

    // Pagination — 5 scan entries per page (data/retrieval logic untouched;
    // this only controls how many already-loaded entries are shown at once).
    const SCANS_PAGE_SIZE = 5;
    let currentScansPage = 1;

    // ═══════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════

    window.initPage = async function () {
        console.log('🚀 Initializing Scans Page...');

        // Check Firebase auth
        const currentUser = auth.getCurrentUser();
        if (!currentUser) {
            console.warn('⚠️ No user logged in');
            window.location.href = '/index.html';
            return;
        }

        currentUserId = currentUser.uid;
        await loadScansData();
    };

    // ═══════════════════════════════════════════════════════════
    // LOAD DATA FROM FIRESTORE
    // ═══════════════════════════════════════════════════════════

    async function loadScansData() {
        try {
            console.log('📊 Loading scans data from Firestore...');
            utils.showLoading('scan-list');

            // First, fetch this user's blocks to create a mapping
            const blocksSnapshot = await firebase.firestore()
                .collection('blocks')
                .where('userId', '==', currentUserId)
                .get();

            // Resolve scan block IDs to the name shown in the block records.
            const blockIdToName = {};
            let blockIndex = 1;
            blocksSnapshot.forEach((doc) => {
                const blockData = doc.data() || {};
                blockIdToName[doc.id] = blockData.blockName || blockData.blockId || `Block ${blockIndex}`;
                console.log(`Block mapping: ${doc.id} -> ${blockIdToName[doc.id]}`);
                blockIndex++;
            });

            console.log('All block IDs:', Object.keys(blockIdToName));

            // Fetch only this user's scans, ordered by startTime descending (newest first)
            const scansSnapshot = await firebase.firestore()
                .collection('scans')
                .where('userId', '==', currentUserId)
                .orderBy('startTime', 'desc')
                .get();

            scansData = [];

            for (const doc of scansSnapshot.docs) {
                const data = doc.data();

                console.log(`Scan blockId: "${data.blockId}"`);
                console.log(`Is in mapping? ${!!blockIdToName[data.blockId]}`);

                // Get block name using the mapping
                let blockName = 'Unknown Block';
                if (data.blockId && blockIdToName[data.blockId]) {
                    blockName = blockIdToName[data.blockId];
                }

                console.log(`Final blockName: ${blockName}`);

                // Get user name if userId exists
                let operatorName = 'Unknown Field Operator';
                if (data.userId) {
                    try {
                        const userDoc = await firebase.firestore()
                            .collection('users')
                            .doc(data.userId)
                            .get();
                        if (userDoc.exists) {
                            operatorName = userDoc.data().fullName || userDoc.data().displayName || 'Field Operator';
                        }
                    } catch (err) {
                        console.warn('Could not fetch user name:', err);
                    }
                }

                // Calculate duration
                let duration = 'N/A';
                const start = data.startTime && typeof data.startTime.toDate === 'function' ? data.startTime.toDate() : null;
                const end = data.endTime && typeof data.endTime.toDate === 'function' ? data.endTime.toDate() : null;
                if (start && end && end >= start) {
                    const diffMs = end - start;
                    const hours = Math.floor(diffMs / 3600000);
                    const minutes = Math.floor((diffMs % 3600000) / 60000);
                    duration = `${hours}h ${minutes}m`;
                }

                // Parse date
                const scanDate = start && Number.isFinite(start.getTime()) ? start : null;
                const scanCounts = {
                    bearing: scanCount(data, 'bearing'),
                    nonBearing: scanCount(data, 'nonBearing'),
                    nonViable: scanCount(data, 'nonViable'),
                };
                const plantTotal = scanCounts.bearing !== null && scanCounts.nonBearing !== null
                    ? scanCounts.bearing + scanCounts.nonBearing
                    : null;
                const status = data.status || 'completed';

                scansData.push({
                    id: doc.id,
                    title: scanDate
                        ? `Block Scan - ${scanDate.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })}`
                        : 'Block Scan - Date unavailable',
                    scanDate: scanDate,
                    bearing: scanCounts.bearing,
                    nonBearing: scanCounts.nonBearing,
                    nonViable: scanCounts.nonViable,
                    total: plantTotal,
                    operator: operatorName,
                    drone: 'DJI Mavic 3 Multispectral',
                    time: scanDate ? scanDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : 'Unavailable',
                    duration: duration,
                    status: status,
                    blockId: data.blockId,
                    blockName: blockName
                });
            }

            console.log(`✅ Loaded ${scansData.length} scans from Firestore`);

            // Render page (reset to first page on a fresh data load)
            currentScansPage = 1;
            renderScanMetrics();
            renderScanList();

        } catch (error) {
            console.error('❌ Error loading scans data:', error);
            utils.showToast('Failed to load scans data', 'error');
        }
    }

    // ═══════════════════════════════════════════════════════════
    // RENDER SCAN METRICS
    // ═══════════════════════════════════════════════════════════

    function renderScanMetrics() {
        if (scansData.length === 0) {
            document.getElementById('scan-metrics').innerHTML = `
                <div class="col-12">
                    <p style="color: var(--muted); text-align: center;">No scans yet</p>
                </div>
            `;
            return;
        }

        const latest = scansData.find((scan) =>
            scan.status === 'completed' && scan.bearing !== null && scan.nonBearing !== null
        );
        const latestDate = latest && latest.scanDate
            ? `Latest completed scan · ${latest.scanDate.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })}`
            : 'No completed scan';
        const plantTotal = latest ? latest.bearing + latest.nonBearing : null;
        const bearingPercent = plantTotal > 0 ? latest.bearing / plantTotal * 100 : null;
        const nonBearingPercent = plantTotal > 0 ? latest.nonBearing / plantTotal * 100 : null;
        const nonViablePercent = plantTotal > 0 && latest.nonViable !== null ? latest.nonViable / plantTotal * 100 : null;

        const metricsHTML = `
            ${buildMetricCard(
            'Total Sessions',
            scansData.length,
            'All drone operations',
            ''
        )}
            ${buildMetricCard(
            'Latest Bearing',
            formatPercent(bearingPercent),
            latestDate,
            'green'
        )}
            ${buildMetricCard(
            'Latest Non-Bearing',
            formatPercent(nonBearingPercent),
            latestDate,
            'amber'
        )}
            ${buildMetricCard(
            'Latest Non-Viable',
            formatPercent(nonViablePercent),
            latestDate,
            'yellow'
        )}
        `;

        document.getElementById('scan-metrics').innerHTML = metricsHTML;
    }

    // ═══════════════════════════════════════════════════════════
    // RENDER SCAN LIST
    // ═══════════════════════════════════════════════════════════

    function renderScanList() {
        const listEl = document.getElementById('scan-list');

        if (scansData.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📋</div>
                    <div class="empty-state-title">No scans recorded</div>
                    <div class="empty-state-text">Drone scan sessions will appear here after operations are logged.</div>
                </div>
            `;
            renderScanPagination(0);
            return;
        }

        const totalPages = Math.max(1, Math.ceil(scansData.length / SCANS_PAGE_SIZE));
        if (currentScansPage > totalPages) currentScansPage = totalPages;
        if (currentScansPage < 1) currentScansPage = 1;

        const start = (currentScansPage - 1) * SCANS_PAGE_SIZE;
        const pageItems = scansData.slice(start, start + SCANS_PAGE_SIZE);

        listEl.innerHTML = pageItems.map(buildScanEntry).join('');
        renderScanPagination(totalPages);
    }

    // ═══════════════════════════════════════════════════════════
    // PAGINATION (client-side over already-loaded scansData —
    // does not re-fetch or alter the Firestore data source)
    // ═══════════════════════════════════════════════════════════

    function changeScansPage(page) {
        const totalPages = Math.max(1, Math.ceil(scansData.length / SCANS_PAGE_SIZE));
        if (page < 1 || page > totalPages || page === currentScansPage) return;
        currentScansPage = page;
        renderScanList();
    }
    // Exposed for the inline onclick handlers rendered in renderScanPagination().
    window.scansChangePage = changeScansPage;

    function renderScanPagination(totalPages) {
        const el = document.getElementById('scan-pagination');
        if (!el) return;

        if (!totalPages || totalPages < 1) {
            el.innerHTML = '';
            return;
        }

        const prevDisabled = currentScansPage <= 1;
        const nextDisabled = currentScansPage >= totalPages;

        const numbersHTML = getPageWindow(currentScansPage, totalPages)
            .map(function (p) {
                if (p === '...') {
                    return '<span class="page-ellipsis">&hellip;</span>';
                }
                const activeClass = p === currentScansPage ? ' active' : '';
                const current = p === currentScansPage ? ' aria-current="page"' : '';
                return `<button type="button" class="page-num-btn${activeClass}" onclick="scansChangePage(${p})"${current}>${p}</button>`;
            })
            .join('');

        el.innerHTML = `
            <button type="button" class="page-nav-btn" onclick="scansChangePage(${currentScansPage - 1})" ${prevDisabled ? 'disabled' : ''} aria-label="Previous page">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            ${numbersHTML}
            <button type="button" class="page-nav-btn" onclick="scansChangePage(${currentScansPage + 1})" ${nextDisabled ? 'disabled' : ''} aria-label="Next page">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
        `;
    }

    // Returns the set of page numbers/ellipses to render, e.g. [1,'...',4,5,6,'...',12]
    function getPageWindow(current, total) {
        if (total <= 5) {
            return Array.from({ length: total }, function (_, i) { return i + 1; });
        }
        const pages = [1];
        if (current > 3) pages.push('...');
        const start = Math.max(2, current - 1);
        const end = Math.min(total - 1, current + 1);
        for (let p = start; p <= end; p++) pages.push(p);
        if (current < total - 2) pages.push('...');
        pages.push(total);
        return pages;
    }

    function buildScanEntry(scan) {
        const denominator = scan.total;
        const bearingPercent = denominator > 0 && scan.bearing !== null ? scan.bearing / denominator * 100 : null;
        const nonBearingPercent = denominator > 0 && scan.nonBearing !== null ? scan.nonBearing / denominator * 100 : null;
        const nonViablePercent = denominator > 0 && scan.nonViable !== null ? scan.nonViable / denominator * 100 : null;

        return `
        <div class="scan-entry">
            <div class="sinfo">
                <div class="sinfo-title">${scan.title}</div>
                <div class="spills">
                    <span class="badge good">
                        <span class="bdot"></span>
                        Bearing: <span class="spill-value">${formatPercent(bearingPercent)}</span>
                    </span>
                    <span class="badge warn">
                        <span class="bdot"></span>
                        Non-bearing: <span class="spill-value">${formatPercent(nonBearingPercent)}</span>
                    </span>
                    <span class="badge yellow">
                        <span class="bdot"></span>
                        Non-Viable: <span class="spill-value">${formatPercent(nonViablePercent)}</span>
                    </span>
                </div>
                <div class="sstats">
                    <span>Estimated Plants: <strong>${scan.total === null ? 'Unavailable' : formatNumber(scan.total)}</strong></span>
                    <span>Field Operator: ${scan.operator}</span>
                    <span>Timestamp: <strong>${scan.time}</strong></span>
                    <span>Duration: <strong>${scan.duration}</strong></span>
                    <span>Block Name: <strong>${scan.blockName || 'N/A'}</strong></span>
                </div>
            </div>
        </div>
    `;
    }

    // ═══════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    function buildMetricCard(title, value, subtitle, colorClass) {
        const colorSuffix = colorClass ? `mc-${colorClass}` : '';
        return `
        <div class="col">
            <div class="mcard ${colorSuffix}">
                <div class="mc-label">${title}</div>
                <div class="mc-val">${value}</div>
                <div class="mc-sub">${subtitle}</div>
            </div>
        </div>
    `;
    }

    function formatPercent(num) {
        return Number.isFinite(num) ? num.toFixed(1) + '%' : 'Unavailable';
    }

    function formatNumber(num) {
        return Number.isFinite(num) ? num.toLocaleString() : 'Unavailable';
    }

    function scanCount(data, key) {
        if (!data || data[key] == null || data[key] === '') return null;
        const count = Number(data[key]);
        return Number.isSafeInteger(count) && count >= 0 ? count : null;
    }

})();

