"""
PineVision backend server.

Serves the frontend static files, /api/drone/* endpoints, and Firebase user management.
Run with:  python app.py
"""

import os
from flask import Flask, send_from_directory, abort, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore, auth

from drone_conn.routes import drone_bp

# Absolute path to the frontend folder (one level up from backend/)
FRONTEND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend'))


def _verify_admin_token():
    """
    Verify the Firebase ID token and confirm the caller has the 'admin'
    (Super Admin) role in Firestore.
    """
    header = request.headers.get('Authorization', '')
    if not header.startswith('Bearer '):
        return None, (jsonify({'error': 'Missing or invalid Authorization header'}), 401)
    id_token = header.split('Bearer ', 1)[1].strip()
    try:
        decoded = auth.verify_id_token(id_token)
    except Exception:
        return None, (jsonify({'error': 'Invalid or expired token'}), 401)

    if not db:
        return None, (jsonify({'error': 'Firebase not initialized'}), 500)

    user_doc = db.collection('users').document(decoded['uid']).get()
    if not user_doc.exists or user_doc.to_dict().get('role') != 'admin':
        return None, (jsonify({'error': 'Super Admin access required'}), 403)

    return decoded, None


def _verify_farm_manager_token():
    """
    Verify the Firebase ID token and confirm the caller has the
    'farm_manager' role in Firestore (Super Admins are NOT granted access
    through this gate — each gate is exclusive to its role).
    Returns (decoded_token, None) on success or (None, error_response) on failure.
    """
    header = request.headers.get('Authorization', '')
    if not header.startswith('Bearer '):
        return None, (jsonify({'error': 'Missing or invalid Authorization header'}), 401)
    id_token = header.split('Bearer ', 1)[1].strip()
    try:
        decoded = auth.verify_id_token(id_token)
    except Exception:
        return None, (jsonify({'error': 'Invalid or expired token'}), 401)

    if not db:
        return None, (jsonify({'error': 'Firebase not initialized'}), 500)

    user_doc = db.collection('users').document(decoded['uid']).get()
    if not user_doc.exists or user_doc.to_dict().get('role') != 'farm_manager':
        return None, (jsonify({'error': 'Farm Manager access required'}), 403)

    return decoded, None
PAGES = os.path.join(FRONTEND, 'pages')

app = Flask(__name__, static_folder=None)
CORS(app)

# Register drone blueprint
app.register_blueprint(drone_bp)

# ═══════════════════════════════════════════════════════════════════════
# FIREBASE INITIALIZATION
# ═══════════════════════════════════════════════════════════════════════

try:
    cred = credentials.Certificate('serviceAccountKey.json')
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("✅ Firebase connected successfully!")
except Exception as e:
    print(f"❌ Firebase initialization error: {e}")
    db = None

# ═══════════════════════════════════════════════════════════════════════
# FIREBASE API ROUTES - User Management
# ═══════════════════════════════════════════════════════════════════════

@app.route('/api/test', methods=['GET'])
def api_test():
    """Test endpoint to verify backend and Firebase connection"""
    return jsonify({
        'message': 'Backend is working!', 
        'status': 'success',
        'firebase': 'connected' if db else 'disconnected'
    }), 200


@app.route('/api/users', methods=['GET'])
def get_users():
    """Get users from Firestore with cursor-based pagination."""
    _, err = _verify_admin_token()
    if err:
        return err

    try:
        page_size = min(int(request.args.get('limit', 50)), 200)
        start_after = request.args.get('startAfter')

        query = db.collection('users').limit(page_size)
        if start_after:
            start_doc = db.collection('users').document(start_after).get()
            if start_doc.exists:
                query = query.start_after(start_doc)

        users = []
        for doc in query.stream():
            user_data = doc.to_dict()
            user_data['id'] = doc.id
            users.append(user_data)

        return jsonify(users), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/users', methods=['POST'])
