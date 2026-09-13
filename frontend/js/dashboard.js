/**
 * Dashboard - Real-time Firebase Data Integration
 * Fetches blocks data from Firestore and displays farm-wide statistics
 */

'use strict';

(function () {

    // ═══════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════

    let blocksData = [];
    let latestScanData = null;
    let currentUser = null;
    let scanTrendData = [];
    let scanTrendsChart = null;

    // ═══════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════

    window.initPage = async function () {
        console.log('🚀 Initializing Dashboard...');

        // Check Firebase auth
        currentUser = auth.getCurrentUser();
        if (!currentUser) {
            console.warn('⚠️ No user logged in');
            window.location.href = '../auth/login.html';
            return;
        }

        await loadDashboardData();
    };

    // ═══════════════════════════════════════════════════════════
    // LOAD DATA FROM FIRESTORE
    // ═══════════════════════════════════════════════════════════

    async function loadDashboardData() {
        try {
            console.log('📊 Loading dashboard data from Firestore...');
            utils.showLoading('metrics-grid');

            // Fetch only this user's current blocks and historical scan records.
            // Sorting happens in the browser so this query does not need a composite index.
            const [blocksSnapshot, scansSnapshot] = await Promise.all([
                firebase.firestore()
                    .collection('blocks')
                    .where('userId', '==', currentUser.uid)
                    .get(),
                firebase.firestore()
                    .collection('scans')
                    .where('userId', '==', currentUser.uid)
                    .get()
            ]);

            blocksData = [];
            blocksSnapshot.forEach(doc => {
                const data = doc.data();
                blocksData.push({
                    id: doc.id,
                    name: data.name || `Block ${doc.id.substring(0, 6)}`,
                    section: data.section || 'N/A',
                    area: data.area || 0,
                    daf: data.daysAfterFlowering || data.daf || 0,
                    declaredPopulation: data.declaredPopulation || 0,
                    totalPineapples: data.totalPineapples || 0,
                    bearing: data.bearingPercent || 0,
                    nonBearing: data.nonBearingPercent || 0,
                    discolored: data.nonViable || 0,
                    lastScanned: data.lastScanned,
                    totalScans: data.totalScans || 0
                });
            });

            console.log(`✅ Loaded ${blocksData.length} blocks from Firestore`);

            scanTrendData = normaliseScanTrendRecords(scansSnapshot);
            console.log(`✅ Loaded ${scanTrendData.length} scan records for trends`);

            // Calculate farm totals
            calculateFarmTotals();

            // Render dashboard
            renderScanMeta();
            renderMetrics();
            renderBlocksTable();
            renderCharts();
            initialiseScanTrendsReport();

        } catch (error) {
            console.error('❌ Error loading dashboard data:', error);
            utils.showToast('Failed to load dashboard data', 'error');
        }
    }

    // ═══════════════════════════════════════════════════════════
    // CALCULATE FARM TOTALS
    // ═══════════════════════════════════════════════════════════

    function calculateFarmTotals() {
        if (blocksData.length === 0) {
            return {
                totalPlants: 0,
                totalDeclared: 0,
                avgBearing: 0,
                avgNonbearing: 0,
                avgDiscolored: 0,
                totalBlocks: 0
            };
        }

        const totalPlants = blocksData.reduce((sum, b) => sum + (b.totalPineapples || 0), 0);
        const totalDeclared = blocksData.reduce((sum, b) => sum + (b.declaredPopulation || 0), 0);

        // Weighted average by total pineapples
        let weightedBearing = 0;
        let weightedNonBearing = 0;
        let weightedDiscolored = 0;

        blocksData.forEach(block => {
            const weight = (block.totalPineapples || 0) / totalPlants;
            weightedBearing += (block.bearing || 0) * weight;
            weightedNonBearing += (block.nonBearing || 0) * weight;
            weightedDiscolored += (block.discolored || 0) * weight;
        });

        return {
            totalPlants,
            totalDeclared,
            avgBearing: weightedBearing,
            avgNonbearing: weightedNonBearing,
            avgDiscolored: weightedDiscolored,
            totalBlocks: blocksData.length
        };
    }

    // ═══════════════════════════════════════════════════════════
    // RENDER SCAN METADATA
    // ═══════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════
    // RENDER SCAN METADATA
    // ═══════════════════════════════════════════════════════════

    async function renderScanMeta() {
        const now = new Date();
        const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

        // Get current user
        const currentUser = auth.getCurrentUser();
        let userName = 'User';

        // Fetch full name from Firestore users collection
        if (currentUser && currentUser.uid) {
            try {
                const userDoc = await firebase.firestore()
                    .collection('users')
                    .doc(currentUser.uid)
                    .get();

                if (userDoc.exists) {
                    const userData = userDoc.data();
                    userName = userData.fullName || userData.displayName || currentUser.displayName || 'User';
                } else {
                    // Fallback to Firebase Auth display name
                    userName = currentUser.displayName || 'User';
                }
            } catch (error) {
                console.warn('Could not fetch user name:', error);
                userName = currentUser.displayName || 'User';
            }
        }

        const metaHTML = `
        <div class="scan-meta-item">
            <span class="scan-meta-label">Date:</span>
            <span class="scan-meta-value">${now.getDate().toString().padStart(2, '0')} ${months[now.getMonth()]} ${now.getFullYear()}</span>
        </div>
        <div class="scan-meta-item">
            <span class="scan-meta-label">Drone:</span>
            <span class="scan-meta-value">DJI Mavic 3 Multispectral</span>
        </div>
        <div class="scan-meta-item">
            <span class="scan-meta-label">Operator:</span>
            <span class="scan-meta-value">${userName}</span>
        </div>
        <div class="scan-meta-item">
            <span class="scan-meta-label">Blocks:</span>
            <span class="scan-meta-value">${blocksData.length} blocks</span>
        </div>
        <div class="scan-meta-item">
            <span class="scan-meta-label">Status:</span>
            <span class="scan-meta-value">Real-time</span>
        </div>
    `;

        const metaEl = document.getElementById('scan-meta');
        if (metaEl) metaEl.innerHTML = metaHTML;
    }

    // ═══════════════════════════════════════════════════════════
    // RENDER METRIC CARDS
    // ═══════════════════════════════════════════════════════════

    function renderMetrics() {
        const metricsEl = document.getElementById('metrics-grid');
        if (!metricsEl) return;

        if (blocksData.length === 0) {
            metricsEl.innerHTML = `
                <div style="width:100%;display:flex;align-items:center;justify-content:center;min-height:40vh;">
                    <div class="empty-state" style="display:flex;flex-direction:column;align-items:center;justify-content:center;max-width:380px;">
                        <div class="empty-state-icon" style="display:flex;align-items:center;justify-content:center;">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                        </div>
                        <div class="empty-state-title">No block data available</div>
                        <div class="empty-state-text">Farm metrics will appear here once block scan data has been recorded.</div>
                    </div>
                </div>
            `;
            return;
        }

        const totals = calculateFarmTotals();

        const metricsHTML = `
            ${buildMetricCard(
            'Total Plants',
            formatNumber(totals.totalPlants),
            `Declared: ${formatNumber(totals.totalDeclared)}`,
            ''
        )}
            ${buildMetricCard(
            'Bearing %',
            formatPercent(totals.avgBearing),
            'Farm-wide average',
            'green'
        )}
            ${buildMetricCard(
            'Non-bearing %',
            formatPercent(totals.avgNonbearing),
            'Farm-wide average',
            'amber'
        )}
            ${buildMetricCard(
            'Non-Viable %',
            formatPercent(totals.avgDiscolored),
            'Discoloration detected',
            'yellow'
        )}
        `;

        metricsEl.innerHTML = metricsHTML;
    }

    // ═══════════════════════════════════════════════════════════
    // RENDER BLOCKS TABLE
    // ═══════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════
    // RENDER BLOCKS TABLE
    // ═══════════════════════════════════════════════════════════

    function renderBlocksTable() {
        const tbody = document.getElementById('blocks-tbody');
        if (!tbody) return;

        let rowsHTML = '';

        blocksData.forEach((block, index) => {
            const statusClass = getStatusClass(block.bearing);
            const barColor = getBarColor(block.bearing);

            // Generate "Block 1", "Block 2", etc.
            const blockNumber = index + 1;
            const blockName = `Block ${blockNumber}`;

            rowsHTML += `
            <tr>
                <td><strong>${blockName}</strong></td>
                <td style="font-family: var(--font-mono);">${block.daf} days</td>
                <td>${block.section}</td>
                <td style="font-family: var(--font-mono);">${formatArea(block.area)}</td>
                <td style="font-family: var(--font-mono);">${formatNumber(block.declaredPopulation)}</td>
                <td>${buildInlineBar(block.bearing, barColor)}</td>
                <td style="font-family: var(--font-mono);">${formatPercent(block.discolored)}</td>
                <td>${buildStatusBadge(statusClass)}</td>
            </tr>
        `;
        });

        tbody.innerHTML = rowsHTML || '<tr><td colspan="8" style="text-align:center;padding:var(--space-xl);color:var(--color-text-secondary);">No blocks recorded yet.</td></tr>';
    }

    // ═══════════════════════════════════════════════════════════
    // RENDER CHARTS
    // ═══════════════════════════════════════════════════════════

    function renderCharts() {
        if (blocksData.length === 0) {
            const emptyHtml = `
                <div class="empty-state">
                    <div class="empty-state-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                    </div>
                    <div class="empty-state-title">No chart data available</div>
                    <div class="empty-state-text">Charts will appear once block scan data is available.</div>
                </div>`;
            const distCanvas = document.getElementById('bearing-distribution-chart');
            const blockCanvas = document.getElementById('bearing-by-block-chart');
            if (distCanvas) distCanvas.parentElement.innerHTML = emptyHtml;
            if (blockCanvas) blockCanvas.parentElement.innerHTML = emptyHtml;
            return;
        }

        const totals = calculateFarmTotals();
        const isDark = document.documentElement.classList.contains('dark-mode');
        const textClr = isDark ? '#a0a0a0' : '#666666';
        const gridClr = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
        const bgSurf = isDark ? '#212121' : '#ffffff';

        // Bearing Distribution Donut Chart
        renderBearingDistributionChart(totals, isDark, textClr, bgSurf);

        // Bearing Rate by Block Bar Chart
        renderBearingByBlockChart(isDark, textClr, gridClr, bgSurf);
    }

    function renderBearingDistributionChart(totals, isDark, textClr, bgSurf) {
        const discoOfBearing = totals.avgBearing * (totals.avgDiscolored / 100);
        const healthyBearing = totals.avgBearing - discoOfBearing;
        const nonBearing = totals.avgNonbearing;

        const donutData = [
            parseFloat(healthyBearing.toFixed(1)),
            parseFloat(discoOfBearing.toFixed(1)),
            parseFloat(nonBearing.toFixed(1))
        ];

        const centerLabelPlugin = {
            id: 'donutCenter',
            afterDraw(chart) {
                const { ctx, chartArea: { top, bottom, left, right } } = chart;
                const cx = (left + right) / 2;
                const cy = (top + bottom) / 2;
                const dark = document.documentElement.classList.contains('dark-mode');
                const green = dark ? '#4cbe7e' : '#2d6a3f';
                const muted = dark ? '#a0a0a0' : '#666666';

                ctx.save();
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                ctx.font = '700 26px Inter, sans-serif';
                ctx.fillStyle = green;
                ctx.fillText(totals.avgBearing.toFixed(1) + '%', cx, cy - 10);

                ctx.font = '600 11px Inter, sans-serif';
                ctx.fillStyle = muted;
                ctx.fillText('BEARING', cx, cy + 13);

                ctx.restore();
            }
        };

        const distCanvas = document.getElementById('bearing-distribution-chart');
        if (!distCanvas) return;

        const distCtx = distCanvas.getContext('2d');
        new Chart(distCtx, {
            type: 'doughnut',
            data: {
                labels: ['Bearing', 'Non-Viable', 'Non-Bearing'],
                datasets: [{
                    data: donutData,
                    backgroundColor: ['#4caf78', '#f0c430', '#e6a817'],
                    borderColor: bgSurf,
                    borderWidth: 3,
                    hoverOffset: 6
                }]
            },
            options: {
                responsive: true,
                cutout: '68%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            generateLabels(chart) {
                                const d = chart.data.datasets[0].data;
                                const bg = chart.data.datasets[0].backgroundColor;
                                return chart.data.labels.map((label, i) => ({
                                    text: `${label}  —  ${d[i].toFixed(1)}%`,
                                    fillStyle: bg[i],
                                    strokeStyle: bg[i],
                                    lineWidth: 0,
                                    hidden: !chart.getDataVisibility(i),
                                    index: i
                                }));
                            },
                            color: textClr,
                            boxWidth: 12,
                            boxHeight: 12,
                            padding: 18,
                            font: { family: 'Inter, sans-serif', size: 13 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: ctx => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}%`
                        }
                    }
                }
            },
            plugins: [centerLabelPlugin]
        });
    }

    function renderBearingByBlockChart(isDark, textClr, gridClr, bgSurf) {
        const barColors = blocksData.map(b =>
            b.bearing >= 75 ? '#4caf78'
                : b.bearing >= 60 ? '#e6a817'
                    : '#d94f4f'
        );

        const blockCanvas = document.getElementById('bearing-by-block-chart');
        if (!blockCanvas) return;

        const blockCtx = blockCanvas.getContext('2d');
        new Chart(blockCtx, {
            type: 'bar',
            data: {
                // CHANGED: Generate "Block 1", "Block 2", etc.
                labels: blocksData.map((b, index) => `Block ${index + 1}`),
                datasets: [{
                    label: 'Bearing %',
                    data: blocksData.map(b => b.bearing),
                    backgroundColor: barColors,
                    borderRadius: 4,
                    barThickness: 18
                }]
            },
            options: {
                responsive: true,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => ` ${ctx.parsed.x.toFixed(1)}%`
                        }
                    }
                },
                scales: {
                    x: {
                        min: 0,
                        max: 100,
                        grid: { color: gridClr },
                        ticks: {
                            color: textClr,
                            callback: v => v + '%',
                            font: { family: 'Inter, sans-serif', size: 12 }
                        }
                    },
                    y: {
                        grid: { display: false },
                        ticks: {
                            color: textClr,
                            font: { family: 'Inter, sans-serif', size: 12 }
                        }
                    }
                }
            }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // SCAN TRENDS REPORT
    // ═══════════════════════════════════════════════════════════

    function normaliseScanTrendRecords(scansSnapshot) {
        const timestampFields = ['startTime', 'scannedAt', 'timestamp', 'createdAt', 'lastScanned'];

        return scansSnapshot.docs.map(doc => {
            const scan = doc.data();
            const timestamp = timestampFields
                .map(field => scan[field])
                .find(value => value != null);
            const date = toJavaScriptDate(timestamp);
            const total = Number(scan.total || scan.totalPineapples || scan.detectedPlants || 0);

            if (!date || !total) return null;

            return {
                date,
                total,
                bearing: Number(scan.bearing || 0),
                nonBearing: Number(scan.nonBearing || 0),
                nonViable: Number(scan.nonViable || 0)
            };
        }).filter(Boolean).sort((a, b) => a.date - b.date);
    }

    function toJavaScriptDate(timestamp) {
        if (!timestamp) return null;
        if (typeof timestamp.toDate === 'function') return timestamp.toDate();
        if (timestamp instanceof Date) return timestamp;

        const date = new Date(timestamp);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function initialiseScanTrendsReport() {
        const trendTabs = document.querySelectorAll('[data-trend-period]');

        trendTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                trendTabs.forEach(item => {
                    const isSelected = item === tab;
                    item.classList.toggle('active', isSelected);
                    item.setAttribute('aria-selected', String(isSelected));
                });
                renderScanTrendsChart(tab.dataset.trendPeriod);
            });
        });

        renderScanTrendsChart('week');
    }

    function aggregateScanTrends(period) {
        const periods = new Map();

        scanTrendData.forEach(scan => {
            const key = getTrendPeriodKey(scan.date, period);
            if (!periods.has(key)) {
                periods.set(key, {
                    label: formatTrendPeriodLabel(scan.date, period),
                    total: 0,
                    bearing: 0,
                    nonBearing: 0,
                    nonViable: 0
                });
            }

            const bucket = periods.get(key);
            // Summing counts before dividing by total applies the same total-plant weighting
            // as calculateFarmTotals() to every scan in the selected period.
            bucket.total += scan.total;
            bucket.bearing += scan.bearing;
            bucket.nonBearing += scan.nonBearing;
            bucket.nonViable += scan.nonViable;
        });

        return [...periods.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, bucket]) => ({
            label: bucket.label,
            bearing: (bucket.bearing / bucket.total) * 100,
            nonBearing: (bucket.nonBearing / bucket.total) * 100,
            nonViable: (bucket.nonViable / bucket.total) * 100
        }));
    }

    function getTrendPeriodKey(date, period) {
        const year = date.getFullYear();
        if (period === 'year') return String(year);
        if (period === 'month') return `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;

        // ISO week key: weeks start Monday and the first week contains 4 January.
        const utcDate = new Date(Date.UTC(year, date.getMonth(), date.getDate()));
        const day = utcDate.getUTCDay() || 7;
        utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
        const weekYear = utcDate.getUTCFullYear();
        const yearStart = new Date(Date.UTC(weekYear, 0, 1));
        const week = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
        return `${weekYear}-W${String(week).padStart(2, '0')}`;
    }

    function formatTrendPeriodLabel(date, period) {
        if (period === 'year') return String(date.getFullYear());
        if (period === 'month') {
            return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
        }

        return `Week ${getTrendPeriodKey(date, 'week').slice(-2)}, ${getTrendPeriodKey(date, 'week').slice(0, 4)}`;
    }

    function renderScanTrendsChart(period) {
        const canvas = document.getElementById('scan-trends-chart');
        const emptyState = document.getElementById('scan-trends-empty');
        if (!canvas || !emptyState) return;

        const trends = aggregateScanTrends(period);
        canvas.hidden = trends.length === 0;
        emptyState.hidden = trends.length > 0;

        if (scanTrendsChart) {
            scanTrendsChart.destroy();
            scanTrendsChart = null;
        }
        if (trends.length === 0) return;

        const isDark = document.documentElement.classList.contains('dark-mode');
        const textClr = isDark ? '#a0a0a0' : '#666666';
        const gridClr = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';

        scanTrendsChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: trends.map(trend => trend.label),
                datasets: [
                    buildTrendDataset('Bearing %', trends.map(trend => trend.bearing), '#4caf78'),
                    buildTrendDataset('Non-Bearing %', trends.map(trend => trend.nonBearing), '#e6a817'),
                    buildTrendDataset('Non-Viable %', trends.map(trend => trend.nonViable), '#f0c430')
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { labels: { color: textClr, font: { family: 'Inter, sans-serif', size: 13 } } },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%` } }
                },
                scales: {
                    x: { grid: { color: gridClr }, ticks: { color: textClr, font: { family: 'Inter, sans-serif', size: 12 } } },
                    y: {
                        min: 0,
                        max: 100,
                        grid: { color: gridClr },
                        ticks: { color: textClr, callback: value => value + '%', font: { family: 'Inter, sans-serif', size: 12 } }
                    }
                }
            }
        });
    }

    function buildTrendDataset(label, values, color) {
        return {
            label,
            data: values,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.25
        };
    }

    // ═══════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    function buildMetricCard(title, value, subtitle, colorClass) {
        const mcClass = colorClass ? 'mc-' + colorClass : '';
        return `
        <div class="col">
            <div class="mcard ${mcClass}">
                <div class="mc-label">${title}</div>
                <div class="mc-val">${value}</div>
                <div class="mc-sub">${subtitle}</div>
            </div>
        </div>
    `;
    }

    function buildInlineBar(percent, color) {
        const width = Math.max(0, Math.min(100, percent));
        return `
            <div class="inline-bar-container">
                <div class="inline-bar" style="width: ${width}%; background-color: ${color};"></div>
                <span class="inline-bar-text">${percent.toFixed(1)}%</span>
            </div>
        `;
    }

    function buildStatusBadge(statusClass) {
        const labels = {
            healthy: 'Healthy',
            warning: 'At Risk',
            critical: 'Critical'
        };
        return `<span class="status-badge status-badge-${statusClass}">${labels[statusClass] || 'Unknown'}</span>`;
    }

    function getStatusClass(bearing) {
        if (bearing >= 75) return 'healthy';
        if (bearing >= 60) return 'warning';
        return 'critical';
    }

    function getBarColor(bearing) {
        if (bearing >= 75) return '#4caf78';
        if (bearing >= 60) return '#e6a817';
        return '#d94f4f';
    }

    function formatNumber(num) {
        return num.toLocaleString();
    }

    function formatPercent(num) {
        return num.toFixed(1) + '%';
    }

    function formatArea(area) {
        return area.toFixed(1) + ' ha';
    }

})();
