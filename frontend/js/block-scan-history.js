/* Shared read-only scan history and Excel-compatible export. */
window.blockScanHistory = (function () {
    'use strict';

    const cache = new Map();

    function load(blockId, userId, refresh) {
        if (!blockId || !userId) return Promise.reject(new Error('Missing block or account context'));
        const key = JSON.stringify([blockId, userId]);
        if (refresh || !cache.has(key)) {
            const pending = firebase.firestore().collection('scans')
                .where('blockId', '==', blockId)
                .where('userId', '==', userId)
                .get()
                .then(function (snapshot) {
                    const history = [];
                    snapshot.forEach(function (doc) {
                        const data = doc.data();
                        // Keep dated records from every lifecycle state in history. Only
                        // completed scans expose final classification counts below.
                        const date = data.startTime && typeof data.startTime.toDate === 'function'
                            ? data.startTime.toDate() : null;
                        if (!date || !Number.isFinite(date.getTime())) return;
                        const total = metric(data, 'total');
                        const bearing = metric(data, 'bearing');
                        history.push({
                            id: doc.id,
                            date: date,
                            pct: total !== null && total > 0 && bearing !== null ? (bearing / total) * 100 : null,
                            data: data,
                        });
                    });
                    return history.sort(function (a, b) { return a.date - b.date; });
                });
            cache.set(key, pending);
            pending.catch(function () {
                if (cache.get(key) === pending) cache.delete(key);
            });
        }
        return cache.get(key);
    }

    function csvCell(value) {
        let text = value == null ? '' : String(value);
        // Treat spreadsheet formula prefixes as text, including after whitespace.
        if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
    }

    function metric(data, key) {
        if (!data || data[key] == null || data[key] === '') return null;
        const value = Number(data[key]);
        return Number.isFinite(value) ? value : null;
    }

    function scanStartDate(data) {
        const value = data && data.startTime;
        const date = value && typeof value.toDate === 'function'
            ? value.toDate()
            : value instanceof Date ? value : null;
        return date && Number.isFinite(date.getTime()) ? date : null;
    }

    function completedPlantCount(data) {
        if (!data || (data.status != null && data.status !== 'completed')) return null;
        const date = scanStartDate(data);
        const bearing = metric(data, 'bearing');
        const nonBearing = metric(data, 'nonBearing');
        if (!date || !Number.isSafeInteger(bearing) || bearing < 0 ||
            !Number.isSafeInteger(nonBearing) || nonBearing < 0) return null;
        return { date: date, count: bearing + nonBearing };
    }

    async function loadLatestPlantCounts(blockIds, userId) {
        const ids = new Set((blockIds || []).filter(Boolean).map(String));
        if (!ids.size) return new Map();

        const scans = firebase.firestore().collection('scans');
        const snapshots = await Promise.all(Array.from(ids, function (blockId) {
            let query = scans.where('blockId', '==', blockId);
            if (userId) query = query.where('userId', '==', userId);
            return query.get();
        }));
        return latestPlantCountsFromSnapshots(Array.from(ids), snapshots, userId);
    }

    function latestPlantCountsFromSnapshots(blockIds, snapshots, userId) {
        const ids = new Set((blockIds || []).filter(Boolean).map(String));
        const latest = new Map();
        if (!ids.size) return latest;
        snapshots.forEach(function (snapshot) {
            snapshot.forEach(function (doc) {
                const data = doc.data() || {};
                const blockId = data.blockId == null ? '' : String(data.blockId);
                if (!ids.has(blockId) || (userId && data.userId !== userId)) return;
                const result = completedPlantCount(data);
                if (!result) return;
                const previous = latest.get(blockId);
                if (!previous || result.date > previous.date) latest.set(blockId, result);
            });
        });
        return new Map(Array.from(latest, function (entry) {
            return [entry[0], entry[1].count];
        }));
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
        });
    }

    function formatCount(value) {
        return value == null ? 'Unavailable' : Math.round(value).toLocaleString('en-US');
    }

    function formatPercent(value, total) {
        return value == null || total == null || total <= 0 ? null : ((value / total) * 100).toFixed(1) + '%';
    }

    function formatDateTime(date) {
        return date.toLocaleString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
        });
    }

    function formatElapsed(start, end) {
        if (!start || !end || end < start) return null;
        const seconds = Math.round((end - start) / 1000);
        if (seconds < 60) return seconds + ' sec';
        const minutes = Math.floor(seconds / 60);
        const remainder = seconds % 60;
        return minutes + ' min' + (remainder ? ' ' + remainder + ' sec' : '');
    }

    function getStatus(data) {
        if (data.status == null || data.status === 'completed') return 'Completed';
        if (data.status === 'active') return 'Processing';
        if (data.status === 'failed') return 'Failed';
        if (data.status === 'cancelled') return 'Cancelled';
        return 'Unknown';
    }

    function comparisonMarkup(entry, previous) {
        if (!previous || getStatus(entry.data) !== 'Completed') return '';
        const currentTotal = metric(entry.data, 'total');
        const previousTotal = metric(previous.data, 'total');
        if (currentTotal === null || previousTotal === null) return '';
        const difference = Math.round(currentTotal - previousTotal);
        const direction = difference > 0 ? '+' : '';
        const elapsedDays = Math.max(0, Math.floor((entry.date - previous.date) / 86400000));
        return `<p class="scan-history-comparison">${direction}${difference.toLocaleString('en-US')} detections vs previous completed scan (${escapeHtml(formatDateTime(previous.date))}) · ${elapsedDays} days between scans</p>`;
    }

    function detailMarkup(entry) {
        const data = entry.data;
        const end = data.endTime && typeof data.endTime.toDate === 'function' ? data.endTime.toDate() : null;
        const details = [['Scan ID', entry.id]];
        const elapsed = formatElapsed(entry.date, end);
        if (elapsed) details.push(['Elapsed scan time', elapsed]);
        const coverage = metric(data, 'detectionCoverage');
        if (coverage !== null) details.push(['Detection coverage', coverage.toFixed(2) + '%']);
        const registered = metric(data, 'registeredPopulation');
        if (registered !== null) details.push(['Registered population', formatCount(registered)]);
        const processed = metric(data, 'processedFrames');
        const frames = metric(data, 'totalFrames');
        if (processed !== null || frames !== null) {
            details.push(['Frames processed', (processed === null ? 'Unavailable' : formatCount(processed)) + ' / ' + (frames === null ? 'Unavailable' : formatCount(frames))]);
        }
        const estimatedBearing = metric(data, 'estimatedBearing');
        const estimatedNonBearing = metric(data, 'estimatedNonBearing');
        if (estimatedBearing !== null) details.push(['Estimated bearing plants', formatCount(estimatedBearing)]);
        if (estimatedNonBearing !== null) details.push(['Estimated non-bearing plants', formatCount(estimatedNonBearing)]);
        return `<details class="scan-history-details"><summary>View scan details</summary><dl>${details.map(function (item) {
            return `<div><dt>${escapeHtml(item[0])}</dt><dd>${escapeHtml(item[1])}</dd></div>`;
        }).join('')}</dl></details>`;
    }

    function scanMarkup(entry, previous) {
        const data = entry.data;
        const status = getStatus(data);
        const complete = status === 'Completed';
        const total = complete ? metric(data, 'total') : null;
        const classes = [
            ['Bearing', 'bearing'],
            ['Non-bearing', 'nonBearing'],
            ['Non-viable', 'nonViable'],
        ].map(function (item) {
            const count = complete ? metric(data, item[1]) : null;
            if (count === null) return '';
            const percent = formatPercent(count, total);
            return `<div class="scan-history-class"><span>${item[0]}</span><strong>${formatCount(count)}</strong><small>${percent || 'Percentage unavailable'}</small></div>`;
        }).join('');
        const latestCount = total === null ? '<span class="scan-history-total-unavailable">Final counts unavailable</span>' :
            `<div class="scan-history-total"><strong>${formatCount(total)}</strong><span>plants detected</span></div>`;
        return `<article class="scan-history-entry">
            <div class="scan-history-entry-head"><time datetime="${entry.date.toISOString()}">${escapeHtml(formatDateTime(entry.date))}</time><span class="scan-history-status ${complete ? 'is-complete' : status === 'Failed' ? 'is-failed' : ''}">${status}</span></div>
            ${latestCount}
            ${classes ? `<div class="scan-history-breakdown" aria-label="Plant classification counts">${classes}</div>` : ''}
            ${comparisonMarkup(entry, previous)}
            ${detailMarkup(entry)}
        </article>`;
    }

    function render(history, container, block) {
        const ordered = history.slice().sort(function (a, b) { return b.date - a.date; });
        const latest = ordered[0];
        const blockLabel = block && (block.blockName || block.blockId || block.id);
        const sectionLabel = block && block.section && block.section !== '—' ? ' · ' + block.section : '';
        const latestTotal = latest && getStatus(latest.data) === 'Completed' ? metric(latest.data, 'total') : null;
        const summary = `<section class="scan-history-summary" aria-label="Scan history summary">
            <div class="scan-history-context">${blockLabel ? `<strong>${escapeHtml(blockLabel)}</strong>${escapeHtml(sectionLabel)}` : ''}</div>
            <div class="scan-history-summary-line"><span><strong>${history.length}</strong> ${history.length === 1 ? 'scan' : 'scans'}</span>
                ${latest ? `<span>Latest: ${escapeHtml(formatDateTime(latest.date))} · ${getStatus(latest.data)}</span>` : '<span>No scan records available</span>'}
                ${latestTotal === null ? '' : `<span>${formatCount(latestTotal)} detected in latest scan</span>`}
            </div>
        </section>`;
        if (!history.length) {
            container.innerHTML = summary + '<div class="scan-history-empty">No scan history is available for this block yet.</div>';
            return;
        }
        const previousById = new Map();
        let previousCompleted = null;
        history.slice().sort(function (a, b) { return a.date - b.date; }).forEach(function (entry) {
            previousById.set(entry.id, previousCompleted);
            if (getStatus(entry.data) === 'Completed' && metric(entry.data, 'total') !== null) previousCompleted = entry;
        });
        container.innerHTML = summary + `<div class="scan-history-list" tabindex="0" aria-label="Individual scan records">` +
            ordered.map(function (entry) { return scanMarkup(entry, previousById.get(entry.id)); }).join('') + '</div>';
    }

    function timestamp(value) {
        const date = value && typeof value.toDate === 'function' ? value.toDate() : null;
        return date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
    }

    function toCSV(history, block) {
        const headings = [
            'Scan ID', 'Block ID', 'Block name', 'Section', 'Account ID', 'Status',
            'Start time (UTC)', 'End time (UTC)', 'Duration (seconds)',
            'Bearing detections', 'Non-bearing detections', 'Non-viable detections',
            'Total detections', 'Bearing rate (%)', 'Registered population',
            'Estimated bearing', 'Estimated non-bearing', 'Detection coverage (%)',
            'Processed frames', 'Total frames', 'Manifest ready',
        ];
        const rows = history.map(function (entry) {
            const d = entry.data;
            const end = d.endTime && typeof d.endTime.toDate === 'function' ? d.endTime.toDate() : null;
            return [
                entry.id, d.blockId, block.blockName || block.blockId || block.id,
                block.section, d.userId, d.status || 'completed (legacy)',
                entry.date.toISOString(), timestamp(d.endTime),
                end && end >= entry.date ? (end - entry.date) / 1000 : '',
                Number(d.bearing) || 0, Number(d.nonBearing) || 0, Number(d.nonViable) || 0,
                Number(d.total) || 0, entry.pct, d.registeredPopulation,
                d.estimatedBearing, d.estimatedNonBearing, d.detectionCoverage,
                d.processedFrames, d.totalFrames, d.manifestReady,
            ];
        });
        return '\uFEFF' + [headings].concat(rows).map(function (row) {
            return row.map(csvCell).join(',');
        }).join('\r\n');
    }

    async function download(block, userId, button) {
        if (!block) return;
        if (button) button.disabled = true;
        try {
            const history = (await load(block.id, userId)).filter(function (entry) {
                return getStatus(entry.data) === 'Completed' && metric(entry.data, 'total') !== null && metric(entry.data, 'total') > 0;
            });
            if (!history.length) {
                utils.showToast('No completed scan details available for this block.', 'info');
                return;
            }
            const blob = new Blob([toCSV(history, block)], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const name = String(block.blockName || block.blockId || block.id)
                .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
            link.href = url;
            link.download = name + '_scan_details.csv';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        } catch (error) {
            console.error('❌ Error downloading scan details:', error);
            utils.showToast('Could not download scan details. Please try again.', 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    return {
        load: load,
        loadLatestPlantCounts: loadLatestPlantCounts,
        latestPlantCountsFromSnapshots: latestPlantCountsFromSnapshots,
        render: render,
        download: download,
        toCSV: toCSV,
    };
})();
