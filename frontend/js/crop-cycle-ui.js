/* Client block crop-cycle history and single-field update workflow. */
window.cropCycleUI = (function () {
  'use strict';
  const API = '/api/blocks/';
  async function token() {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Sign in again to manage crop cycles.');
    return user.getIdToken();
  }
  async function request(path, method, body) {
    const headers = { Authorization: 'Bearer ' + await token() };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(API + path, { method: method || 'GET', headers: headers,
      body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || 'Crop cycle request failed.');
    return result;
  }
  async function resolve(blockId, legacy) {
    const result = await request(encodeURIComponent(blockId) + '/cycles');
    const active = result.cycles.find(function (cycle) { return cycle.id === result.activeCycleId; });
    if (active) return Object.assign({ legacy: false }, active);
    if (result.cycles.length) return null;
    return legacy && (legacy.planted || legacy.forcingDate)
      ? { plantingDate: legacy.planted || '', forcingDate: legacy.forcingDate || '', legacy: true } : null;
  }
  function esc(value) {
    return String(value == null || value === '' ? 'Not yet recorded' : value)
      .replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function dateLabel(value) {
    if (!value || value === 'Not set') return 'Not yet recorded';
    return esc(value);
  }
  async function mount(blockId, host, blockName) {
    if (!host) return;
    host.innerHTML = '<div class="scan-history-empty">Loading crop cycle history…</div>';
    try {
      const result = await request(encodeURIComponent(blockId) + '/cycles');
      const cycles = result.cycles || [];
      let history = [];
      for (const cycle of cycles) {
        const entries = await request(encodeURIComponent(blockId) + '/cycles/' + encodeURIComponent(cycle.id) + '/history');
        history = history.concat(entries.history || []);
      }
      const active = cycles.find(function (c) { return c.id === result.activeCycleId; });
      const legacyCurrent = !active && result.legacyCurrent;
      host.innerHTML = '<div class="info-card-title">Crop Cycle History</div>' +
        '<div class="cycle-history-list">' + (cycles.length ? cycles.slice().reverse().map(function (cycle, index) {
          const cycleLabel = cycle.id === result.activeCycleId ? 'Current Cycle' :
            cycle.id === result.latestCycleId ? 'Most Recent Completed Cycle' : 'Previous Cycle';
          return '<details class="cycle-history-item" ' + (cycle.id === result.activeCycleId ? 'open' : '') + '><summary>' +
            cycleLabel + ' · ' + esc(cycle.status) +
            ' <span class="stat-value">' + dateLabel(cycle.plantingDate) + ' → ' + dateLabel(cycle.forcingDate) + '</span></summary>' +
            '<div class="cycle-history-detail">Cycle ' + esc(cycle.cycleNumber || (cycles.length - index)) + ' · Planting: ' + dateLabel(cycle.plantingDate) +
            ' · Forcing: ' + dateLabel(cycle.forcingDate) + (cycle.harvestedAt ? ' · Harvest: ' + dateLabel(cycle.harvestedAt) : '') +
            (cycle.createdAt ? ' · Recorded: ' + esc(cycle.createdAt) : '') +
            (cycle.createdBy ? ' · Started by: ' + esc(cycle.createdBy) : '') +
            '</div></details>';
        }).join('') : '<p>No crop cycle records yet. Existing block dates remain available as legacy details.</p>') + '</div>' +
        '<div class="info-card-title mt-3">Update Block</div><p>Updating ' + esc(blockName || 'this block') + '.</p>' +
        '<form class="cycle-update-form"><label class="form-label" for="cycle-update-type">Update type</label>' +
        '<select class="form-input" id="cycle-update-type" required><option value="">Choose one update</option>' +
        '<option value="plantingDate">Update Planting Date</option><option value="forcingDate">Update Forcing Date</option>' +
        '<option value="daf">Update Growth Stage (DAF)</option></select><div class="cycle-update-input"></div>' +
        '<button class="btn btn-secondary" type="submit">Save Selected Update</button></form>' +
        (active ? '<form class="cycle-close-form mt-3"><label class="form-label">Harvest date</label><input class="form-input" name="harvestedAt" type="date" required><button class="btn btn-secondary mt-2" type="submit">Record Harvest</button></form>' :
          '<form class="cycle-new-form mt-3"><label class="form-label">Start New Crop Cycle · Planting Date</label><input class="form-input" name="plantingDate" type="date" required><button class="btn btn-primary mt-2" type="submit">Start New Crop Cycle</button></form>') +
        '<div class="info-card-title mt-3">Crop Update Audit History</div>' +
        '<div class="cycle-audit-list">' + (history.length ? history.sort(function (a,b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); }).map(function (entry) {
          return '<div class="stat-row"><span class="stat-label">' + esc(entry.type) + '<br>Cycle ' + esc(entry.cropCycleId) + '<br>By ' + esc(entry.updatedBy) + '</span>' +
            '<span class="stat-value">' + esc(entry.previousValue) + ' → ' + esc(entry.newValue) + '<br>' + esc(entry.updatedAt) + '</span></div>';
        }).join('') : '<p>No crop updates recorded yet.</p>') + '</div>';
      const form = host.querySelector('.cycle-update-form');
      const selector = form.querySelector('select');
      selector.addEventListener('change', function () {
        const type = selector.value;
        const input = host.querySelector('.cycle-update-input');
        input.innerHTML = type ? '<label class="form-label" for="cycle-update-value">' +
          (type === 'plantingDate' ? 'Planting Date' : type === 'forcingDate' ? 'Forcing Date' : 'Growth Stage (DAF)') +
          '</label><input id="cycle-update-value" class="form-input" type="' + (type === 'daf' ? 'number' : 'date') + '" ' +
          (type === 'daf' ? 'min="0" step="1"' : '') + ' required>' : '';
      });
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        const type = selector.value;
        if (!type) return alert('Choose exactly one update type.');
        const rawValue = host.querySelector('#cycle-update-value').value;
        const value = type === 'daf' ? Number(rawValue) : rawValue;
        if (rawValue === '') return alert(type === 'daf' ? 'Enter a Growth Stage (DAF) value.' : 'Choose a date before saving.');
        if (type === 'daf' && (!Number.isInteger(value) || value < 0)) return alert('Growth Stage (DAF) must be a whole number of 0 or more.');
        if (!confirm('Save this ' + (type === 'plantingDate' ? 'planting date' : type === 'forcingDate' ? 'forcing date' : 'Growth Stage (DAF)') + ' update for ' + (legacyCurrent ? 'the existing crop details' : 'the current cycle') + '?')) return;
        try {
          if (!active && !legacyCurrent) throw new Error('Start a crop cycle before updating crop information.');
          const endpoint = legacyCurrent ? encodeURIComponent(blockId) + '/cycles/legacy-correction' :
            encodeURIComponent(blockId) + '/cycles/' + encodeURIComponent(active.id);
          await request(endpoint, legacyCurrent ? 'POST' : 'PATCH', { field: type, value: value });
          utils.showToast('Crop information updated.', 'success'); setTimeout(function () { location.reload(); }, 500);
        } catch (error) { alert(error.message); }
      });
      const close = host.querySelector('.cycle-close-form');
      if (close) close.addEventListener('submit', async function (event) {
        event.preventDefault(); if (!confirm('Mark this crop cycle as completed?')) return;
        try { await request(encodeURIComponent(blockId) + '/cycles/' + encodeURIComponent(active.id) + '/close', 'POST', { harvestedAt: close.elements.harvestedAt.value }); utils.showToast('Crop cycle completed.', 'success'); setTimeout(function () { location.reload(); }, 500); }
        catch (error) { alert(error.message); }
      });
      const create = host.querySelector('.cycle-new-form');
      if (create) create.addEventListener('submit', async function (event) {
        event.preventDefault(); if (!confirm('Start a new crop cycle for this physical block?')) return;
        try { await request(encodeURIComponent(blockId) + '/cycles', 'POST', { plantingDate: create.elements.plantingDate.value }); utils.showToast('New crop cycle started.', 'success'); setTimeout(function () { location.reload(); }, 500); }
        catch (error) { alert(error.message); }
      });
    } catch (error) { host.innerHTML = '<p class="scan-history-empty">Crop cycle history unavailable: ' + esc(error.message) + '</p>'; }
  }
  async function prepare(block) {
    const active = await resolve(block.id, block);
    if (active) {
      block.planted = active.plantingDate || '';
      block.forcingDate = active.forcingDate || '';
      if (typeof active.daf === 'number') block.daf = active.daf;
    } else {
      const result = await request(encodeURIComponent(block.id) + '/cycles');
      if (result.cycles.length) { block.planted = ''; block.forcingDate = ''; block.daf = 0; }
    }
    return active;
  }
  return { resolve: resolve, prepare: prepare, mount: mount };
})();