def create_user():
    """Create new user in Firebase Authentication and Firestore"""
    _, err = _verify_admin_token()
    if err:
        return err

    try:
        data = request.json
        
        # Create user in Firebase Authentication
        user = auth.create_user(
            email=data['email'],
            password=data['password'],
            display_name=data['fullName']
        )
        
        # Save to Firestore
        user_data = {
            'uid': user.uid,
            'fullName': data['fullName'],
            'username': data['username'],
            'email': data['email'],
            'role': data.get('role', 'client'),
            'status': data.get('status', 'active'),
            'permissions': data.get('permissions', []),
            'createdAt': firestore.SERVER_TIMESTAMP,
            'lastLogin': None
        }
        
        db.collection('users').document(user.uid).set(user_data)
        
        return jsonify({
            'message': 'User created successfully',
            'userId': user.uid
        }), 201
        
    except auth.EmailAlreadyExistsError:
        return jsonify({'error': 'Email already exists'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/users/<user_id>', methods=['PUT'])
def update_user(user_id):
    """Update existing user"""
    _, err = _verify_admin_token()
    if err:
        return err

    try:
        data = request.json
        
        # Update Firebase Auth
        auth.update_user(
            user_id,
            email=data.get('email'),
            display_name=data.get('fullName'),
            disabled=(data.get('status') == 'disabled')
        )
        
        # Update Firestore
        db.collection('users').document(user_id).update({
            'fullName': data['fullName'],
            'username': data['username'],
            'email': data['email'],
            'role': data['role'],
            'status': data['status'],
            'permissions': data.get('permissions', []),
            'updatedAt': firestore.SERVER_TIMESTAMP
        })
        
        return jsonify({'message': 'User updated successfully'}), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/users/<user_id>/reset-password', methods=['POST'])
def reset_password(user_id):
    """Reset user password"""
    _, err = _verify_admin_token()
    if err:
        return err

    try:
        data = request.json
        auth.update_user(user_id, password=data['newPassword'])
        return jsonify({'message': 'Password reset successfully'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/users/<user_id>/toggle-status', methods=['POST'])
def toggle_status(user_id):
    """Enable/Disable user account"""
    _, err = _verify_admin_token()
    if err:
        return err

    try:
        # Get current status from Firestore
        user_doc = db.collection('users').document(user_id).get()
        current_status = user_doc.to_dict().get('status', 'active')
        
        # Toggle status
        new_status = 'disabled' if current_status == 'active' else 'active'
        
        # Update Firebase Auth
        auth.update_user(user_id, disabled=(new_status == 'disabled'))
        
        # Update Firestore
        db.collection('users').document(user_id).update({
            'status': new_status,
            'updatedAt': firestore.SERVER_TIMESTAMP
        })
        
        return jsonify({
            'message': f'User {new_status}',
            'status': new_status
        }), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ═══════════════════════════════════════════════════════════════════════
# FARM MANAGER API ROUTES
# These endpoints are accessible only to users with role == "farm_manager".
# They enforce server-side filtering so Farm Managers can never read, create,
# edit, toggle, or reset the password of Super Admin ("admin") accounts.
# ═══════════════════════════════════════════════════════════════════════

@app.route('/api/fm/users', methods=['GET'])
def fm_get_users():
    """Farm Manager: list users — excludes all Super Admin (admin) accounts."""
    _, err = _verify_farm_manager_token()
    if err:
        return err

    try:
        page_size = min(int(request.args.get('limit', 50)), 200)
        start_after = request.args.get('startAfter')

        query = db.collection('users').limit(page_size + 50)  # over-fetch to allow filtering
        if start_after:
            start_doc = db.collection('users').document(start_after).get()
            if start_doc.exists:
                query = query.start_after(start_doc)

        users = []
        for doc in query.stream():
            user_data = doc.to_dict()
            if user_data.get('role') == 'admin':
                continue  # Never expose Super Admin accounts to Farm Managers
            user_data['id'] = doc.id
            users.append(user_data)
            if len(users) >= page_size:
                break

        return jsonify(users), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/fm/users', methods=['POST'])
def fm_create_user():
    """Farm Manager: create a new user — only client or farm_manager roles allowed."""
    _, err = _verify_farm_manager_token()
    if err:
        return err

    try:
        data = request.json
        role = data.get('role', 'client')
        if role == 'admin':
            return jsonify({'error': 'Farm Managers cannot create Super Admin accounts'}), 403

        user = auth.create_user(
            email=data['email'],
            password=data['password'],
            display_name=data['fullName']
        )

        user_data = {
            'uid': user.uid,
            'fullName': data['fullName'],
            'username': data['username'],
            'email': data['email'],
            'role': role,
            'status': data.get('status', 'active'),
            'permissions': data.get('permissions', []),
            'createdAt': firestore.SERVER_TIMESTAMP,
            'lastLogin': None
        }

        db.collection('users').document(user.uid).set(user_data)
        return jsonify({'message': 'User created successfully', 'userId': user.uid}), 201

    except auth.EmailAlreadyExistsError:
        return jsonify({'error': 'Email already exists'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/fm/users/<user_id>', methods=['PUT'])
def fm_update_user(user_id):
    """Farm Manager: update a user — cannot update Super Admin accounts or promote to admin."""
    _, err = _verify_farm_manager_token()
    if err:
        return err

    try:
        target = db.collection('users').document(user_id).get()
        if not target.exists:
            return jsonify({'error': 'User not found'}), 404
        if target.to_dict().get('role') == 'admin':
            return jsonify({'error': 'Farm Managers cannot modify Super Admin accounts'}), 403

        data = request.json
        if data.get('role') == 'admin':
            return jsonify({'error': 'Farm Managers cannot assign the Super Admin role'}), 403

        auth.update_user(
            user_id,
            email=data.get('email'),
            display_name=data.get('fullName'),
            disabled=(data.get('status') == 'disabled')
        )

        db.collection('users').document(user_id).update({
            'fullName': data['fullName'],
            'username': data['username'],
            'email': data['email'],
            'role': data['role'],
            'status': data['status'],
            'permissions': data.get('permissions', []),
            'updatedAt': firestore.SERVER_TIMESTAMP
        })

        return jsonify({'message': 'User updated successfully'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/fm/users/<user_id>/reset-password', methods=['POST'])
def fm_reset_password(user_id):
    """Farm Manager: reset password — cannot reset Super Admin passwords."""
    _, err = _verify_farm_manager_token()
    if err:
        return err

    try:
        target = db.collection('users').document(user_id).get()
        if not target.exists:
            return jsonify({'error': 'User not found'}), 404
        if target.to_dict().get('role') == 'admin':
            return jsonify({'error': 'Farm Managers cannot reset Super Admin passwords'}), 403

        data = request.json
        auth.update_user(user_id, password=data['newPassword'])
        return jsonify({'message': 'Password reset successfully'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/fm/users/<user_id>/toggle-status', methods=['POST'])
def fm_toggle_status(user_id):
    """Farm Manager: toggle user status — cannot toggle Super Admin accounts."""
    _, err = _verify_farm_manager_token()
    if err:
        return err

    try:
        user_doc = db.collection('users').document(user_id).get()
        if not user_doc.exists:
            return jsonify({'error': 'User not found'}), 404
        if user_doc.to_dict().get('role') == 'admin':
            return jsonify({'error': 'Farm Managers cannot modify Super Admin account status'}), 403

        current_status = user_doc.to_dict().get('status', 'active')
        new_status = 'disabled' if current_status == 'active' else 'active'

        auth.update_user(user_id, disabled=(new_status == 'disabled'))
        db.collection('users').document(user_id).update({
            'status': new_status,
            'updatedAt': firestore.SERVER_TIMESTAMP
        })

        return jsonify({'message': f'User {new_status}', 'status': new_status}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ═══════════════════════════════════════════════════════════════════════
# FRONTEND SERVING ROUTES
# ═══════════════════════════════════════════════════════════════════════

@app.route('/')
@app.route('/index.html')
def serve_login():
    """Serve login page"""
    return send_from_directory(PAGES, 'index.html')


@app.route('/client/<path:page>')
def serve_client_page(page):
    """Serve client pages"""
    return _serve_page('client', page)


@app.route('/admin/<path:page>')
def serve_admin_page(page):
    """Serve Super Admin pages"""
    return _serve_page('admin', page)


@app.route('/farm-manager/<path:page>')
def serve_farm_manager_page(page):
    """Serve Farm Manager pages"""
    return _serve_page('farm-manager', page)


def _serve_page(role, page):
    """Helper function to serve role-specific pages"""
    role_dir = os.path.join(PAGES, role)
    target = os.path.normpath(os.path.join(role_dir, page))
    if not target.startswith(role_dir + os.sep) and target != role_dir:
        abort(403)
    if not os.path.isfile(target):
        abort(404)
    return send_from_directory(role_dir, page)


@app.route('/frontend/<path:path>')
def serve_frontend_alias(path):
    """Serve frontend assets with /frontend/ prefix"""
    target = os.path.normpath(os.path.join(FRONTEND, path))
    if not target.startswith(FRONTEND + os.sep) and target != FRONTEND:
        abort(403)
    if not os.path.isfile(target):
        abort(404)
    return send_from_directory(FRONTEND, path)


@app.route('/<path:path>')
def serve_frontend(path):
    """Catch-all: serve anything else directly from frontend/"""
    target = os.path.normpath(os.path.join(FRONTEND, path))
    if not target.startswith(FRONTEND + os.sep) and target != FRONTEND:
        abort(403)
    if not os.path.isfile(target):
        abort(404)
    return send_from_directory(FRONTEND, path)


if __name__ == '__main__':
    print("🚀 Starting PineVision Backend Server...")
    print("📡 Frontend: http://localhost:5000")
    print("🔥 Firebase: User Management API enabled")
    print("🚁 Drone: Endpoints available via /api/drone/*")
    app.run(host='0.0.0.0', port=5000, debug=True)