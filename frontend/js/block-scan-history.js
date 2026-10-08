/* Shared, read-only scan history for block trends and their Excel-compatible export. */
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
                        // Legacy records without a status follow the existing dashboard convention.
                        if (data.status != null && data.status !== 'completed') return;
                        const date = data.startTime && typeof data.startTime.toDate === 'function'
                            ? data.startTime.toDate() : null;
                        const total = Number(data.total) || 0;
                        if (!date || !Number.isFinite(date.getTime()) || total <= 0) return;
                        history.push({
                            id: doc.id,
                            date: date,
                            pct: ((Number(data.bearing) || 0) / total) * 100,
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

    function render(history, container) {
        if (!history.length) {
            container.innerHTML = '<div style="padding:var(--space-xl);text-align:center;color:var(--color-text-secondary);">No completed scans yet for this block — trends will appear here once a scan finishes.</div>';
            return;
        }
        container.innerHTML = history.map(function (entry) {
            const dateLabel = entry.date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
            const color = entry.pct >= 80 ? 'var(--green)' : entry.pct >= 60 ? 'var(--amber)' : 'var(--red)';
            return `<div class="trend-row">
                <div class="trend-date">${dateLabel}</div>
                <div class="trend-bar-wrap"><div class="bar-wrap"><div class="bar-fill" style="width:${entry.pct}%; background-color:${color};"></div></div></div>
                <div class="trend-val">${entry.pct.toFixed(1)}%</div>
            </div>`;
        }).join('');
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
            const history = await load(block.id, userId);
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

    return { load: load, render: render, download: download, toCSV: toCSV };
})();
