/* ========================================
   APP.JS - Core Application Logic
   PineVision Main Controller
   ======================================== */

const app = (function() {
    'use strict';

    // ========================================
    // INITIALIZATION
    // ========================================

    /**
     * Initialize application on page load
     */
    function init() {
        // Check authentication first
        if (!auth.checkAuth()) {
            return; // Will redirect to login
        }

        // Initialize settings (theme & font size)
        utils.initializeSettings();

        // Initialize UI components
        initSidebar();
        initTopbar();
        setActivePage();
        setupPageTransitions();
        initScrollbar();

        // Page-specific initialization
        const currentPage = getCurrentPageName();
        if (typeof window.initPage === 'function') {
            window.initPage();
        }

        console.log('PineVision initialized:', currentPage);
    }

    // ========================================
    // SIDEBAR MANAGEMENT
    // ========================================

    /**
     * Initialize sidebar navigation
     */
    function initSidebar() {
        const session = auth.getSession();
        if (!session) return;

        // Set active link based on current page
        setActivePage();

        // Mobile sidebar toggle
        setupMobileSidebar();

        // Restore sidebar collapsed state from localStorage
        initSidebarCollapse();
    }

    /**
     * Set active state on current page link
     */
    function setActivePage() {
        const currentPath = window.location.pathname;
        const navLinks = document.querySelectorAll('.nav-link');

        navLinks.forEach(link => {
            const linkPath = link.getAttribute('href');

            if (linkPath && currentPath.includes(linkPath)) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
    }

    /**
     * Setup mobile sidebar toggle functionality
     */
    function setupMobileSidebar() {
        // Mobile sidebar is CSS-only, no JS needed
        // Responsive behavior handled by CSS media queries
    }

    // ========================================
    // SIDEBAR COLLAPSE
    // ========================================

    const SIDEBAR_COLLAPSED_KEY = 'pinewatch_sidebar_collapsed';

    /**
     * Restore sidebar collapsed state from localStorage
     */
    function initSidebarCollapse() {
        if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true') {
            document.documentElement.classList.add('sidebar-collapsed');
        }
    }

    /**
     * Toggle sidebar between expanded and collapsed
     */
    function toggleSidebar() {
        const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed);
    }

    // ========================================
    // SCROLLBAR VISIBILITY
    // ========================================

    /**
     * Show scrollbar while scrolling, hide after idle
     */
    function initScrollbar() {
        let scrollTimer;
        const html = document.documentElement;

        window.addEventListener('scroll', function() {
            html.classList.add('is-scrolling');
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(function() {
                html.classList.remove('is-scrolling');
            }, 800);
        }, { passive: true, capture: true });
    }

    /**
     * Intercept internal nav links for fade-out page transition
     */
    function setupPageTransitions() {
        const mainContent = document.querySelector('.main-content');
        if (!mainContent) return;

        document.querySelectorAll('a[href]').forEach(link => {
            const href = link.getAttribute('href');
            if (href && href.endsWith('.html') && !href.startsWith('http')) {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                    mainContent.classList.add('page-exit');
                    setTimeout(() => {
                        window.location.href = link.getAttribute('href');
                    }, 200);
                });
            }
        });
    }

    // ========================================
    // TOPBAR — PAGE CONTEXT & ACCOUNT
    // ========================================

    const ROLE_LABELS = {
        'admin': 'Super Admin',
        'farm_manager': 'Farm Manager',
        'client': 'User'
    };

    // Inline icon paths, reused from the page-specific icons that used to
    // live inline in each page's own header markup — kept centralized here
    // so the topbar icon always matches the active page.
    const TOPBAR_ICONS = {
        dashboard: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
        leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
        clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
        bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
        cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        flight: '<path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/>',
        report: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
        users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
        audit: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
    };

    // Page context shown on the left of the topbar, keyed by the HTML
    // filename (without extension). Some pages read differently depending
    // on the signed-in role, so a per-role override is checked first and
    // falls back to `default`.
    const PAGE_META = {
        'dashboard': {
            icon: 'dashboard',
            admin: { title: 'Super Admin Dashboard', subtitle: 'System overview and flight management control center' },
            farm_manager: { title: 'Farm Manager Dashboard', subtitle: 'Farm management overview and control center' },
            client: { title: 'Dashboard', subtitle: 'Farm-wide overview and key performance indicators' }
        },
        'blocks': {
            icon: 'leaf',
            default: { title: 'Fruit Blocks', subtitle: 'Monitor individual block performance and fruit condition' }
        },
        'blocks-view': {
            icon: 'leaf',
            default: { title: 'Block Detail', subtitle: 'Detailed condition and history for an individual fruit block' }
        },
        'scans': {
            icon: 'clipboard',
            default: { title: 'Scan Log', subtitle: 'Chronological history of all drone scan sessions' }
        },
        'alerts': {
            icon: 'bell',
            client: { title: 'Alerts', subtitle: 'Active flags, resolved issues, and threshold reference' },
            farm_manager: { title: 'Account Alerts', subtitle: 'Security notifications and user access events across all platform accounts' },
            admin: { title: 'Account Alerts', subtitle: 'Security notifications and user access events across all platform accounts' }
        },
        'settings': {
            icon: 'cog',
            client: { title: 'Settings', subtitle: 'Customize your PineVision experience' },
            default: { title: 'Settings', subtitle: 'Manage your PineVision admin preferences' }
        },
        'flights-scans': {
            icon: 'flight',
            default: { title: 'Flights & Scans', subtitle: 'Overview of all drone flight sessions and scan operations' }
        },
        'reports': {
            icon: 'report',
            client: { title: 'Reports', subtitle: 'Generate and review farm performance reports by block, section, or date range' },
            default: { title: 'Reports', subtitle: 'Generated scan reports and analytics summaries' }
        },
        'users': {
            icon: 'users',
            default: { title: 'User Management', subtitle: 'Monitor, manage and configure user accounts and access levels' }
        },
        'activity': {
            icon: 'activity',
            default: { title: 'Activity Log', subtitle: 'Full record of all system activity with filtering and search' }
        },
        'auditlogs': {
            icon: 'audit',
            default: { title: 'Audit Logs', subtitle: 'Complete record of all system activity, access events, and user actions' }
        }
    };

    /**
     * Resolve { icon, title, subtitle } for the current page + role.
     */
    function getPageMeta(pageKey, role) {
        const entry = PAGE_META[pageKey];
        if (!entry) return null;

        const copy = entry[role] || entry.default || entry.client;
        if (!copy) return null;

        return { icon: entry.icon || 'dashboard', title: copy.title, subtitle: copy.subtitle };
    }

    /**
     * Initialize the topbar: left-side page context (icon/title/subtitle)
     * and right-side signed-in account controls (avatar/name/role/menu).
     * No-ops on pages that opt out of the shared app shell (no .topbar
     * element present), such as the full-screen drone-view page.
     */
    function initTopbar() {
        const session = auth.getSession();
        if (!session) return;

        const topbar = document.querySelector('.topbar');
        if (!topbar) return;

        // ---- Left: page context ----
        const pageKey = getCurrentPageName();
        const meta = getPageMeta(pageKey, session.role);

        const iconEl = topbar.querySelector('.topbar-page-icon');
        const titleEl = topbar.querySelector('.topbar-page-title');
        const subtitleEl = topbar.querySelector('.topbar-page-subtitle');

        const fallbackTitle = document.title.split(' - ')[0] || 'PineVision';

        if (titleEl) titleEl.textContent = meta ? meta.title : fallbackTitle;
        if (subtitleEl) subtitleEl.textContent = meta ? meta.subtitle : '';
        if (iconEl) {
            const iconPath = TOPBAR_ICONS[meta ? meta.icon : 'dashboard'] || TOPBAR_ICONS.dashboard;
            iconEl.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" ' +
                'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                iconPath + '</svg>';
        }

        // ---- Right: signed-in account ----
        const displayName = session.fullName || session.username;
        const roleLabel = ROLE_LABELS[session.role] || session.role;
        const initials = getInitials(displayName);

        const avatarEl = topbar.querySelector('.topbar-account-avatar');
        const nameEl = topbar.querySelector('.topbar-account-name');
        const roleEl = topbar.querySelector('.topbar-account-role');
        const menuNameEl = topbar.querySelector('.topbar-account-menu-name');
        const menuEmailEl = topbar.querySelector('.topbar-account-menu-email');

        if (avatarEl) avatarEl.textContent = initials;
        if (nameEl) nameEl.textContent = displayName;
        if (roleEl) roleEl.textContent = roleLabel;
        if (menuNameEl) menuNameEl.textContent = displayName;
        if (menuEmailEl) menuEmailEl.textContent = session.email || '';

        setupAccountMenu(topbar);
    }

    /**
     * Wire up the account dropdown: click to open/close, outside click to
     * close, Escape to close (returning focus to the trigger), and keep
     * aria-expanded in sync for screen readers.
     */
    function setupAccountMenu(topbar) {
        const trigger = topbar.querySelector('.topbar-account-trigger');
        const menu = topbar.querySelector('.topbar-account-menu');
        if (!trigger || !menu || trigger.dataset.menuBound) return;
        trigger.dataset.menuBound = 'true';

        function openMenu() {
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
        }

        function closeMenu() {
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
        }

        trigger.addEventListener('click', function (e) {
            e.stopPropagation();
            if (menu.hidden) {
                openMenu();
            } else {
                closeMenu();
            }
        });

        document.addEventListener('click', function (e) {
            if (!menu.hidden && !topbar.contains(e.target)) {
                closeMenu();
            }
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !menu.hidden) {
                closeMenu();
                trigger.focus();
            }
        });
    }

    /**
     * Close the account menu and hand off to the app's existing logout
     * confirmation flow (auth.confirmLogout -> auth.logout).
     */
    function handleTopbarLogout() {
        const trigger = document.getElementById('topbar-account-trigger');
        const menu = document.getElementById('topbar-account-menu');
        if (menu) menu.hidden = true;
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        auth.confirmLogout();
    }

    /**
     * Get initials from full name
     */
    function getInitials(name) {
        if (!name) return 'U';

        const parts = name.split(' ');
        if (parts.length >= 2) {
            return parts[0][0] + parts[1][0];
        }
        return name.substring(0, 2).toUpperCase();
    }

    // ========================================
    // UTILITY FUNCTIONS
    // ========================================

    /**
     * Get current page name from URL
     */
    function getCurrentPageName() {
        const path = window.location.pathname;
        const filename = path.substring(path.lastIndexOf('/') + 1);
        return filename.replace('.html', '');
    }

    /**
     * Navigate to a page
     */
    function navigateTo(path) {
        window.location.href = path;
    }

    /**
     * Reload current page
     */
    function reload() {
        window.location.reload();
    }

    // ========================================
    // PUBLIC API
    // ========================================

    return {
        init,
        setActivePage,
        getCurrentPageName,
        navigateTo,
        reload,
        toggleSidebar,
        initTopbar,
        handleTopbarLogout
    };
})();

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
    app.init();
});

// Make app globally available
window.app = app;
