/* ========================================
   DATA.JS - Mock Data Arrays
   PineVision Data Layer (API-ready)
   ======================================== */

// ========================================
// BLOCKS DATA
// ========================================

const BLOCKS = [
    {
        id: 1,
        stage: 'Plant Crop',
        planted: 'Jan 2024',
        forcingDate: 'Aug 15, 2024',
        area: 2.8,
        plants: 12450,
        declaredPopulation: 12500,
        bearing: 87.5,
        nonbearing: 8.2,
        discolored: 4.3,
        section: 'North A',
        status: 'good',
        daf: 245,  // Days After Forcing
        flightDuration: '~17m'
    },
    {
        id: 2,
        stage: 'Ratoon 1',
        planted: 'Mar 2023',
        forcingDate: 'Jun 20, 2024',
        area: 3.2,
        plants: 14230,
        declaredPopulation: 14500,
        bearing: 72.1,
        nonbearing: 18.4,
        discolored: 9.5,
        section: 'North B',
        status: 'warn',
        daf: 301,
        flightDuration: '~20m'
    },
    {
        id: 3,
        stage: 'Plant Crop',
        planted: 'Feb 2024',
        forcingDate: 'Sep 5, 2024',
        area: 2.5,
        plants: 11120,
        declaredPopulation: 11200,
        bearing: 91.2,
        nonbearing: 5.8,
        discolored: 3.0,
        section: 'South A',
        status: 'good',
        daf: 224,
        flightDuration: '~15m'
    },
    {
        id: 4,
        stage: 'Ratoon 2',
        planted: 'Aug 2022',
        forcingDate: 'May 10, 2024',
        area: 4.1,
        plants: 18240,
        declaredPopulation: 18500,
        bearing: 58.3,
        nonbearing: 26.7,
        discolored: 15.0,
        section: 'South B',
        status: 'crit',
        daf: 342,
        flightDuration: '~25m'
    },
    {
        id: 5,
        stage: 'Plant Crop',
        planted: 'Jan 2024',
        forcingDate: 'Aug 22, 2024',
        area: 3.0,
        plants: 13340,
        declaredPopulation: 13400,
        bearing: 85.0,
        nonbearing: 10.2,
        discolored: 4.8,
        section: 'East A',
        status: 'good',
        daf: 238,
        flightDuration: '~18m'
    },
    {
        id: 6,
        stage: 'Ratoon 1',
        planted: 'Apr 2023',
        forcingDate: 'Jul 1, 2024',
        area: 3.5,
        plants: 15580,
        declaredPopulation: 15800,
        bearing: 68.9,
        nonbearing: 21.3,
        discolored: 9.8,
        section: 'East B',
        status: 'warn',
        daf: 290,
        flightDuration: '~22m'
    },
    {
        id: 7,
        stage: 'Plant Crop',
        planted: 'Dec 2023',
        forcingDate: 'Jul 28, 2024',
        area: 2.9,
        plants: 12890,
        declaredPopulation: 13000,
        bearing: 89.4,
        nonbearing: 7.1,
        discolored: 3.5,
        section: 'West A',
        status: 'good',
        daf: 263,
        flightDuration: '~18m'
    },
    {
        id: 8,
        stage: 'Ratoon 1',
        planted: 'May 2023',
        forcingDate: 'Jun 15, 2024',
        area: 3.8,
        plants: 16920,
        declaredPopulation: 17100,
        bearing: 74.2,
        nonbearing: 16.8,
        discolored: 9.0,
        section: 'West B',
        status: 'good',
        daf: 306,
        flightDuration: '~23m'
    }
];

// ========================================
// SCAN HISTORY DATA
// ========================================

