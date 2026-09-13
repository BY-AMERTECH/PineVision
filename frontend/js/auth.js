/**
 * Authentication module - Firebase-connected version
 */
var auth = (function () {
    "use strict";

    const SESSION_KEY = "pinevision_session";
    const REMEMBER_KEY = "pinevision_remember";

    // Firebase configuration
    const firebaseConfig = {
        apiKey: "AIzaSyBQT2B0OHvBeoDgEWGt9dnMfpeu_D1T34c",
        authDomain: "pinevision-632aa.firebaseapp.com",
        projectId: "pinevision-632aa",
        storageBucket: "pinevision-632aa.firebasestorage.app",
        messagingSenderId: "409081336673",
        appId: "1:409081336673:web:bf1ae3924437753f60eb20",
        measurementId: "G-QYX398ZYRZ"
    };

    // Initialize Firebase (only if not already initialized)
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }

    const firebaseAuth = firebase.auth();
    const db = firebase.firestore();

    /**
     * Show error message in the UI
     */
    function showError(message) {
        const errorDiv = document.getElementById("error-message");
        const errorText = document.getElementById("error-text");
        if (errorDiv && errorText) {
            errorText.textContent = message;
            errorDiv.style.display = "flex";
            setTimeout(function () {
                errorDiv.style.display = "none";
            }, 5000);
        }
    }

    /**
     * Show loading state on login button
     */
    function setLoading(loading) {
        const btn = document.getElementById("login-btn");
        if (!btn) return;

        const btnText = btn.querySelector(".btn-text");
        const btnLoader = btn.querySelector(".btn-loader");

        if (loading) {
            btn.disabled = true;
            if (btnText) btnText.style.display = "none";
            if (btnLoader) btnLoader.style.display = "flex";
        } else {
            btn.disabled = false;
            if (btnText) btnText.style.display = "block";
            if (btnLoader) btnLoader.style.display = "none";
        }
    }

    /**
     * Save session data
     */
    function saveSession(user, remember) {
        const sessionData = {
            uid: user.uid,
            email: user.email,
            role: user.role,
            fullName: user.fullName,
            username: user.username,
            loginTime: new Date().toISOString(),
        };

        sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));

        if (remember) {
            localStorage.setItem(REMEMBER_KEY, JSON.stringify(sessionData));
        }
    }

    /**
     * Get current session
     */
    function getSession() {
        const session = sessionStorage.getItem(SESSION_KEY);
        if (session) return JSON.parse(session);

        const remembered = localStorage.getItem(REMEMBER_KEY);
        if (remembered) {
            const data = JSON.parse(remembered);
            sessionStorage.setItem(SESSION_KEY, remembered);
            return data;
        }

        return null;
    }

    /**
     * Check if user is logged in and redirect if on login page
     */
    function checkExistingSession() {
        const session = getSession();
        if (session && window.location.pathname.includes("index.html")) {
            redirectToDashboard(session.role);
        }
    }

    /**
     * Redirect to appropriate dashboard based on role
     */
    function redirectToDashboard(role) {
        if (role === "admin") {
            window.location.href = "/admin/dashboard.html";
        } else if (role === "farm_manager") {
            window.location.href = "/farm-manager/dashboard.html";
        } else {
            window.location.href = "/client/dashboard.html";
        }
    }

    /**
     * Require authentication - redirect to login if not logged in
     */
    function requireAuth() {
        const session = getSession();
        if (!session) {
            window.location.href = "/index.html";
            return false;
        }
        return true;
    }

    /**
     * Require Super Admin role (admin) - redirect if not super admin
     */
    function requireSuperAdmin() {
        if (!requireAuth()) return false;
        const session = getSession();
        if (session.role !== "admin") {
            redirectToDashboard(session.role);
            return false;
        }
        return true;
    }

    /**
     * Require Farm Manager role - redirect if not farm_manager
     */
    function requireFarmManager() {
        if (!requireAuth()) return false;
        const session = getSession();
        if (session.role !== "farm_manager") {
            redirectToDashboard(session.role);
            return false;
        }
        return true;
    }

    /**
     * Require admin role - redirect if not admin (kept for compatibility; same as requireSuperAdmin)
     */
    function requireAdmin() {
        return requireSuperAdmin();
    }

    /**
     * Record an authenticated user's activity in Firestore.
     */
    async function logActivity(action, extra) {
        const user = getSession();
        if (!user) return;

        await db.collection('activity_logs').add(Object.assign({
            userId: user.uid,
            user: user.username,
            action: action,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            status: 'success',
            email: user.email,
            role: user.role
        }, extra || {}));
    }

    /**
     * Login function - connects to Firebase
     * Accepts username OR email
     */
    async function login(usernameOrEmail, password, remember) {
        setLoading(true);

        try {
            let email = usernameOrEmail;

            // Check if input is a username (no @ sign)
            if (usernameOrEmail.indexOf('@') === -1) {
                console.log('Username detected, looking up email...');

                const usersSnapshot = await db.collection('users')
                    .where('username', '==', usernameOrEmail)
                    .limit(1)
                    .get();

                if (usersSnapshot.empty) {
                    throw new Error('Invalid username or password');
                }

                const userData = usersSnapshot.docs[0].data();
                email = userData.email;
                console.log('Found email:', email);
            }

            // Now sign in with email and password
            const userCredential = await firebaseAuth.signInWithEmailAndPassword(email, password);
            const firebaseUser = userCredential.user;

            // Get user data from Firestore
            const userDoc = await db.collection("users").doc(firebaseUser.uid).get();

            if (!userDoc.exists) {
                throw new Error("User data not found in database");
            }

            const userData = userDoc.data();

            // Check if account is disabled
            if (userData.status === "disabled") {
                await firebaseAuth.signOut();
                throw new Error("Your account has been disabled. Please contact an administrator.");
            }

            // Prepare user data for session
            const user = {
                uid: firebaseUser.uid,
                email: userData.email,
                fullName: userData.fullName,
                username: userData.username,
                role: userData.role,
                permissions: userData.permissions || []
            };

            // Save session
            saveSession(user, remember);

            // lastLogin update and activity log are independent — run in parallel
            try {
                await Promise.all([
                    db.collection("users").doc(firebaseUser.uid).update({
                        lastLogin: firebase.firestore.FieldValue.serverTimestamp()
                    }),
                    db.collection('activity_logs').add({
                        userId: user.uid,
                        user: user.username,
                        action: 'login',
                        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                        status: 'success',
                        email: user.email,
                        role: user.role
                    }),
                ]);
                console.log('✅ Login activity logged to Firestore');
            } catch (logError) {
                console.error('Failed to log activity:', logError);
            }

            // Redirect based on role
            setTimeout(function () {
                redirectToDashboard(user.role);
            }, 500);

        } catch (error) {
            setLoading(false);

            // ⭐ LOG FAILED LOGIN ATTEMPT ⭐
            // Track attempts in sessionStorage — no Firestore read needed
            var attemptKey = 'failed_attempts_' + usernameOrEmail;
            var attempts = parseInt(sessionStorage.getItem(attemptKey) || '0') + 1;
            sessionStorage.setItem(attemptKey, attempts);
            console.log('Failed attempts for ' + usernameOrEmail + ':', attempts);

            // Activity log and alert write are independent — run in parallel
            try {
                await Promise.all([
                    db.collection('activity_logs').add({
                        user: usernameOrEmail,
                        action: 'login_failed',
                        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                        status: 'error',
                        email: usernameOrEmail,
                        role: 'unknown',
                        details: 'Failed login attempt — ' + (error.code || 'unknown'),
                        device: navigator.userAgent || 'Unknown device',
                        errorCode: error.code || 'unknown'
                    }),
                    db.collection('alerts').add({
                        alertId: 'alert_' + Date.now(),
                        severity: attempts >= 3 ? 'critical' : 'warning',
                        type: 'Failed Login',
                        title: attempts >= 3 ? 'Multiple Failed Login Attempts' : 'Failed Login Attempt',
                        user: usernameOrEmail,
                        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                        resolved: false,
                        details: attempts >= 3
                            ? attempts + ' failed login attempts detected'
                            : 'Invalid login credentials provided',
                        device: navigator.userAgent
                    }),
                ]);
                console.log('❌ Failed login attempt logged');
            } catch (logError) {
                console.error('Could not log failed attempt:', logError);
            }

            // Handle specific Firebase errors
            let errorMessage = "Login failed. Please try again.";

            if (error.code === "auth/user-not-found" ||
                error.code === "auth/wrong-password" ||
                error.code === "auth/invalid-login-credentials") {
                errorMessage = "Invalid username or password. Please try again.";
            } else if (error.code === "auth/too-many-requests") {
                errorMessage = "Too many failed attempts. Please try again later.";
            } else if (error.code === "auth/network-request-failed") {
                errorMessage = "Network error. Please check your connection";
            } else if (error.message) {
                errorMessage = error.message;
            }

            showError(errorMessage);
            console.error("Login error:", error);
        }
    }

    /**
     * Logout function
     */
    async function logout() {
        // Clear cached Firestore data before signing out so a subsequent
        // login as a different user never sees the previous user's data.
        if (window.pvCache) window.pvCache.invalidateAll();
        try {
            try {
                await logActivity('logout');
                console.log('Logout activity logged to Firestore');
            } catch (logError) {
                console.error('Failed to log logout activity:', logError);
            }

            await firebaseAuth.signOut();
            sessionStorage.removeItem(SESSION_KEY);
            localStorage.removeItem(REMEMBER_KEY);
            window.location.href = "/index.html";
        } catch (error) {
            console.error("Logout error:", error);
            // Force logout even if Firebase fails
            sessionStorage.removeItem(SESSION_KEY);
            localStorage.removeItem(REMEMBER_KEY);
            window.location.href = "/index.html";
        }
    }

    /**
     * Get current user info
     */
    function getCurrentUser() {
        return getSession();
    }

    function confirmLogout() {
        const MODAL_ID = 'pv-logout-modal';
        if (!document.getElementById(MODAL_ID)) {
            const modal = document.createElement('div');
            modal.id = MODAL_ID;
            modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;align-items:center;justify-content:center;';
            modal.innerHTML =
                '<div onclick="auth.closeLogoutModal()" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(2px);"></div>' +
                '<div style="position:relative;background:var(--color-background-primary);border:1px solid var(--color-border-secondary);border-radius:var(--radius-lg);padding:var(--space-2xl);width:360px;max-width:90vw;box-shadow:var(--shadow-md);text-align:center;">' +
                    '<div style="width:48px;height:48px;border-radius:50%;background:var(--red-bg);display:flex;align-items:center;justify-content:center;margin:0 auto var(--space-lg);">' +
                        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
                    '</div>' +
                    '<h3 style="font-size:var(--font-size-lg);font-weight:var(--font-weight-semibold);color:var(--color-text-primary);margin-bottom:var(--space-sm);">Confirm Logout</h3>' +
                    '<p style="font-size:var(--font-size-sm);color:var(--color-text-secondary);margin-bottom:var(--space-xl);">Are you sure you want to log out of your session?</p>' +
                    '<div style="display:flex;gap:var(--space-md);justify-content:center;">' +
                        '<button onclick="auth.closeLogoutModal()" class="btn btn-secondary" style="flex:1;">Cancel</button>' +
                        '<button onclick="auth.logout()" class="btn btn-danger" style="flex:1;background:var(--red-mid);color:#fff;border-color:var(--red-mid);">Yes, Logout</button>' +
                    '</div>' +
                '</div>';
            document.body.appendChild(modal);
        }
        const modal = document.getElementById(MODAL_ID);
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    function closeLogoutModal() {
        const modal = document.getElementById('pv-logout-modal');
        if (modal) {
            modal.style.display = 'none';
            document.body.style.overflow = '';
        }
    }

    // Public API
    return {
        login: login,
        logout: logout,
        confirmLogout: confirmLogout,
        closeLogoutModal: closeLogoutModal,
        requireAuth: requireAuth,
        requireAdmin: requireAdmin,
        requireSuperAdmin: requireSuperAdmin,
        requireFarmManager: requireFarmManager,
        checkExistingSession: checkExistingSession,
        getCurrentUser: getCurrentUser,
        getSession: getSession,
        checkAuth: requireAuth,
    };
})();
