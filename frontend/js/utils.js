/* ========================================
   UTILS.JS - Helper Functions & Utilities
   PineVision Utility Library
   ======================================== */

var utils = (function() {
    'use strict';

    // ========================================
    // STATUS & COLOR HELPERS
    // ========================================

    /**
     * Get status class based on bearing rate
     */
    function getStatusClass(bearingRate) {
        const thresholds = window.data.getThresholds();
        
        if (bearingRate < thresholds.bearing.critical) {
            return 'crit';
        } else if (bearingRate < thresholds.bearing.watch) {
            return 'warn';
        } else {
            return 'good';
        }
    }

    /**
     * Get status text based on class
     */
    function getStatusText(statusClass) {
        const statusMap = {
            'good': 'Healthy',
            'warn': 'Watch',
            'crit': 'Critical'
        };
        return statusMap[statusClass] || 'Unknown';
    }

    /**
     * Generate status badge HTML
     */
    function statusBadge(status) {
        const text = getStatusText(status);
        return `
            <span class="badge ${status}">
                <span class="bdot"></span>
                ${text}
            </span>
        `;
    }

    /**
     * Get bar color based on percentage and thresholds
     */
    function barColor(percentage) {
        const thresholds = window.data.getThresholds();
        
        if (percentage < thresholds.bearing.critical) {
            return 'var(--red-mid)';
        } else if (percentage < thresholds.bearing.watch) {
            return 'var(--amber-mid)';
        } else {
            return 'var(--green-mid)';
        }
    }

    // ========================================
    // FORMATTING HELPERS
    // ========================================

    /**
     * Format number with commas
     */
    function formatNumber(num) {
        if (num == null || isNaN(num)) return '0';
        return num.toLocaleString('en-US');
    }

    /**
     * Format percentage
     */
    function formatPercent(value, decimals = 1) {
        if (value == null || isNaN(value)) return '0.0%';
        return value.toFixed(decimals) + '%';
    }

    /**
     * Format date - "02 MAY 2026"
     */
    function formatDate(dateString) {
        if (!dateString) return '';
        
        const date = new Date(dateString);
        const day = String(date.getDate()).padStart(2, '0');
        const month = date.toLocaleString('en-US', { month: 'short' }).toUpperCase();
        const year = date.getFullYear();
        
        return `${day} ${month} ${year}`;
    }

    /** Build secondary scan metadata from the block's last completed scan. */
    function recentScanBadge(timestamp) {
        let date = null;
        if (timestamp != null && timestamp !== '') {
            if (typeof timestamp.toDate === 'function') {
                date = timestamp.toDate();
            } else if (typeof timestamp.seconds === 'number') {
                date = new Date(timestamp.seconds * 1000);
            } else {
                date = new Date(timestamp);
            }
        }

        let value = 'No scans yet';
        if (date && !isNaN(date.getTime())) {
            const day = String(date.getDate()).padStart(2, '0');
            const month = date.toLocaleString('en-GB', { month: 'short' });
            const time = date.toLocaleString('en-US', {
                hour: '2-digit', minute: '2-digit', hour12: true
            });
            value = `<time datetime="${date.toISOString()}">${day} ${month} ${date.getFullYear()}, ${time}</time>`;
        } else if (timestamp != null && timestamp !== '') {
            value = 'Date unavailable';
        }

        return `<span class="recent-scan-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            <span>Recent Scan &middot; ${value}</span>
        </span>`;
    }

    /**
     * Format date for input fields - "YYYY-MM-DD"
     */
    function formatDateInput(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        return date.toISOString().split('T')[0];
    }

    /**
     * Format area with unit
     */
    function formatArea(hectares) {
        if (hectares == null || isNaN(hectares)) return '0 ha';
        return hectares.toFixed(1) + ' ha';
    }

    // ========================================
    // DOM BUILDERS
    // ========================================

    /**
     * Build inline bar HTML
     */
    function buildInlineBar(percentage, color, label = null) {
        const displayLabel = label || formatPercent(percentage);
        // Named distinctly from the outer barColor() helper (below) — a
        // `const barColor = color || barColor(percentage)` here would shadow
        // that function in its own initializer and throw a ReferenceError
        // ("Cannot access 'barColor' before initialization") whenever `color`
        // is falsy.
        const resolvedColor = color || barColor(percentage);

        return `
            <div class="ibar">
                <div class="it">
                    <div class="if" style="width: ${percentage}%; background-color: ${resolvedColor};"></div>
                </div>
                <div class="ip">${displayLabel}</div>
            </div>
        `;
    }

    /**
     * Build metric card HTML
     */
    function buildMetricCard(label, value, subtext = '', modifier = '') {
        return `
            <div class="col">
                <div class="mc ${modifier}">
                    <div class="mc-label">${label}</div>
                    <div class="mc-val">${value}</div>
                    ${subtext ? `<div class="mc-sub">${subtext}</div>` : ''}
                </div>
            </div>
        `;
    }

    /**
     * Build stat row for block cards
     */
    function buildStatRow(label, value) {
        return `
            <div class="bcard-stat-row">
                <span class="bcard-stat-label">${label}</span>
                <span class="bcard-stat-value">${value}</span>
            </div>
        `;
    }

    // ========================================
    // VALIDATION HELPERS
    // ========================================

    /**
     * Check if value is within watch threshold
     */
    function isWatch(value, metric) {
        const thresholds = window.data.getThresholds();
        
        if (metric === 'bearing') {
            return value >= thresholds.bearing.critical && value < thresholds.bearing.watch;
        } else if (metric === 'discolored') {
            return value > thresholds.discolored.watch && value <= thresholds.discolored.critical;
        }
        
        return false;
    }

    /**
     * Check if value is critical
     */
    function isCritical(value, metric) {
        const thresholds = window.data.getThresholds();
        
        if (metric === 'bearing') {
            return value < thresholds.bearing.critical;
        } else if (metric === 'discolored') {
            return value > thresholds.discolored.critical;
        }
        
        return false;
    }

    // ========================================
    // MODAL HELPERS
    // ========================================

    /**
     * Show modal
     */
    function showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'flex';
            document.body.style.overflow = 'hidden';
        }
    }

    /**
     * Hide modal
     */
    function hideModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'none';
            document.body.style.overflow = '';
        }
    }

    /**
     * Close modal on overlay click
     */
    function setupModalClose(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;

        modal.addEventListener('click', function(e) {
            if (e.target === modal) {
                hideModal(modalId);
            }
        });

        // Close on ESC key
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                hideModal(modalId);
            }
        });
    }

    // ========================================
    // FORM HELPERS
    // ========================================

    /**
     * Get form data as object
     */
    function getFormData(formId) {
        const form = document.getElementById(formId);
        if (!form) return {};

        const formData = new FormData(form);
        const data = {};

        for (let [key, value] of formData.entries()) {
            data[key] = value;
        }

        return data;
    }

    /**
     * Reset form
     */
    function resetForm(formId) {
        const form = document.getElementById(formId);
        if (form) {
            form.reset();
        }
    }

    /**
     * Show form error
     */
    function showFormError(formId, message) {
        const form = document.getElementById(formId);
        if (!form) return;

        let errorDiv = form.querySelector('.form-error');
        if (!errorDiv) {
            errorDiv = document.createElement('div');
            errorDiv.className = 'form-error';
            form.insertBefore(errorDiv, form.firstChild);
        }

        errorDiv.textContent = message;
        errorDiv.style.display = 'block';

        setTimeout(() => {
            errorDiv.style.display = 'none';
        }, 5000);
    }

    // ========================================
    // TOAST NOTIFICATIONS
    // ========================================

    /**
     * Show toast notification
     */
    function showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('show');
        }, 100);

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                document.body.removeChild(toast);
            }, 300);
        }, 3000);
    }

    // ========================================
    // LOADING STATE
    // ========================================

    /**
     * Show loading spinner
     */
    function showLoading(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = `
            <div class="loading-spinner">
                <div class="spinner"></div>
                <p>Loading...</p>
            </div>
        `;
    }

    /**
     * Hide loading spinner
     */
    function hideLoading(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const spinner = container.querySelector('.loading-spinner');
        if (spinner) {
            spinner.remove();
        }
    }

    // ========================================
    // LOCAL STORAGE HELPERS
    // ========================================

    /**
     * Save to localStorage
     */
    function saveToStorage(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('Error saving to localStorage:', e);
            return false;
        }
    }

    /**
     * Get from localStorage
     */
    function getFromStorage(key) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : null;
        } catch (e) {
            console.error('Error reading from localStorage:', e);
            return null;
        }
    }

    /**
     * Remove from localStorage
     */
    function removeFromStorage(key) {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (e) {
            console.error('Error removing from localStorage:', e);
            return false;
        }
    }

    // ========================================
    // SETTINGS MANAGEMENT
    // ========================================

    const SETTINGS_KEY = 'pinevision_settings';
    const DEFAULT_SETTINGS = {
        theme: 'light',
        fontSize: 'medium'
    };

    /**
     * Get current settings
     */
    function getSettings() {
        const settings = getFromStorage(SETTINGS_KEY);
        return settings || DEFAULT_SETTINGS;
    }

    /**
     * Save settings
     */
    function saveSettings(settings) {
        return saveToStorage(SETTINGS_KEY, settings);
    }

    /**
     * Update specific setting
     */
    function updateSetting(key, value) {
        const settings = getSettings();
        settings[key] = value;
        saveSettings(settings);
        return settings;
    }

    /**
     * Apply theme (light/dark)
     */
    function applyTheme(theme) {
        const html = document.documentElement;
        
        if (theme === 'dark') {
            html.classList.add('dark-mode');
        } else {
            html.classList.remove('dark-mode');
        }
        
        updateSetting('theme', theme);
    }

    /**
     * Apply font size scaling
     */
    function applyFontSize(size) {
        const html = document.documentElement;
        
        // Remove existing font size classes
        html.classList.remove('font-small', 'font-medium', 'font-large', 'font-xlarge');
        
        // Add new font size class
        if (size !== 'medium') {
            html.classList.add('font-' + size);
        }
        
        updateSetting('fontSize', size);
    }

    /**
     * Initialize settings on page load
     */
    function initializeSettings() {
        const settings = getSettings();
        applyTheme(settings.theme);
        applyFontSize(settings.fontSize);
    }

    /**
     * Toggle theme (light <-> dark)
     */
    function toggleTheme() {
        const currentTheme = getSettings().theme;
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        applyTheme(newTheme);
        return newTheme;
    }

    /**
     * Get theme label
     */
    function getThemeLabel(theme) {
        return theme === 'dark' ? 'Dark Mode' : 'Light Mode';
    }

    /**
     * Get font size label
     */
    function getFontSizeLabel(size) {
        const labels = {
            'small': 'Small',
            'medium': 'Medium',
            'large': 'Large',
            'xlarge': 'Extra Large'
        };
        return labels[size] || 'Medium';
    }

    // ========================================
    // PUBLIC API
    // ========================================

    return {
        // Status & Color
        getStatusClass,
        getStatusText,
        statusBadge,
        barColor,
        
        // Formatting
        formatNumber,
        formatPercent,
        formatDate,
        recentScanBadge,
        formatDateInput,
        formatArea,
        
        // DOM Builders
        buildInlineBar,
        buildMetricCard,
        buildStatRow,
        
        // Validation
        isWatch,
        isCritical,
        
        // Modal
        showModal,
        hideModal,
        setupModalClose,
        
        // Forms
        getFormData,
        resetForm,
        showFormError,
        
        // Toast
        showToast,
        
        // Loading
        showLoading,
        hideLoading,
        
        // Storage
        saveToStorage,
        getFromStorage,
        removeFromStorage,
        
        // Settings
        getSettings,
        saveSettings,
        updateSetting,
        applyTheme,
        applyFontSize,
        initializeSettings,
        toggleTheme,
        getThemeLabel,
        getFontSizeLabel
    };
})();

// Make utils globally available
window.utils = utils;
