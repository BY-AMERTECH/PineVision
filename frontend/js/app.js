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
        initUserInfo();
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
    // USER INFO DISPLAY
    // ========================================

    const ROLE_LABELS = {
        'admin': 'Super Admin',
        'farm_manager': 'Farm Manager',
        'client': 'User'
    };

    /**
     * Initialize user info in sidebar
     */
    function initUserInfo() {
        const session = auth.getSession();
        if (!session) return;

        // Update user name
        const userNameElements = document.querySelectorAll('.sidebar-user-name');
        userNameElements.forEach(el => {
            el.textContent = session.fullName || session.username;
        });

        // Update user role — show display label, not raw Firestore value
        const userRoleElements = document.querySelectorAll('.sidebar-user-role');
        userRoleElements.forEach(el => {
            el.textContent = ROLE_LABELS[session.role] || session.role;
        });

        // Update user avatar
        const userAvatarElements = document.querySelectorAll('.sidebar-user-avatar');
        userAvatarElements.forEach(el => {
            const initials = getInitials(session.fullName || session.username);
            el.textContent = initials;
        });
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
        toggleSidebar
    };
})();

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', function() {
    app.init();
});

// Make app globally available
window.app = app;
