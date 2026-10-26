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

    async function loadLatestPlantCounts(blockIds, userId, cycleIdsByBlock) {
        const ids = new Set((blockIds || []).filter(Boolean).map(String));
        if (!ids.size) return new Map();

        const scans = firebase.firestore().collection('scans');
        const snapshots = await Promise.all(Array.from(ids, function (blockId) {
            let query = scans.where('blockId', '==', blockId);
            if (userId) query = query.where('userId', '==', userId);
            return query.get();
        }));
        return latestPlantCountsFromSnapshots(Array.from(ids), snapshots, userId, cycleIdsByBlock);
    }

    function latestPlantCountsFromSnapshots(blockIds, snapshots, userId, cycleIdsByBlock) {
        const ids = new Set((blockIds || []).filter(Boolean).map(String));
        const latest = new Map();
        if (!ids.size) return latest;
        snapshots.forEach(function (snapshot) {
            snapshot.forEach(function (doc) {
                const data = doc.data() || {};
                const blockId = data.blockId == null ? '' : String(data.blockId);
                if (!ids.has(blockId) || (userId && data.userId !== userId)) return;
                const activeCycleId = cycleIdsByBlock instanceof Map
                    ? cycleIdsByBlock.get(blockId)
                    : cycleIdsByBlock && cycleIdsByBlock[blockId];
                if (activeCycleId && data.cycleId !== activeCycleId) return;
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

    function latestCompletedResult(history, cycleId) {
        const ordered = history.filter(function (entry) {
            return (cycleId == null || entry.data.cycleId === cycleId) && getStatus(entry.data) === 'Completed';
        }).sort(function (a, b) { return b.date - a.date; });
        for (const entry of ordered) {
            const result = {
                date: entry.date,
                bearing: metric(entry.data, 'bearing'),
                nonBearing: metric(entry.data, 'nonBearing'),
                nonViable: metric(entry.data, 'nonViable'),
                total: metric(entry.data, 'total'),
            };
            if (result.bearing !== null && result.nonBearing !== null &&
                result.nonViable !== null && result.total !== null) return result;
        }
        return null;
    }

    function detailMarkup(entry) {
        const data = entry.data;
        const end = data.endTime && typeof data.endTime.toDate === 'function' ? data.endTime.toDate() : null;
        const details = [['Scan date', formatDateTime(entry.date)]];
        const elapsed = formatElapsed(entry.date, end);
        if (elapsed) details.push(['Elapsed scan time', elapsed]);
        return `<details class="scan-history-details"><summary>View scan details</summary><dl>${details.map(function (item) {
            return `<div><dt>${escapeHtml(item[0])}</dt><dd>${escapeHtml(item[1])}</dd></div>`;
        }).join('')}</dl></details>`;
    }

    function scanMarkup(entry, cycles) {
        const data = entry.data;
        const status = getStatus(data);
        const complete = status === 'Completed';
        const total = complete ? metric(data, 'total') : null;
        const bearing = complete ? metric(data, 'bearing') : null;
        const nonBearing = complete ? metric(data, 'nonBearing') : null;
        const estimatedPlants = bearing !== null && nonBearing !== null ? bearing + nonBearing : null;
        const percentDenominator = bearing !== null && nonBearing !== null ? bearing + nonBearing : null;
        const cycle = cycles ? assignedCycle(entry, cycles) : null;
        const cycleLabel = cycle ? 'Cycle ' + cycle.displayNumber : cycles ? 'Unassigned' : data.cycleId ? 'Assigned crop cycle' : 'Unassigned (legacy scan)';
        const classes = [
            ['Bearing', 'bearing'],
            ['Non-bearing', 'nonBearing'],
            ['Non-viable', 'nonViable'],
        ].map(function (item) {
            const count = complete ? metric(data, item[1]) : null;
            if (count === null) return '';
            const percent = formatPercent(count, percentDenominator);
            return `<div class="scan-history-class"><span>${item[0]}</span><strong>${formatCount(count)}</strong><small>${percent || 'Percentage unavailable'}</small></div>`;
        }).join('');
        const latestCount = estimatedPlants === null
            ? '<span class="scan-history-total-unavailable">Estimated plant count unavailable</span>'
            : `<div class="scan-history-total"><strong>${formatCount(estimatedPlants)}</strong><span>estimated plants${total === null ? '' : ' · ' + formatCount(total) + ' total detections'}</span></div>`;
        return `<article class="scan-history-entry">
            <div class="scan-history-entry-head"><time datetime="${entry.date.toISOString()}">${escapeHtml(formatDateTime(entry.date))}</time><span class="scan-history-status ${complete ? 'is-complete' : status === 'Failed' ? 'is-failed' : ''}">${status}</span></div>
            <div class="scan-history-cycle ${cycle || data.cycleId ? '' : 'is-unassigned'}">Crop cycle: ${escapeHtml(cycleLabel)}</div>
            ${latestCount}
            ${classes ? `<div class="scan-history-breakdown" aria-label="Plant classification counts">${classes}</div>` : ''}
            ${detailMarkup(entry)}
        </article>`;
    }

    function render(history, container, block, cycleId, legacyCutoff, cycles) {
        if (cycleId) {
            history = history.filter(function (entry) {
                if (entry.data.cycleId === cycleId) return true;
                return legacyCutoff != null && !entry.data.cycleId && entry.date.getTime() <= legacyCutoff;
            });
        }
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
            container.innerHTML = summary + `<div class="scan-history-empty">${cycleId ? 'No scans are available for this crop cycle.' : 'No scan history is available for this block yet.'}</div>`;
            return;
        }
        container.innerHTML = summary + `<div class="scan-history-list" tabindex="0" aria-label="Individual scan records">` +
            ordered.map(function (entry) { return scanMarkup(entry, cycles); }).join('') + '</div>';
    }

    function timestamp(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
        if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
        const date = value && typeof value.toDate === 'function' ? value.toDate() : null;
        return date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
    }

    function cycleCompletedAtMs(cycle) {
        if (cycle && Number.isFinite(cycle.completedAtMs)) return cycle.completedAtMs;
        const value = cycle && cycle.completedAt;
        return value && typeof value.toDate === 'function' ? value.toDate().getTime() : null;
    }

    function cycleCreatedAtMs(cycle) {
        if (cycle && Number.isFinite(cycle.createdAtMs)) return cycle.createdAtMs;
        const value = cycle && (cycle.createdAt || cycle.startedAt);
        if (value && typeof value.toDate === 'function') return value.toDate().getTime();
        if (value && typeof value.toMillis === 'function') return value.toMillis();
        return 0;
    }

    function assignCycleDisplayNumbers(cycles) {
        cycles.sort(function (a, b) {
            const byStartDate = String(a.startDate || '').localeCompare(String(b.startDate || ''));
            return byStartDate || cycleCreatedAtMs(a) - cycleCreatedAtMs(b) || String(a.id).localeCompare(String(b.id));
        });
        cycles.forEach(function (cycle, index) { cycle.displayNumber = index + 1; });
        return cycles;
    }

    function cycleDateLabel(value) {
        const date = typeof value === 'number'
            ? new Date(value)
            : value && typeof value.toDate === 'function' ? value.toDate()
                : value instanceof Date ? value : null;
        return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString() : value && typeof value === 'string' ? value : 'N/A';
    }

    function renderCycles(cycles, history, container, activeCycleId, onViewScans) {
        if (!cycles.length) {
            container.innerHTML = '<div class="scan-history-empty">No crop cycle records are available for this block yet.</div>';
            return;
        }
        container.innerHTML = '<div class="cycle-history-list">' + cycles.map(function (cycle) {
            const cutoff = cycleCompletedAtMs(cycle);
            const scans = history.filter(function (entry) { return assignedCycle(entry, cycles) === cycle; });
            const latest = scans.length ? scans[scans.length - 1].date.toLocaleDateString() : 'N/A';
            const result = latestCompletedResult(scans, null);
            const completed = cycleDateLabel(cycle.completedAtMs == null ? cycle.completedAt : cycle.completedAtMs);
            const active = cycle.id === activeCycleId;
            const resultSummary = result
                ? 'Latest completed results: Estimated plants ' + formatCount(result.bearing + result.nonBearing) +
                    ', Total detections ' + formatCount(result.total) +
                    ' (Bearing ' + formatCount(result.bearing) +
                    ', Non-bearing ' + formatCount(result.nonBearing) +
                    ', Non-viable ' + formatCount(result.nonViable) + ')'
                : 'Latest completed results: N/A';
            return '<article class="cycle-history-card"><header><strong>Cycle ' + cycle.displayNumber + '</strong>' +
                (active ? '<span class="cycle-active-badge">Active</span>' : '<span>' + escapeHtml(cycle.status || 'Unknown') + '</span>') +
                '</header><div class="cycle-history-meta"><span>Planting: ' + escapeHtml(cycle.planted || 'N/A') +
                '</span><span>Forcing: ' + escapeHtml(cycle.forcingDate || 'N/A') +
                '</span><span>Started: ' + escapeHtml(cycle.startDate || 'N/A') +
                '</span><span>Completed: ' + escapeHtml(completed) +
                '</span><span>Scans: ' + scans.length + (cycle.legacy ? ' (legacy/unassigned)' : '') +
                '</span><span>Latest scan: ' + escapeHtml(latest) +
                '</span><span>' + escapeHtml(resultSummary) +
                '</span></div><button type="button" class="btn btn-sm btn-secondary" data-cycle-id="' + escapeHtml(cycle.id) +
                '" data-cycle-cutoff="' + (cutoff == null ? '' : cutoff) + '">View scans</button></article>';
        }).join('') + '</div>';
        if (typeof onViewScans === 'function') {
            container.querySelectorAll('[data-cycle-id]').forEach(function (button) {
                button.addEventListener('click', function () {
                    onViewScans(button.getAttribute('data-cycle-id'), button.getAttribute('data-cycle-cutoff'));
                });
            });
        }
    }

    function xmlEscape(value) {
        return String(value == null ? '' : value)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    function columnName(index) {
        let name = '';
        for (index++; index; index = Math.floor((index - 1) / 26)) {
            name = String.fromCharCode(65 + (index - 1) % 26) + name;
        }
        return name;
    }

    function worksheetXml(rows) {
        const xmlRows = rows.map(function (row, rowIndex) {
            const cells = row.map(function (value, colIndex) {
                if (value == null || value === '') return '';
                const ref = columnName(colIndex) + (rowIndex + 1);
                if (typeof value === 'number' && Number.isFinite(value)) {
                    return '<c r="' + ref + '"><v>' + value + '</v></c>';
                }
                if (typeof value === 'boolean') return '<c r="' + ref + '" t="b"><v>' + (value ? '1' : '0') + '</v></c>';
                return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(value) + '</t></is></c>';
            }).join('');
            return '<row r="' + (rowIndex + 1) + '">' + cells + '</row>';
        }).join('');
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + xmlRows + '</sheetData></worksheet>';
    }

    function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) {
            crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xFF];
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    const CRC32_TABLE = (function () {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let value = n;
            for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
            table[n] = value >>> 0;
        }
        return table;
    })();

    function storedZip(entries) {
        const encoder = new TextEncoder();
        const localParts = [];
        const centralParts = [];
        let offset = 0;
        entries.forEach(function (entry) {
            const name = encoder.encode(entry.name);
            const data = encoder.encode(entry.content);
            const checksum = crc32(data);
            const local = new Uint8Array(30 + name.length);
            const localView = new DataView(local.buffer);
            localView.setUint32(0, 0x04034B50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, 0, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, 0, true);
            localView.setUint16(12, 0x21, true);
            localView.setUint32(14, checksum, true);
            localView.setUint32(18, data.length, true);
            localView.setUint32(22, data.length, true);
            localView.setUint16(26, name.length, true);
            localView.setUint16(28, 0, true);
            local.set(name, 30);
            localParts.push(local, data);

            const central = new Uint8Array(46 + name.length);
            const centralView = new DataView(central.buffer);
            centralView.setUint32(0, 0x02014B50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, 0, true);
            centralView.setUint16(14, 0x21, true);
            centralView.setUint32(16, checksum, true);
            centralView.setUint32(20, data.length, true);
            centralView.setUint32(24, data.length, true);
            centralView.setUint16(28, name.length, true);
            centralView.setUint16(30, 0, true);
            centralView.setUint16(32, 0, true);
            centralView.setUint16(34, 0, true);
            centralView.setUint16(36, 0, true);
            centralView.setUint32(38, 0, true);
            centralView.setUint32(42, offset, true);
            central.set(name, 46);
            centralParts.push(central);
            offset += local.length + data.length;
        });
        const centralSize = centralParts.reduce(function (sum, part) { return sum + part.length; }, 0);
        const end = new Uint8Array(22);
        const endView = new DataView(end.buffer);
        endView.setUint32(0, 0x06054B50, true);
        endView.setUint16(4, 0, true);
        endView.setUint16(6, 0, true);
        endView.setUint16(8, entries.length, true);
        endView.setUint16(10, entries.length, true);
        endView.setUint32(12, centralSize, true);
        endView.setUint32(16, offset, true);
        endView.setUint16(20, 0, true);
        return new Blob(localParts.concat(centralParts, [end]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }

    function assignedCycle(entry, cycles) {
        if (entry.data.cycleId) {
            return cycles.find(function (cycle) { return cycle.id === entry.data.cycleId; }) || null;
        }
        const legacyMatches = cycles.filter(function (cycle) {
            const cutoff = cycle.legacy ? cycleCompletedAtMs(cycle) : null;
            return cutoff !== null && entry.date.getTime() <= cutoff;
        }).sort(function (a, b) {
            return cycleCompletedAtMs(a) - cycleCompletedAtMs(b);
        });
        return legacyMatches[0] || null;
    }

    function workbookBlob(history, block, cycles) {
        const scanRows = [[
            'Scan ID', 'Crop Cycle', 'Block ID', 'Block name', 'Section', 'Account ID', 'Status',
            'Start time (UTC)', 'End time (UTC)', 'Duration (seconds)',
            'Bearing detections', 'Non-bearing detections', 'Non-viable detections',
            'Total detections', 'Bearing rate (%)', 'Registered population',
            'Estimated bearing', 'Estimated non-bearing', 'Detection coverage (%)',
            'Processed frames', 'Total frames', 'Manifest ready',
        ]];
        const orderedHistory = history.slice().sort(function (a, b) { return a.date - b.date; });
        const scanCounts = new Map();
        orderedHistory.forEach(function (entry) {
            const d = entry.data;
            const cycle = assignedCycle(entry, cycles);
            const end = d.endTime && typeof d.endTime.toDate === 'function' ? d.endTime.toDate() : null;
            if (cycle) scanCounts.set(cycle.id, (scanCounts.get(cycle.id) || 0) + 1);
            scanRows.push([
                entry.id, cycle ? 'Cycle ' + cycle.displayNumber : 'Unassigned', d.blockId,
                block.blockName || block.blockId || 'Unnamed block', block.section, d.userId,
                d.status || 'completed (legacy)', entry.date.toISOString(), timestamp(d.endTime),
                end && end >= entry.date ? (end - entry.date) / 1000 : null,
                metric(d, 'bearing'), metric(d, 'nonBearing'), metric(d, 'nonViable'),
                metric(d, 'total'), entry.pct, metric(d, 'registeredPopulation'),
                metric(d, 'estimatedBearing'), metric(d, 'estimatedNonBearing'), metric(d, 'detectionCoverage'),
                metric(d, 'processedFrames'), metric(d, 'totalFrames'), d.manifestReady,
            ]);
        });

        const cycleRows = [['Crop Cycle', 'Status', 'Planting Date', 'Forcing Date', 'Start Date', 'Completed Date', 'Scan Count', 'Latest Scan']];
        cycles.slice().sort(function (a, b) { return a.displayNumber - b.displayNumber; }).forEach(function (cycle) {
            const cycleScans = orderedHistory.filter(function (entry) { return assignedCycle(entry, cycles) === cycle; });
            const latest = cycleScans.length ? cycleScans[cycleScans.length - 1].date.toISOString() : '';
            cycleRows.push([
                'Cycle ' + cycle.displayNumber, cycle.status || 'Unknown', cycle.planted, cycle.forcingDate,
                cycle.startDate, timestamp(cycle.completedAtMs == null ? cycle.completedAt : cycle.completedAtMs), scanCounts.get(cycle.id) || 0, latest,
            ]);
        });

        const entries = [
            { name: '[Content_Types].xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
            { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
            { name: 'xl/workbook.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Scan Details" sheetId="1" r:id="rId1"/><sheet name="Crop Cycles" sheetId="2" r:id="rId2"/></sheets></workbook>' },
            { name: 'xl/_rels/workbook.xml.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>' },
            { name: 'xl/worksheets/sheet1.xml', content: worksheetXml(scanRows) },
            { name: 'xl/worksheets/sheet2.xml', content: worksheetXml(cycleRows) },
        ];
        return storedZip(entries);
    }

    async function download(block, userId, history, cycles, button) {
        if (!block) return;
        if (button) button.disabled = true;
        try {
            if (!history.length && !cycles.length) {
                utils.showToast('No scan or crop cycle records available for this block.', 'info');
                return;
            }
            const blob = workbookBlob(history, block, cycles);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const name = String(block.blockName || block.blockId || 'block')
                .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
            link.href = url;
            link.download = name + '_history.xlsx';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        } catch (error) {
            console.error('❌ Error downloading block history:', error);
            utils.showToast('Could not download block history. Please try again.', 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    return {
        load: load,
        loadLatestPlantCounts: loadLatestPlantCounts,
        latestPlantCountsFromSnapshots: latestPlantCountsFromSnapshots,
        render: render,
        assignedCycle: assignedCycle,
        latestCompletedResult: latestCompletedResult,
        cycleCompletedAtMs: cycleCompletedAtMs,
        assignCycleDisplayNumbers: assignCycleDisplayNumbers,
        renderCycles: renderCycles,
        download: download,
        workbookBlob: workbookBlob,
    };
})();