const SCANS = [
    {
        id: 1,
        day: '02',
        month: 'MAY',
        year: '2026',
        title: 'Weekly Farm Scan - Week 18',
        bearing: 78.9,
        nonbearing: 14.3,
        discolored: 6.8,
        plants: 104770,
        operator: 'Juan Dela Cruz',
        drone: 'DJI Mavic 3 Multispectral',
        time: '06:15',
        duration: '2h 18m',
        blocks: 8,
        weather: 'Clear'
    },
    {
        id: 2,
        day: '25',
        month: 'APR',
        year: '2026',
        title: 'Weekly Farm Scan - Week 17',
        bearing: 77.2,
        nonbearing: 15.1,
        discolored: 7.7,
        plants: 104770,
        operator: 'Maria Santos',
        drone: 'DJI Mavic 3 Multispectral',
        time: '06:30',
        duration: '2h 22m',
        blocks: 8,
        weather: 'Partly Cloudy'
    },
    {
        id: 3,
        day: '18',
        month: 'APR',
        year: '2026',
        title: 'Weekly Farm Scan - Week 16',
        bearing: 75.8,
        nonbearing: 16.2,
        discolored: 8.0,
        plants: 104770,
        operator: 'Juan Dela Cruz',
        drone: 'DJI Mavic 3 Multispectral',
        time: '06:20',
        duration: '2h 15m',
        blocks: 8,
        weather: 'Clear'
    },
    {
        id: 4,
        day: '11',
        month: 'APR',
        year: '2026',
        title: 'Weekly Farm Scan - Week 15',
        bearing: 74.1,
        nonbearing: 17.3,
        discolored: 8.6,
        plants: 104770,
        operator: 'Pedro Reyes',
        drone: 'DJI Mavic 3 Multispectral',
        time: '06:25',
        duration: '2h 20m',
        blocks: 8,
        weather: 'Light Rain'
    },
    {
        id: 5,
        day: '04',
        month: 'APR',
        year: '2026',
        title: 'Weekly Farm Scan - Week 14',
        bearing: 72.5,
        nonbearing: 18.8,
        discolored: 8.7,
        plants: 104770,
        operator: 'Maria Santos',
        drone: 'DJI Mavic 3 Multispectral',
        time: '06:10',
        duration: '2h 25m',
        blocks: 8,
        weather: 'Clear'
    },
    {
        id: 6,
        day: '28',
        month: 'MAR',
        year: '2026',
        title: 'Weekly Farm Scan - Week 13',
        bearing: 71.3,
        nonbearing: 19.5,
        discolored: 9.2,
        plants: 104770,
        operator: 'Juan Dela Cruz',
        drone: 'DJI Mavic 3 Multispectral',
        time: '06:35',
        duration: '2h 30m',
        blocks: 8,
        weather: 'Partly Cloudy'
    }
];

// ========================================
// TREND HISTORY DATA (6 scans)
// ========================================

const HIST = [
    {
        date: 'Mar 28',
        pcts: [85.2, 68.5, 89.1, 54.2, 82.3, 65.4, 87.2, 71.8]
    },
    {
        date: 'Apr 04',
        pcts: [86.1, 69.8, 89.8, 55.8, 83.1, 66.2, 88.0, 72.5]
    },
    {
        date: 'Apr 11',
        pcts: [86.8, 70.5, 90.4, 56.9, 83.8, 67.1, 88.6, 73.1]
    },
    {
        date: 'Apr 18',
        pcts: [87.0, 71.2, 90.8, 57.5, 84.2, 67.8, 89.0, 73.6]
    },
    {
        date: 'Apr 25',
        pcts: [87.3, 71.8, 91.0, 57.9, 84.6, 68.4, 89.2, 73.9]
    },
    {
        date: 'May 02',
        pcts: [87.5, 72.1, 91.2, 58.3, 85.0, 68.9, 89.4, 74.2]
    }
];

// ========================================
// ALERTS DATA
// ========================================

const ALERTS = [
    {
        id: 1,
        severity: 'crit',
        block: 'Block 4 (Ratoon 2)',
        title: 'Critical Bearing Rate',
        description: 'Bearing rate dropped to 58.3%, below critical threshold of 60%. High discoloration detected at 15.0%. Recommend immediate field inspection and agronomic intervention.',
        detectedDate: 'May 02, 2026',
        method: 'Automated Threshold Check',
        operator: 'System Auto-Flag',
        resolved: false
    },
    {
        id: 2,
        severity: 'warn',
        block: 'Block 2 (Ratoon 1)',
        title: 'Watch: Below Target Bearing',
        description: 'Bearing rate at 72.1%, below watch threshold of 75%. Non-bearing population increased to 18.4%. Monitor for next scan cycle.',
        detectedDate: 'May 02, 2026',
        method: 'Automated Threshold Check',
        operator: 'System Auto-Flag',
        resolved: false
    },
    {
        id: 3,
        severity: 'warn',
        block: 'Block 6 (Ratoon 1)',
        title: 'Watch: Below Target Bearing',
        description: 'Bearing rate at 68.9%, below watch threshold of 75%. Discoloration at 9.8%. Field inspection recommended.',
        detectedDate: 'May 02, 2026',
        method: 'Automated Threshold Check',
        operator: 'System Auto-Flag',
        resolved: false
    },
    {
        id: 4,
        severity: 'ok',
        block: 'Block 1 (Plant Crop)',
        title: 'Resolved: Bearing Rate Improved',
        description: 'Bearing rate recovered to 87.5% after intervention. Previously flagged for watch at 73.2%. Irrigation adjustment successful.',
        detectedDate: 'Apr 18, 2026',
        resolvedDate: 'Apr 25, 2026',
        method: 'Manual Review',
        operator: 'Farm Manager',
        resolved: true
    }
];

