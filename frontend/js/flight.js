/**
 * Flight Missions Page - Firebase Integration
 */

'use strict';

(function () {

    let allMissions = [];
    let activeFilter = 'all';
    let operators = [];
    let currentUserId = null;

    // ═══════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════

    window.initPage = async function () {
        console.log('🚀 Initializing Flight Missions Page...');

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
        console.log('👤 Logged in as:', currentUser.email);
        console.log('🆔 User ID:', currentUserId);

        // Set default date to tomorrow
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        document.getElementById('mission-date').value = tomorrow.toISOString().split('T')[0];
        document.getElementById('mission-time').value = '06:00';

        // Load operators and missions in parallel — they are independent queries.
        await Promise.all([loadOperators(), loadMissions()]);

        // Setup modals
        utils.setupModalClose('add-mission-modal');
        utils.setupModalClose('edit-mission-modal');

        console.log('✅ Page ready');
    };

    // ═══════════════════════════════════════════════════════════
    // LOAD OPERATORS
    // ═══════════════════════════════════════════════════════════

    async function loadOperators() {
        try {
            const cached = window.pvCache && window.pvCache.get('operators');
            if (cached) {
                operators = cached;
                populateOperatorDropdowns();
                console.log('✅ Operators from cache:', operators.length);
                return;
            }

            const snapshot = await firebase.firestore()
                .collection('users')
                .where('role', '==', 'client')
                .get();

            operators = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                const name = data.fullName || data.email || 'Unknown Operator';
                operators.push(name.trim());
            });

            if (operators.length === 0) {
                operators = ['Juan Dela Cruz', 'Maria Santos', 'Pedro Reyes'];
            }

            if (window.pvCache) {
                window.pvCache.set('operators', operators, 120_000); // 2-minute TTL
            }

            populateOperatorDropdowns();
            console.log('✅ Loaded', operators.length, 'operators:', operators);

        } catch (error) {
            console.error('❌ Error loading operators:', error);
            operators = ['Juan Dela Cruz', 'Maria Santos', 'Pedro Reyes'];
            populateOperatorDropdowns();
        }
    }

    function populateOperatorDropdowns() {
        const addDropdown = document.getElementById('mission-operator');
        const editDropdown = document.getElementById('edit-mission-operator');

        if (addDropdown) {
            addDropdown.innerHTML = '<option value="">Select operator</option>';
            operators.forEach(op => {
                const option = document.createElement('option');
                option.value = op;
                option.textContent = op;
                addDropdown.appendChild(option);
            });
        }

        if (editDropdown) {
            editDropdown.innerHTML = '<option value="">Select operator</option>';
            operators.forEach(op => {
                const option = document.createElement('option');
                option.value = op;
                option.textContent = op;
                editDropdown.appendChild(option);
            });
        }
    }

    // ═══════════════════════════════════════════════════════════
    // LOAD MISSIONS
    // ═══════════════════════════════════════════════════════════

    async function loadMissions() {
        try {
            console.log('📊 Loading missions for user:', currentUserId);
            utils.showLoading('missions-grid');

            const snapshot = await firebase.firestore()
                .collection('missions')
                .where('userId', '==', currentUserId)
                .get();

            console.log('📦 Found', snapshot.size, 'missions');

            allMissions = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                allMissions.push({
                    id: doc.id,
                    missionNumber: data.missionNumber || 'MISSION',
                    date: data.date || '',
                    time: data.time || '06:00',
                    drone: data.drone || 'DJI Mavic 3 Multispectral',
                    area: data.area || 'All 8 blocks (26.8 ha)',
                    operator: data.operator || 'Unknown',
                    duration: data.duration || '~2h 20m',
                    notes: data.notes || '',
                    status: data.status || 'scheduled'
                });
            });

            // Sort by date (newest first)
            allMissions.sort((a, b) => {
                const dateA = new Date(a.date);
                const dateB = new Date(b.date);
                return dateB - dateA;
            });

            console.log('✅ Missions loaded:', allMissions.length);
            render();

        } catch (error) {
            console.error('❌ Error loading missions:', error);
            allMissions = [];
            render();
        }
    }

    // ═══════════════════════════════════════════════════════════
    // FILTER
    // ═══════════════════════════════════════════════════════════

    window.setFilter = function (value, btn) {
        activeFilter = value;
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        render();
    };

    // ═══════════════════════════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════════════════════════

    function render() {
        const missions = activeFilter === 'all'
            ? allMissions
            : allMissions.filter(m => m.status === activeFilter);

        const grid = document.getElementById('missions-grid');
        if (!grid) return;

        if (missions.length === 0) {
            grid.innerHTML = `
                <div class="col-12 text-center py-5" style="color:var(--muted);">
                    <div style="font-size:48px;margin-bottom:1.5rem;opacity:0.3;"></div>
                    <h3 style="font-size:1.25rem;font-weight:600;color:var(--color-text-primary);margin-bottom:0.5rem;">
                        No missions yet
                    </h3>
                    <p style="font-size:0.9375rem;margin-bottom:1.5rem;">
                        Click "Add Mission" to schedule your first drone flight.
                    </p>
                </div>`;
            return;
        }

        grid.innerHTML = missions.map(m => buildCard(m)).join('');
    }

    function buildStatItem(label, value) {
        return `
        <div class="stat-item">
            <span class="stat-label">${label}</span>
            <span class="stat-value">${value}</span>
        </div>`;
    }

    function buildCard(m) {
        const statusLabels = {
            scheduled: 'Scheduled',
            'in-progress': 'In Progress',
            completed: 'Completed',
            cancelled: 'Cancelled'
        };

        const statusBadge = `
        <span class="badge ${m.status}">
            <span class="bdot"></span>${statusLabels[m.status] || m.status}
        </span>`;

        return `
        <div class="col-12">
            <div class="mission-card" onclick="openEditMissionModal('${m.id}')">
                <div class="mission-card-main">
                    <div class="mission-card-identity">
                        <div class="mission-id">${m.missionNumber}</div>
                        <div class="mission-date">${m.date}</div>
                        <div class="mission-title">${m.time} &middot; ${m.drone}</div>
                    </div>

                    <div class="mission-stats-grid">
                        ${buildStatItem('AREA', m.area)}
                        ${buildStatItem('OPERATOR', m.operator)}
                        ${buildStatItem('DURATION', m.duration)}
                    </div>

                    <div class="mission-card-status">
                        ${statusBadge}
                    </div>
                </div>
                
                ${m.notes ? `
                <div class="mission-card-notes">
                    <span class="notes-label">NOTES</span>
                    <span class="notes-value">${m.notes}</span>
                </div>
                ` : ''}
            </div>
        </div>`;
    }

    // ═══════════════════════════════════════════════════════════
    // ADD MISSION
    // ═══════════════════════════════════════════════════════════

    window.openAddMissionModal = function () {
        utils.showModal('add-mission-modal');
    };

    window.closeAddMissionModal = function () {
        utils.hideModal('add-mission-modal');
        document.getElementById('add-mission-form').reset();
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        document.getElementById('mission-date').value = tomorrow.toISOString().split('T')[0];
        document.getElementById('mission-time').value = '06:00';
    };

    window.handleAddMission = async function (event) {
        event.preventDefault();
        console.log('💾 Adding mission...');

        const form = document.getElementById('add-mission-form');
        const formData = new FormData(form);

        const missionDate = formData.get('missionDate');
        const missionTime = formData.get('missionTime');
        const missionArea = formData.get('missionArea');
        const operator = formData.get('operator');
        const drone = formData.get('drone');
        const notes = formData.get('notes');

        if (!missionDate || !missionTime || !missionArea || !operator) {
            utils.showToast('Please fill in all required fields', 'error');
            return;
        }

        try {
            // OPTIMIZATION: use the in-memory allMissions array that loadMissions()
            // already fetched, instead of a separate Firestore round-trip.
            // Derived from the highest existing mission number rather than
            // allMissions.length + 1 — length-based numbering reproduces a
            // deleted mission's number (e.g. delete #2 from a list of 5, then
            // create one: length is 4, so "#5" already exists — a duplicate).
            const highestNumber = allMissions.reduce((max, m) => {
                const match = /#(\d+)/.exec(m.missionNumber || '');
                const n = match ? parseInt(match[1], 10) : 0;
                return Number.isFinite(n) && n > max ? n : max;
            }, 0);
            const missionNumber = `MISSION #${highestNumber + 1}`;

            // Format date
            const dateObj = new Date(missionDate);
            const formattedDate = dateObj.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: '2-digit'
            });

            const missionData = {
                userId: currentUserId,
                missionNumber: missionNumber,
                date: formattedDate,
                time: missionTime,
                drone: drone || 'DJI Mavic 3 Multispectral',
                area: missionArea,
                operator: operator,
                duration: '~2h 20m',
                notes: notes || '',
                status: 'scheduled',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            console.log('💾 Saving mission:', missionData);

            await firebase.firestore()
                .collection('missions')
                .add(missionData);

            console.log('✅ Mission created');

            utils.showToast('Mission scheduled successfully!', 'success');
            window.closeAddMissionModal();
            await loadMissions();

        } catch (error) {
            console.error('❌ Error:', error);
            utils.showToast('Failed to schedule mission', 'error');
        }
    };

    // ═══════════════════════════════════════════════════════════
    // EDIT MISSION
    // ═══════════════════════════════════════════════════════════

    window.openEditMissionModal = async function (missionId) {
        try {
            const doc = await firebase.firestore()
                .collection('missions')
                .doc(missionId)
                .get();

            if (!doc.exists) {
                utils.showToast('Mission not found', 'error');
                return;
            }

            // Ownership check — prevent editing another user's mission by ID.
            if (doc.data().userId !== currentUserId) {
                utils.showToast('Access denied', 'error');
                return;
            }

            const data = doc.data();

            // Parse date from "May 09, 2026" to "2026-05-09"
            const dateParts = data.date.split(' ');
            const monthMap = {
                'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
                'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
                'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
            };
            const month = monthMap[dateParts[0]];
            const day = dateParts[1].replace(',', '').padStart(2, '0');
            const year = dateParts[2];
            const formattedDate = `${year}-${month}-${day}`;

            document.getElementById('edit-mission-id').value = missionId;
            document.getElementById('edit-mission-date').value = formattedDate;
            document.getElementById('edit-mission-time').value = data.time;
            document.getElementById('edit-mission-area').value = data.area;
            document.getElementById('edit-mission-operator').value = data.operator;
            document.getElementById('edit-mission-status').value = data.status;
            document.getElementById('edit-mission-notes').value = data.notes || '';

            utils.showModal('edit-mission-modal');

        } catch (error) {
            console.error('❌ Error loading mission:', error);
            utils.showToast('Failed to load mission', 'error');
        }
    };

    window.closeEditMissionModal = function () {
        utils.hideModal('edit-mission-modal');
        document.getElementById('edit-mission-form').reset();
    };

    window.handleEditMission = async function (event) {
        event.preventDefault();

        const form = document.getElementById('edit-mission-form');
        const formData = new FormData(form);

        const missionId = formData.get('missionId');
        const missionDate = formData.get('missionDate');
        const missionTime = formData.get('missionTime');
        const missionArea = formData.get('missionArea');
        const operator = formData.get('operator');
        const status = formData.get('status');
        const notes = formData.get('notes');

        try {
            const dateObj = new Date(missionDate);
            const formattedDate = dateObj.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: '2-digit'
            });

            await firebase.firestore()
                .collection('missions')
                .doc(missionId)
                .update({
                    date: formattedDate,
                    time: missionTime,
                    area: missionArea,
                    operator: operator,
                    status: status,
                    notes: notes || '',
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });

            utils.showToast('Mission updated successfully!', 'success');
            window.closeEditMissionModal();
            await loadMissions();

        } catch (error) {
            console.error('❌ Error updating mission:', error);
            utils.showToast('Failed to update mission', 'error');
        }
    };

})();