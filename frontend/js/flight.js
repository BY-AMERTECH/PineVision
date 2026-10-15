/**
 * Flight Schedules Page - Firebase Integration
 *
 * Displays the SAME schedule data configured from an individual Fruit
 * Block (blocks-view.html → "Schedule Scan"). That flow is the source of
 * truth: every record lives in the `scheduled_scans` Firestore collection,
 * keyed by blockId + userId. This page reads that same collection (joined
 * with `blocks` for the human-readable Block ID / Section) instead of
 * keeping a second, disconnected copy — so a schedule created, edited or
 * cancelled from a fruit block appears here automatically, and vice versa.
 */

'use strict';

(function () {

    // Raw docs from `scheduled_scans`, before being joined with block info.
    let rawSchedules = [];

    // Joined + display-ready schedules (Block ID, Section, etc. attached).
    let allSchedules = [];

    // This user's fruit blocks: { id, blockId, blockName, section }.
    // Used both to populate the "Add Schedule" block picker and to resolve
    // Block ID / Section for each schedule.
    let userBlocks = [];
    let blocksById = {};

    let currentUserId = null;
    let currentUserName = '';
    let searchQuery = '';

    const SCHEDULED_SCANS_COLLECTION = 'scheduled_scans';

    function scheduledScanCollection() {
        return firebase.firestore().collection(SCHEDULED_SCANS_COLLECTION);
    }

    // ═══════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════

    window.initPage = async function () {
        console.log('🚀 Initializing Flight Schedules Page...');

        // Set active nav link
        document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
        const flightLink = document.querySelector('a[href="flight.html"]');
        if (flightLink) flightLink.classList.add('active');

        // Check authentication
        const currentUser = auth.getCurrentUser();
        if (!currentUser) {
            window.location.href = '../auth/login.html';
            return;
        }

        currentUserId = currentUser.uid;
        currentUserName = currentUser.fullName || currentUser.username || '';
        console.log('👤 Logged in as:', currentUser.email);
        console.log('🆔 User ID:', currentUserId);

        renderLoadingRow();

        // Blocks (for the picker + Block ID/Section join) and the schedules
        // themselves are independent queries — load them in parallel, then
        // join and render once both are back.
        await Promise.all([loadBlocks(), loadSchedules()]);
        combineAndRender();

        // Setup modals
        utils.setupModalClose('add-schedule-modal');
        utils.setupModalClose('edit-schedule-modal');
        utils.setupModalClose('cancel-schedule-modal');

        const searchInput = document.getElementById('schedule-search');
        if (searchInput) {
            searchInput.addEventListener('input', function () {
                searchQuery = searchInput.value.trim().toLowerCase();
                render();
            });
        }

        console.log('✅ Page ready');
    };

    // ═══════════════════════════════════════════════════════════
    // LOAD BLOCKS (for the Add Schedule picker + Block ID/Section join)
    // ═══════════════════════════════════════════════════════════

    async function loadBlocks() {
        try {
            const snapshot = await firebase.firestore()
                .collection('blocks')
                .where('userId', '==', currentUserId)
                .get();

            userBlocks = [];
            blocksById = {};

            snapshot.forEach(doc => {
                const data = doc.data() || {};
                const block = {
                    id: doc.id,
                    blockId: data.blockId || doc.id,
                    blockName: data.blockName || data.blockId || doc.id,
                    section: data.section || '—'
                };
                userBlocks.push(block);
                blocksById[doc.id] = block;
            });

            // Keep the picker in a sensible order for a dropdown.
            userBlocks.sort((a, b) => String(a.blockId).localeCompare(String(b.blockId)));

            populateBlockDropdown();
        } catch (error) {
            console.error('❌ Error loading blocks:', error);
            userBlocks = [];
            blocksById = {};
            populateBlockDropdown();
        }
    }

    function populateBlockDropdown() {
        const dropdown = document.getElementById('schedule-block');
        if (!dropdown) return;

        const previousValue = dropdown.value;
        dropdown.innerHTML = '<option value="">Select a fruit block</option>';
        userBlocks.forEach(block => {
            const option = document.createElement('option');
            option.value = block.id;
            option.textContent = block.blockName && block.blockName !== block.blockId
                ? `${block.blockId} — ${block.blockName} (${block.section})`
                : `${block.blockId} (${block.section})`;
            dropdown.appendChild(option);
        });
        if (previousValue) dropdown.value = previousValue;
    }

    // ═══════════════════════════════════════════════════════════
    // LOAD SCHEDULES — from `scheduled_scans`, the same collection
    // blocks-view.html reads and writes. This is the sync fix: the old
    // Flight Missions page read a separate `missions` collection that
    // block-level "Schedule Scan" never wrote to.
    // ═══════════════════════════════════════════════════════════

    async function loadSchedules() {
        try {
            console.log('📊 Loading flight schedules for user:', currentUserId);

            const snapshot = await scheduledScanCollection()
                .where('userId', '==', currentUserId)
                .get();

            console.log('📦 Found', snapshot.size, 'scheduled scans');

            rawSchedules = [];
            snapshot.forEach(doc => {
                const data = doc.data() || {};
                const scheduledAt =
                    data.scheduledAt && typeof data.scheduledAt.toDate === 'function'
                        ? data.scheduledAt.toDate()
                        : null;

                rawSchedules.push({
                    id: doc.id,
                    blockDocId: data.blockId || '',
                    scheduledAt: scheduledAt,
                    operator: data.operator || '',
                    notes: data.notes || '',
                    status: data.status === 'cancelled' ? 'cancelled' : 'scheduled'
                });
            });
        } catch (error) {
            console.error('❌ Error loading flight schedules:', error);
            rawSchedules = [];
        }
    }

    // ═══════════════════════════════════════════════════════════
    // JOIN + RENDER
    // ═══════════════════════════════════════════════════════════

    function combineAndRender() {
        allSchedules = rawSchedules.map(item => {
            const block = blocksById[item.blockDocId] || null;
            return Object.assign({}, item, {
                blockDisplayId: block ? block.blockId : (item.blockDocId || 'Unknown block'),
                blockName: block ? block.blockName : '',
                section: block ? block.section : '—'
            });
        });

        // Newest scheduled date first — same convention the old missions
        // list used.
        allSchedules.sort((a, b) => {
            const t1 = a.scheduledAt ? a.scheduledAt.getTime() : 0;
            const t2 = b.scheduledAt ? b.scheduledAt.getTime() : 0;
            return t2 - t1;
        });

        render();
    }

    function matchesSearch(item) {
        if (!searchQuery) return true;
        const statusLabel = item.status === 'cancelled' ? 'cancelled' : 'scheduled';
        const haystack = [
            item.blockDisplayId,
            item.section,
            item.operator,
            item.notes,
            statusLabel
        ].join(' ').toLowerCase();
        return haystack.indexOf(searchQuery) !== -1;
    }

    function render() {
        const list = document.getElementById('schedules-list');
        if (!list) return;

        const visible = allSchedules.filter(matchesSearch);

        const resultCount = document.getElementById('schedule-result-count');
        if (resultCount) {
            resultCount.textContent = allSchedules.length
                ? `${visible.length} of ${allSchedules.length}`
                : '';
        }

        if (allSchedules.length === 0) {
            list.innerHTML = `
                <div class="schedule-card-message">
                    No flight schedules yet. Use "+ Add Schedule" above, or schedule a scan from an individual Fruit Block.
                </div>`;
            return;
        }

        if (visible.length === 0) {
            list.innerHTML = `
                <div class="schedule-card-message">
                    No schedules match your search.
                </div>`;
            return;
        }

        list.innerHTML = visible.map(buildCard).join('');
    }

    function renderLoadingRow() {
        const list = document.getElementById('schedules-list');
        if (!list) return;
        list.innerHTML = `
            <div class="schedule-card-message">
                Loading flight schedules…
            </div>`;
    }

    function statusBadge(status) {
        if (status === 'cancelled') {
            return '<span class="badge crit"><span class="bdot"></span>Cancelled</span>';
        }
        return '<span class="badge good"><span class="bdot"></span>Scheduled</span>';
    }

    /**
     * Icon-based action buttons (replacing the old text buttons) so the
     * actions stay compact and never push the card wider than its
     * container. Functionality is unchanged — same handlers, same
     * conditions — only the presentation is icons with a tooltip +
     * aria-label instead of button text.
     */
    function actionIcons(item) {
        if (item.status !== 'scheduled') {
            return '<span class="schedule-card-no-actions">—</span>';
        }
        return `
            <button
                type="button"
                class="icon-btn"
                data-tooltip="Edit schedule"
                aria-label="Edit schedule"
                onclick="openEditScheduleModal('${item.id}')"
            >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
            </button>
            <button
                type="button"
                class="icon-btn icon-btn-danger"
                data-tooltip="Cancel schedule"
                aria-label="Cancel schedule"
                onclick="openCancelScheduleModal('${item.id}')"
            >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
            </button>`;
    }

    function buildCard(item) {
        // Prefer the human-readable block name; fall back to the Block ID
        // only when no name is on file — same existing-data logic as
        // before. Unlike before, the raw block identifier is never
        // rendered anywhere on the card.
        const blockName = item.blockName && item.blockName !== item.blockDisplayId
            ? item.blockName
            : item.blockDisplayId;
        const dateParts = formatScheduledDateParts(item.scheduledAt);

        return `
            <div class="schedule-card">
                <div class="schedule-card-row">
                    <div class="schedule-date-badge">
                        <span class="schedule-date-day">${dateParts.day}</span>
                        <span class="schedule-date-month">${dateParts.month}</span>
                        <span class="schedule-date-year">${dateParts.year}</span>
                        <span class="schedule-date-time">${dateParts.time}</span>
                    </div>
                    <div class="schedule-card-fields">
                        <div class="schedule-field schedule-field-block">
                            <span class="schedule-field-label">Block Name</span>
                            <span class="schedule-field-value">${escapeHtml(blockName)}</span>
                        </div>
                        <div class="schedule-field schedule-field-section">
                            <span class="schedule-field-label">Section</span>
                            <span class="schedule-field-value">${escapeHtml(item.section)}</span>
                        </div>
                        <div class="schedule-field schedule-field-operator">
                            <span class="schedule-field-label">User</span>
                            <span class="schedule-field-value">${escapeHtml(item.operator || '—')}</span>
                        </div>
                    </div>
                    <div class="schedule-card-side">
                        <div class="schedule-field schedule-field-status">
                            <span class="schedule-field-label">Status</span>
                            ${statusBadge(item.status)}
                        </div>
                        <div class="schedule-card-actions">${actionIcons(item)}</div>
                    </div>
                </div>
                <div class="schedule-card-notes">
                    <span class="schedule-card-notes-label">Notes</span>
                    <span class="schedule-card-notes-text">${escapeHtml(item.notes || '—')}</span>
                </div>
            </div>`;
    }

    // ═══════════════════════════════════════════════════════════
    // ADD SCHEDULE — writes to `scheduled_scans`, the exact same
    // collection/shape blocks-view.html's "Schedule Scan" writes to, just
    // with an explicit block picker since this page isn't scoped to one
    // block already.
    // ═══════════════════════════════════════════════════════════

    window.openAddScheduleModal = function () {
        if (userBlocks.length === 0) {
            utils.showToast('Create a fruit block first — schedules are tied to a block.', 'error');
            return;
        }

        const form = document.getElementById('add-schedule-form');
        if (form) form.reset();

        populateBlockDropdown();

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        document.getElementById('schedule-date').value = tomorrow.toISOString().split('T')[0];
        document.getElementById('schedule-time').value = '06:00';
        document.getElementById('schedule-operator').value = currentUserName;
        document.getElementById('schedule-notes').value = '';

        utils.showModal('add-schedule-modal');
    };

    window.closeAddScheduleModal = function () {
        utils.hideModal('add-schedule-modal');
    };

    window.handleAddSchedule = async function (event) {
        event.preventDefault();
        if (!currentUserId) {
            utils.showToast('You must be signed in to add a schedule.', 'error');
            return;
        }

        const blockDocId = document.getElementById('schedule-block').value;
        const dateStr = document.getElementById('schedule-date').value;
        const timeStr = document.getElementById('schedule-time').value;
        const operator = document.getElementById('schedule-operator').value.trim();
        const notes = document.getElementById('schedule-notes').value.trim();

        if (!blockDocId || !dateStr || !timeStr || !operator) {
            utils.showFormError('add-schedule-form', 'Please fill in all required fields.');
            return;
        }

        const scheduledDate = parseScheduledDateTime(dateStr, timeStr);
        if (!scheduledDate) {
            utils.showFormError('add-schedule-form', 'Please enter a valid date and time.');
            return;
        }

        const submitBtn = document.querySelector('#add-schedule-form button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            await scheduledScanCollection().add({
                blockId: blockDocId,
                userId: currentUserId,
                scheduledAt: firebase.firestore.Timestamp.fromDate(scheduledDate),
                operator: operator,
                notes: notes,
                status: 'scheduled',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            utils.showToast('Flight scheduled successfully!', 'success');
            window.closeAddScheduleModal();
            await loadSchedules();
            combineAndRender();
        } catch (error) {
            console.error('❌ Error scheduling flight:', error);
            utils.showToast('Failed to schedule flight. Please try again.', 'error');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    };

    // ═══════════════════════════════════════════════════════════
    // EDIT SCHEDULE
    // ═══════════════════════════════════════════════════════════

    window.openEditScheduleModal = function (scheduleId) {
        const item = allSchedules.find(s => s.id === scheduleId);
        if (!item) {
            utils.showToast('Schedule not found. It may have changed — refreshing.', 'error');
            refreshSchedules();
            return;
        }
        if (item.status !== 'scheduled') {
            utils.showToast("Cancelled schedules can't be edited.", 'error');
            return;
        }

        const form = document.getElementById('edit-schedule-form');
        if (form) form.reset();

        document.getElementById('edit-schedule-id').value = item.id;
        document.getElementById('edit-schedule-block-display').textContent =
            item.blockName && item.blockName !== item.blockDisplayId
                ? `${item.blockDisplayId} — ${item.blockName} (${item.section})`
                : `${item.blockDisplayId} (${item.section})`;

        const d = item.scheduledAt;
        if (d instanceof Date && !isNaN(d.getTime())) {
            const pad = n => String(n).padStart(2, '0');
            document.getElementById('edit-schedule-date').value =
                d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
            document.getElementById('edit-schedule-time').value =
                pad(d.getHours()) + ':' + pad(d.getMinutes());
        } else {
            document.getElementById('edit-schedule-date').value = '';
            document.getElementById('edit-schedule-time').value = '';
        }

        document.getElementById('edit-schedule-operator').value = item.operator || '';
        document.getElementById('edit-schedule-notes').value = item.notes || '';

        utils.showModal('edit-schedule-modal');
    };

    window.closeEditScheduleModal = function () {
        utils.hideModal('edit-schedule-modal');
    };

    window.handleEditSchedule = async function (event) {
        event.preventDefault();
        if (!currentUserId) {
            utils.showToast('You must be signed in to edit a schedule.', 'error');
            return;
        }

        const scheduleId = document.getElementById('edit-schedule-id').value;
        const dateStr = document.getElementById('edit-schedule-date').value;
        const timeStr = document.getElementById('edit-schedule-time').value;
        const operator = document.getElementById('edit-schedule-operator').value.trim();
        const notes = document.getElementById('edit-schedule-notes').value.trim();

        if (!scheduleId) {
            utils.showToast('Missing schedule reference.', 'error');
            return;
        }

        if (!dateStr || !timeStr || !operator) {
            utils.showFormError('edit-schedule-form', 'Please fill in all required fields.');
            return;
        }

        const scheduledDate = parseScheduledDateTime(dateStr, timeStr);
        if (!scheduledDate) {
            utils.showFormError('edit-schedule-form', 'Please enter a valid date and time.');
            return;
        }

        const submitBtn = document.querySelector('#edit-schedule-form button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const item = allSchedules.find(s => s.id === scheduleId);
            if (!item) {
                utils.showToast('Schedule not found. Refreshing…', 'error');
                await refreshSchedules();
                return;
            }

            await scheduledScanCollection().doc(scheduleId).update({
                scheduledAt: firebase.firestore.Timestamp.fromDate(scheduledDate),
                operator: operator,
                notes: notes,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            utils.showToast('Schedule updated!', 'success');
            window.closeEditScheduleModal();
            await refreshSchedules();
        } catch (error) {
            console.error('❌ Error updating schedule:', error);
            utils.showToast('Failed to update schedule. Please try again.', 'error');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    };

    // ═══════════════════════════════════════════════════════════
    // CANCEL SCHEDULE — status update only, never a delete, so the
    // schedule stays visible (and in the block's history) afterwards.
    // ═══════════════════════════════════════════════════════════

    let schedulePendingCancel = null;

    window.openCancelScheduleModal = function (scheduleId) {
        const item = allSchedules.find(s => s.id === scheduleId);
        if (!item) {
            utils.showToast('Schedule not found. It may have changed — refreshing.', 'error');
            refreshSchedules();
            return;
        }
        if (item.status !== 'scheduled') {
            utils.showToast('This schedule is already cancelled.', 'error');
            return;
        }

        schedulePendingCancel = scheduleId;
        document.getElementById('cancel-schedule-datetime').textContent = formatScheduledDateTime(item.scheduledAt);
        document.getElementById('cancel-schedule-block').textContent = item.blockDisplayId;
        utils.showModal('cancel-schedule-modal');
    };

    window.closeCancelScheduleModal = function () {
        schedulePendingCancel = null;
        utils.hideModal('cancel-schedule-modal');
    };

    window.confirmCancelSchedule = async function () {
        if (!schedulePendingCancel) {
            window.closeCancelScheduleModal();
            return;
        }
        const scheduleId = schedulePendingCancel;

        try {
            await scheduledScanCollection().doc(scheduleId).update({
                status: 'cancelled',
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            utils.showToast('Schedule cancelled.', 'success');
            window.closeCancelScheduleModal();
            await refreshSchedules();
        } catch (error) {
            console.error('❌ Error cancelling schedule:', error);
            utils.showToast('Failed to cancel schedule. Please try again.', 'error');
        }
    };

    // ═══════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════

    async function refreshSchedules() {
        await loadSchedules();
        combineAndRender();
    }

    /**
     * Combine a date input value ("YYYY-MM-DD") and a time input value
     * ("HH:MM") into a JS Date. Returns null if either part is missing or
     * the result isn't a valid date.
     */
    function parseScheduledDateTime(dateStr, timeStr) {
        if (!dateStr || !timeStr) return null;
        const combined = new Date(dateStr + 'T' + timeStr);
        if (isNaN(combined.getTime())) return null;
        return combined;
    }

    /**
     * Format a JS Date for display, e.g. "Sep 20, 2026 · 6:00 AM".
     */
    function formatScheduledDateTime(date) {
        if (!(date instanceof Date) || isNaN(date.getTime())) {
            return 'Unknown date';
        }
        const datePart = date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: '2-digit'
        });
        const timePart = date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit'
        });
        return datePart + ' · ' + timePart;
    }

    /**
     * Split a scheduled Date into the day/month/year/time parts used by
     * the schedule card's Date & Time badge — same visual hierarchy as
     * the Scan Log page's date badge (scans.html: large day, smaller
     * month, smaller year), with the scheduled time kept visible below.
     */
    function formatScheduledDateParts(date) {
        if (!(date instanceof Date) || isNaN(date.getTime())) {
            return { day: '--', month: '—', year: '—', time: 'Unknown time' };
        }
        return {
            day: String(date.getDate()).padStart(2, '0'),
            month: date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
            year: String(date.getFullYear()),
            time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        };
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

})();