// ========================================
// THRESHOLD CONFIGURATION
// ========================================

const THRESHOLDS = {
    bearing: {
        critical: 60,  // Below 60% = Critical
        watch: 75      // Below 75% = Watch
    },
    nonbearing: {
        critical: 25,  // Above 25% = Critical
        watch: 20      // Above 20% = Watch
    },
    discolored: {
        critical: 12,  // Above 12% = Critical
        watch: 8       // Above 8% = Watch
    }
};

// ========================================
// USERS DATA (Admin Only)
// ========================================

const USERS = [
    {
        id: 1,
        username: 'admin',
        fullName: 'Admin User',
        email: 'admin@pinewatch.ph',
        role: 'admin',
        status: 'active',
        createdAt: '2024-01-15T08:30:00Z',
        lastLogin: '2026-05-02T06:15:00Z',
        permissions: ['all']
    },
    {
        id: 2,
        username: 'client',
        fullName: 'User',
        email: 'client@pinewatch.ph',
        role: 'client',
        status: 'active',
        createdAt: '2024-01-20T10:45:00Z',
        lastLogin: '2026-05-01T14:22:00Z',
        permissions: ['view_dashboard', 'view_blocks', 'view_scans', 'view_alerts']
    },
    {
        id: 3,
        username: 'manager',
        fullName: 'Farm Manager',
        email: 'manager@pinewatch.ph',
        role: 'client',
        status: 'active',
        createdAt: '2024-02-01T09:15:00Z',
        lastLogin: '2026-04-30T11:30:00Z',
        permissions: ['view_dashboard', 'view_blocks', 'view_scans', 'view_alerts']
    },
    {
        id: 4,
        username: 'operator',
        fullName: 'Drone User',
        email: 'operator@pinewatch.ph',
        role: 'client',
        status: 'active',
        createdAt: '2024-02-15T13:20:00Z',
        lastLogin: '2026-05-02T05:45:00Z',
        permissions: ['view_dashboard', 'view_scans']
    },
    {
        id: 5,
        username: 'analyst',
        fullName: 'Data Analyst',
        email: 'analyst@pinewatch.ph',
        role: 'client',
        status: 'active',
        createdAt: '2024-03-01T11:00:00Z',
        lastLogin: '2026-04-28T16:10:00Z',
        permissions: ['view_dashboard', 'view_blocks', 'view_scans']
    },
    {
        id: 6,
        username: 'supervisor',
        fullName: 'Field Supervisor',
        email: 'supervisor@pinewatch.ph',
        role: 'client',
        status: 'disabled',
        createdAt: '2024-01-25T14:30:00Z',
        lastLogin: '2026-03-15T09:20:00Z',
        permissions: ['view_dashboard', 'view_blocks']
    }
];

// ========================================
// ACTIVITY LOGS (Admin Only)
// ========================================

const ACTIVITY_LOGS = [
    {
        id: 1,
        timestamp: '2026-05-02T06:15:00Z',
        user: 'admin',
        action: 'login',
        details: 'Successful login from 192.168.1.100',
        status: 'success'
    },
    {
        id: 2,
        timestamp: '2026-05-02T06:20:00Z',
        user: 'admin',
        action: 'view_users',
        details: 'Accessed user management page',
        status: 'success'
    },
    {
        id: 3,
        timestamp: '2026-05-02T05:45:00Z',
        user: 'operator',
        action: 'login',
        details: 'Successful login from 192.168.1.105',
        status: 'success'
    },
    {
        id: 4,
        timestamp: '2026-05-01T14:22:00Z',
        user: 'client',
        action: 'view_dashboard',
        details: 'Accessed main dashboard',
        status: 'success'
    },
    {
        id: 5,
        timestamp: '2026-05-01T14:25:00Z',
        user: 'client',
        action: 'view_blocks',
        details: 'Viewed fruit blocks page',
        status: 'success'
    },
    {
        id: 6,
        timestamp: '2026-05-01T10:30:00Z',
        user: 'unknown',
        action: 'login_failed',
        details: 'Failed login attempt - invalid password',
        status: 'error'
    },
    {
        id: 7,
        timestamp: '2026-04-30T16:45:00Z',
        user: 'admin',
        action: 'update_user',
        details: 'Updated user: supervisor (status changed to disabled)',
        status: 'success'
    },
    {
        id: 8,
        timestamp: '2026-04-30T11:30:00Z',
        user: 'manager',
        action: 'view_alerts',
        details: 'Accessed alerts page',
        status: 'success'
    }
];

