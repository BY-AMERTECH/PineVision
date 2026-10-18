/* Client block crop-cycle history, update modal, and audit history modal. */
window.cropCycleUI = (function () {
  'use strict';
  const API = '/api/blocks/';
  let context = null;
  let pendingCycleOperationId = null;

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
    let result;
    try { result = await response.json(); }
    catch (_) { throw new Error('The server returned an unexpected response (HTTP ' + response.status + '). Check the Flask logs and try again.'); }
    if (!response.ok || !result.ok) throw new Error(result.message || 'Crop cycle request failed.');
    return result;
  }
  function esc(value) {
    return String(value == null || value === '' ? 'Not yet recorded' : value)
      .replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function dateLabel(value) {
    return !value || value === 'Not set' ? 'Not yet recorded' : esc(value);
  }
  async function resolve(blockId, legacy) {
    const result = await request(encodeURIComponent(blockId) + '/cycles');
    const active = result.cycles.find(function (cycle) { return cycle.id === result.activeCycleId; });
    if (active) return Object.assign({ legacy: false }, active);
    if (result.cycles.length) return null;
    return legacy && (legacy.planted || legacy.forcingDate)
      ? { plantingDate: legacy.planted || '', forcingDate: legacy.forcingDate || '', legacy: true } : null;
  }
  async function loadCycles(blockId) {
    return request(encodeURIComponent(blockId) + '/cycles');
  }
  async function mount(blockId, host, blockName) {
    if (!host) return;
    context = { blockId: blockId, blockName: blockName || 'this block', active: null, legacyCurrent: false };
    host.innerHTML = '<div class="scan-history-empty">Loading crop cycle history…</div>';
    try {
      const result = await loadCycles(blockId);
      context = {
        blockId: blockId,
        blockName: blockName || 'this block',
        active: (result.cycles || []).find(function (c) { return c.id === result.activeCycleId; }) || null,
        legacyCurrent: !!result.legacyCurrent,
      };
      const cycles = result.cycles || [];
      const displayCycles = cycles.length ? cycles : (result.legacyCycle ? [result.legacyCycle] : []);
      host.innerHTML = '<div class="cycle-history-list">' + (displayCycles.length ? displayCycles.slice().reverse().map(function (cycle) {
        const isCurrent = cycle.id === result.activeCycleId;
        const cycleLabel = cycle.legacy && !cycle.id ? 'Current Cycle · Legacy block details' : isCurrent ? 'Current Cycle' :
          (cycle.id === result.latestCycleId ? 'Most Recent Completed Cycle' : 'Previous Cycle');
        return '<details class="cycle-history-item" ' + (isCurrent ? 'open' : '') + '><summary>' +
          '<span class="cycle-entry-label">' + cycleLabel + ' · ' + esc(cycle.status) + '</span>' +
          '<span class="cycle-entry-dates">Planting: ' + dateLabel(cycle.plantingDate) + ' · Forcing: ' + dateLabel(cycle.forcingDate) + '</span></summary>' +
          '<div class="cycle-history-detail">Cycle identifier: ' + esc(cycle.cycleNumber || cycle.id || 'Legacy block record') +
          (cycle.harvestedAt ? ' · Harvest: ' + dateLabel(cycle.harvestedAt) : '') +
          (cycle.createdAt ? ' · Recorded: ' + esc(cycle.createdAt) : '') +
          (cycle.migratedAt ? ' · Legacy data preserved: ' + esc(cycle.migratedAt) : '') +
          (cycle.createdBy ? ' · Started by: ' + esc(cycle.createdBy) : '') +
          (cycle.metrics ? ' · Metrics: Total Plant Estimate ' + esc(cycle.metrics.totalPlantEstimate) +
            ', Bearing ' + esc(cycle.metrics.bearingPercent) + '%, Non-Bearing ' + esc(cycle.metrics.nonBearingPercent) +
            '%, Non-Viable ' + esc(cycle.metrics.nonViable) + '%' : '') +
          (cycle.legacy ? ' · Migrated from existing block details' : '') + '</div></details>';
      }).join('') : '<p class="scan-history-empty">No crop cycles have been recorded yet.</p>') + '</div>';
    } catch (error) {
      host.innerHTML = '<p class="scan-history-empty">Crop cycle history unavailable: ' + esc(error.message) +
        '</p><button type="button" class="btn btn-secondary" onclick="cropCycleUI.retryCycles()">Retry</button>';
    }
  }
  async function retryCycles() {
    if (!context) return;
    await mount(context.blockId, document.getElementById('crop-cycle-history'), context.blockName);
  }
  async function openAuditHistory() {
    if (!context) { alert('Crop cycle history is still loading. Please try again.'); return; }
    const host = document.getElementById('crop-audit-content');
    host.innerHTML = '<p class="scan-history-empty">Loading crop update audit history…</p>';
    utils.showModal('crop-audit-modal');
    document.querySelector('#crop-audit-modal .modal-close')?.focus();
    await loadAuditHistory();
  }
  async function loadAuditHistory() {
    if (!context) return;
    const host = document.getElementById('crop-audit-content');
    host.innerHTML = '<p class="scan-history-empty">Loading crop update audit history…</p>';
    try {
      const cycleResult = await loadCycles(context.blockId);
      const events = [];
      for (const cycle of cycleResult.cycles || []) {
        const result = await request(encodeURIComponent(context.blockId) + '/cycles/' + encodeURIComponent(cycle.id) + '/history');
        (result.history || []).forEach(function (entry) { events.push(Object.assign({ cycleNumber: cycle.cycleNumber || '', cycleStatus: cycle.status }, entry)); });
      }
      events.sort(function (a, b) { return String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')); });
      host.innerHTML = events.length ? '<div class="audit-history-list" role="list">' + events.map(function (entry) {
        const field = entry.field === 'plantingDate' ? 'Planting Date' : entry.field === 'forcingDate' ? 'Forcing Date' :
          entry.field === 'daf' ? 'Growth Stage (DAF)' : (entry.type || 'Crop Cycle Event');
        const kind = entry.type === 'Crop Cycle Started' || entry.type === 'Legacy Cycle Recorded' || /Set on New Cycle/.test(entry.type || '')
          ? 'New cycle recorded' : entry.type === 'Crop Cycle Completed' ? 'Cycle completed' : 'Date or growth correction';
        return '<article class="audit-history-entry" role="listitem"><div class="audit-history-meta">' +
          '<strong>' + esc(entry.updatedAt) + '</strong><span>' + kind + '</span></div><div><strong>' + esc(field) + '</strong> · Cycle ' +
          esc(entry.cycleNumber || entry.cropCycleId) + '</div><div>Previous: ' + esc(entry.previousValue) +
          ' → New: ' + esc(entry.newValue) + '</div><div>Updated by: ' + esc(entry.updatedBy) + '</div></article>';
      }).join('') + '</div>' : '<p class="scan-history-empty">No crop updates have been recorded yet.</p>';
    } catch (error) {
      host.innerHTML = '<p class="scan-history-empty">Could not load crop update audit history: ' + esc(error.message) + '</p>' +
        '<button type="button" class="btn btn-secondary" onclick="cropCycleUI.retryAuditHistory()">Retry</button>';
    }
  }
  function openUpdateBlock() {
    if (!context) return alert('Crop cycle information is still loading. Please try again.');
    document.getElementById('update-block-name').textContent = context.blockName;
    document.getElementById('crop-update-error').textContent = '';
    document.getElementById('crop-update-form').reset();
    pendingCycleOperationId = null;
    document.getElementById('crop-update-save').disabled = false;
    updateWorkflowOptions();
    updateSelectedType();
    utils.showModal('update-block-modal');
    setTimeout(function () { document.querySelector('input[name="cropWorkflow"]:not(:disabled)')?.focus(); }, 0);
  }
  function closeUpdateModal() {
    utils.hideModal('update-block-modal');
    document.querySelector(".block-header-buttons button[onclick='openUpdateBlock()']")?.focus();
  }
  function updateWorkflowOptions() {
    if (!context) return;
    document.querySelector('input[name="cropWorkflow"][value="correction"]').disabled = !(context.active || context.legacyCurrent);
    document.getElementById('crop-workflow-new').disabled = false;
    document.getElementById('crop-update-help').textContent = context.active
      ? 'Correct one value in the current cycle, or start a new cycle after replanting. Starting a new cycle completes the current cycle automatically.'
      : context.legacyCurrent
        ? 'Correct one value in the existing crop details, or explicitly start a new cycle.'
        : 'Start a new crop cycle by entering its planting date. Forcing date and DAF are optional.';
  }
  function updateSelectedType() {
    const selected = document.querySelector('input[name="cropWorkflow"]:checked');
    const host = document.getElementById('crop-update-type-input');
    if (!selected) { host.innerHTML = ''; return; }
    if (selected.value === 'correction') {
      host.innerHTML = '<fieldset class="crop-update-options"><legend class="form-label">Choose one value to correct</legend>' +
        '<label class="crop-update-option"><input type="radio" name="cropUpdateType" value="plantingDate"> Planting Date</label>' +
        '<label class="crop-update-option"><input type="radio" name="cropUpdateType" value="forcingDate"> Forcing Date</label>' +
        '<label class="crop-update-option"><input type="radio" name="cropUpdateType" value="daf"> Growth Stage (DAF)</label></fieldset>' +
        '<div id="crop-correction-value" class="mt-3"></div>';
    } else if (selected.value === 'newCycle') {
      host.innerHTML = '<p>A new cycle is created only when you confirm and save. Planting date is required; forcing date and DAF can be added now or later.</p>' +
        '<label class="form-label" for="cycle-planting-date">Planting Date *</label><input class="form-input" id="cycle-planting-date" type="date" required>' +
        '<label class="form-label mt-2" for="cycle-forcing-date">Forcing Date</label><input class="form-input" id="cycle-forcing-date" type="date">' +
        '<label class="form-label mt-2" for="cycle-daf">Growth Stage (DAF)</label><input class="form-input" id="cycle-daf" type="number" min="0" step="1">' +
        (context.active ? '<p class="form-hint mt-3" role="note">Starting a new crop cycle will automatically record the current cycle as harvested/completed. Its historical scan results will be preserved, and the new cycle\'s monitoring metrics will start at 0 until a scan is completed.</p>' : '');
    }
  }
  function updateCorrectionInput() {
    const selected = document.querySelector('input[name="cropUpdateType"]:checked');
    const host = document.getElementById('crop-correction-value');
    if (!selected || !host) return;
    const type = selected.value;
    const label = type === 'plantingDate' ? 'Planting Date' : type === 'forcingDate' ? 'Forcing Date' : 'Growth Stage (DAF)';
    host.innerHTML = '<label class="form-label" for="crop-update-value">' + label + '</label><input class="form-input" id="crop-update-value" type="' +
      (type === 'daf' ? 'number' : 'date') + '" ' + (type === 'daf' ? 'min="0" step="1"' : '') + ' required>';
  }
  async function saveUpdate(event) {
    event.preventDefault();
    const selected = document.querySelector('input[name="cropWorkflow"]:checked');
    const errorHost = document.getElementById('crop-update-error');
    const button = document.getElementById('crop-update-save');
    if (button.disabled) return;
    errorHost.textContent = '';
    if (!selected) { errorHost.textContent = 'Choose an action.'; return; }
    button.disabled = true;
    try {
      if (selected.value === 'correction') {
        const field = document.querySelector('input[name="cropUpdateType"]:checked');
        const input = document.getElementById('crop-update-value');
        if (!field) throw new Error('Choose one value to correct.');
        if (!input || !input.value) throw new Error('Enter a value before saving.');
        const value = field.value === 'daf' ? Number(input.value) : input.value;
        if (field.value === 'daf' && (!Number.isInteger(value) || value < 0)) throw new Error('Growth Stage (DAF) must be a whole number of 0 or more.');
        const label = field.value === 'plantingDate' ? 'Planting Date' : field.value === 'forcingDate' ? 'Forcing Date' : 'Growth Stage (DAF)';
        if (!confirm('Correct ' + label + ' for ' + context.blockName + '?')) { button.disabled = false; return; }
        if (!context.active && !context.legacyCurrent) throw new Error('There is no current crop cycle to correct.');
        const endpoint = context.legacyCurrent && !context.active ? encodeURIComponent(context.blockId) + '/cycles/legacy-correction' :
          encodeURIComponent(context.blockId) + '/cycles/' + encodeURIComponent(context.active.id);
        await request(endpoint, context.legacyCurrent && !context.active ? 'POST' : 'PATCH', { field: field.value, value: value });
        closeUpdateModal();
        await refreshAfterSave('Crop information corrected.');
      } else if (selected.value === 'newCycle') {
        const plantingDate = document.getElementById('cycle-planting-date').value;
        const forcingDate = document.getElementById('cycle-forcing-date').value;
        const dafInput = document.getElementById('cycle-daf').value;
        if (!plantingDate) throw new Error('Planting date is required to start a new crop cycle.');
        const body = { plantingDate: plantingDate };
        if (forcingDate) body.forcingDate = forcingDate;
        if (dafInput !== '') {
          body.daf = Number(dafInput);
          if (!Number.isInteger(body.daf) || body.daf < 0) throw new Error('Growth Stage (DAF) must be a whole number of 0 or more.');
        }
        if (!confirm('Start a new crop cycle for ' + context.blockName + '? The current cycle will be completed automatically and preserved in history.')) { button.disabled = false; return; }
        if (!pendingCycleOperationId) pendingCycleOperationId = (window.crypto && crypto.randomUUID)
          ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        body.operationId = pendingCycleOperationId;
        await request(encodeURIComponent(context.blockId) + '/cycles', 'POST', body);
        pendingCycleOperationId = null;
        closeUpdateModal();
        await refreshAfterSave('New crop cycle started.');
      }
    } catch (error) {
      errorHost.textContent = error.message || 'Could not save crop information. Your input is still available.';
      button.disabled = false;
    }
  }
  async function refreshAfterSave(message) {
    try {
      if (typeof window.refreshBlockCropInfo === 'function') await window.refreshBlockCropInfo();
      utils.showToast(message, 'success');
    } catch (error) {
      console.error('Saved crop change, but refreshing block details failed:', error);
      utils.showToast('Saved successfully, but the page could not refresh. Reload to see the latest details.', 'error');
    }
  }
  async function prepare(block) {
    const active = await resolve(block.id, block);
    if (active) {
      block.planted = active.plantingDate || '';
      block.forcingDate = active.forcingDate || '';
      if (typeof active.daf === 'number') block.daf = active.daf;
      if (active.metrics) {
        block.hasCycleMetrics = true;
        block.bearing = Number(active.metrics.bearingPercent) || 0;
        block.nonbearing = Number(active.metrics.nonBearingPercent) || 0;
        block.nonViable = Number(active.metrics.nonViable) || 0;
        block.plants = active.metrics.plantCount == null
          ? Number(active.metrics.totalPlantEstimate) || 0 : Number(active.metrics.plantCount) || 0;
        block.estimatedTotalPlantCount = Number(active.metrics.totalPlantEstimate) || 0;
        block.lastScanned = active.metrics.lastScanned || null;
        const status = document.getElementById('cycle-scan-status');
        if (status) status.hidden = !active.metrics.awaitingFirstScan;
      }
    } else {
      const result = await loadCycles(block.id);
      if (result.cycles.length) { block.planted = ''; block.forcingDate = ''; block.daf = 0; }
      const status = document.getElementById('cycle-scan-status');
      if (status) status.hidden = true;
    }
    return active;
  }
  function initialize() {
    const form = document.getElementById('crop-update-form');
    if (form) {
      form.addEventListener('change', function (event) {
        if (event.target.name === 'cropWorkflow') updateSelectedType();
        else if (event.target.name === 'cropUpdateType') updateCorrectionInput();
      });
      form.addEventListener('submit', saveUpdate);
    }
    ['update-block-modal', 'crop-audit-modal'].forEach(function (id) {
      const modal = document.getElementById(id);
      modal.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          const opener = id === 'update-block-modal'
            ? document.querySelector(".block-header-buttons button[onclick='openUpdateBlock()']")
            : document.querySelector("#crop-cycle-card button[onclick='openCropAuditModal()']");
          setTimeout(function () { if (opener) opener.focus(); }, 0);
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
          .filter(function (element) { return element.offsetParent !== null; });
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
    });
  }
  return { prepare: prepare, mount: mount, openUpdateBlock: openUpdateBlock, closeUpdateModal: closeUpdateModal,
    openAuditHistory: openAuditHistory, loadAuditHistory: loadAuditHistory,
    retryAuditHistory: loadAuditHistory, retryCycles: retryCycles, initialize: initialize };
})();