// ========================================
// SYSTEM STATS (Admin Dashboard)
// ========================================

const SYSTEM_STATS = {
    totalUsers: USERS.length,
    activeUsers: USERS.filter(u => u.status === 'active').length,
    totalBlocks: BLOCKS.length,
    totalScans: SCANS.length,
    activeAlerts: ALERTS.filter(a => !a.resolved).length,
    systemUptime: '45 days',
    lastBackup: '2026-05-01T02:00:00Z',
    storageUsed: '2.3 GB',
    storageTotal: '10 GB'
};

// ========================================
// DATA GETTER FUNCTIONS (API-ready)
// ========================================

/**
 * Get all blocks
 */
function getBlocks() {
    return BLOCKS;
}

/**
 * Get single block by ID
 */
function getBlockById(id) {
    return BLOCKS.find(block => block.id === id);
}

/**
 * Get all scan history
 */
function getScans() {
    return SCANS;
}

/**
 * Get scan by ID
 */
function getScanById(id) {
    return SCANS.find(scan => scan.id === id);
}

/**
 * Get latest scan
 */
function getLatestScan() {
    return SCANS[0];
}

/**
 * Get trend history
 */
function getHistory() {
    return HIST;
}

/**
 * Get all alerts
 */
function getAlerts() {
    return ALERTS;
}

/**
 * Get active alerts only
 */
function getActiveAlerts() {
    return ALERTS.filter(alert => !alert.resolved);
}

/**
 * Get thresholds
 */
function getThresholds() {
    return THRESHOLDS;
}

/**
 * Get all users (admin only)
 */
function getUsers() {
    return USERS;
}

/**
 * Get user by ID
 */
function getUserById(id) {
    return USERS.find(user => user.id === id);
}

/**
 * Get user by username
 */
function getUserByUsername(username) {
    return USERS.find(user => user.username === username);
}

/**
 * Get activity logs (admin only)
 */
function getActivityLogs(limit = 50) {
    return ACTIVITY_LOGS.slice(0, limit);
}

/**
 * Get system stats (admin only)
 */
function getSystemStats() {
    return SYSTEM_STATS;
}

/**
 * Search users by query
 */
function searchUsers(query) {
    if (!query) return USERS;
    
    const lowerQuery = query.toLowerCase();
    return USERS.filter(user => 
        user.username.toLowerCase().includes(lowerQuery) ||
        user.fullName.toLowerCase().includes(lowerQuery) ||
        user.email.toLowerCase().includes(lowerQuery)
    );
}

/**
 * Calculate farm-wide totals
 */
function getFarmTotals() {
    const totalPlants = BLOCKS.reduce((sum, block) => sum + block.plants, 0);
    const totalDeclared = BLOCKS.reduce((sum, block) => sum + block.declaredPopulation, 0);
    const totalArea = BLOCKS.reduce((sum, block) => sum + block.area, 0);
    
    // Weighted averages
    const avgBearing = BLOCKS.reduce((sum, block) => sum + (block.bearing * block.plants), 0) / totalPlants;
    const avgNonbearing = BLOCKS.reduce((sum, block) => sum + (block.nonbearing * block.plants), 0) / totalPlants;
    const avgDiscolored = BLOCKS.reduce((sum, block) => sum + (block.discolored * block.plants), 0) / totalPlants;
    
    return {
        totalPlants,
        totalDeclared,
        totalArea,
        avgBearing,
        avgNonbearing,
        avgDiscolored,
        blockCount: BLOCKS.length
    };
}

// Make functions globally available
window.data = {
    getBlocks,
    getBlockById,
    getScans,
    getScanById,
    getLatestScan,
    getHistory,
    getAlerts,
    getActiveAlerts,
    getThresholds,
    getFarmTotals,
    // Admin functions
    getUsers,
    getUserById,
    getUserByUsername,
    searchUsers,
    getActivityLogs,
    getSystemStats
};

