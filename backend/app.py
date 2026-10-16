"""
PineVision backend server.

Serves the frontend static files, /api/drone/* endpoints, and Firebase user management.
Run with:  python app.py
"""

import sys
# Force UTF-8 stdout/stderr so emoji in detection.py print() calls never raise
# UnicodeEncodeError on Windows terminals that default to cp1252.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import os
import re
from datetime import date
from flask import Flask, send_from_directory, abort, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore, auth
import requests

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

def _verify_block_owner(block_id):
    header = request.headers.get('Authorization', '')
    if not header.startswith('Bearer ') or not db:
        return None, None, (jsonify({'ok': False, 'message': 'Sign in again to continue.'}), 401)
    try:
        decoded = auth.verify_id_token(header.split('Bearer ', 1)[1].strip())
        user = db.collection('users').document(decoded['uid']).get()
        block = db.collection('blocks').document(block_id).get()
    except Exception:
        return None, None, (jsonify({'ok': False, 'message': 'Unable to verify access.'}), 401)
    if not user.exists or user.to_dict().get('role') != 'client':
        return None, None, (jsonify({'ok': False, 'message': 'Client access required.'}), 403)
    if not block.exists or block.to_dict().get('userId') != decoded['uid']:
        return None, None, (jsonify({'ok': False, 'message': 'Block not found.'}), 404)
    user_data = user.to_dict()
    decoded['displayName'] = user_data.get('username') or user_data.get('name') or user_data.get('email')
    return decoded, block, None


def _valid_crop_date(value, label):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError(label + ' must be a valid date.')
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise ValueError(label + ' must be a valid date.')
    if parsed > date.today():
        raise ValueError(label + ' cannot be in the future.')
    return value


def _date_is_before(first, second):
    try:
        return date.fromisoformat(first) < date.fromisoformat(second)
    except (TypeError, ValueError):
        # Legacy records may contain display-formatted dates; preserve them and
        # enforce ordering once both values are stored in the new ISO format.
        return False


def _crop_actor(decoded):
    return decoded.get('displayName') or decoded.get('name') or decoded.get('email') or decoded.get('uid')


@app.route('/api/blocks/<block_id>/cycles', methods=['GET', 'POST'])
def block_cycles(block_id):
    decoded, block, error = _verify_block_owner(block_id)
    if error:
        return error
    block_ref = db.collection('blocks').document(block_id)
    if request.method == 'GET':
        cycles = []
        for snap in block_ref.collection('cycles').order_by('createdAt').stream():
            item = snap.to_dict()
            item['id'] = snap.id
            for key in ('createdAt', 'updatedAt', 'harvestedAt'):
                if item.get(key) and hasattr(item[key], 'isoformat'):
                    item[key] = item[key].isoformat()
            cycles.append(item)
        block_data = block.to_dict()
        return jsonify({'ok': True, 'cycles': cycles, 'activeCycleId': block_data.get('activeCycleId'),
                        'latestCycleId': block_data.get('latestCycleId'),
                        'legacyCurrent': not block_data.get('latestCycleId') and bool(block_data.get('planted') or block_data.get('forcingDate'))}), 200

    body = request.get_json(silent=True) or {}
    try:
        planting = _valid_crop_date(body.get('plantingDate'), 'Planting date')
        forcing = body.get('forcingDate')
        if forcing:
            forcing = _valid_crop_date(forcing, 'Forcing date')
            if forcing < planting:
                raise ValueError('Forcing date cannot be before planting date.')
    except ValueError as exc:
        return jsonify({'ok': False, 'message': str(exc)}), 400
    cycle_ref = block_ref.collection('cycles').document()
    transaction = db.transaction()
    @firestore.transactional
    def create_cycle(txn):
        latest = txn.get(block_ref)
        latest_data = latest.to_dict()
        if latest_data.get('activeCycleId'):
            raise ValueError('Complete the current crop cycle before starting another.')
        now = firestore.SERVER_TIMESTAMP
        # Preserve pre-cycle-schema dates before updating the legacy block fields.
        if latest_data.get('planted') or latest_data.get('forcingDate'):
            legacy_ref = block_ref.collection('cycles').document()
            txn.set(legacy_ref, {'plantingDate': latest_data.get('planted') or '',
                                 'forcingDate': latest_data.get('forcingDate') or '',
                                 'status': 'completed', 'legacy': True, 'createdAt': now,
                                 'updatedAt': now, 'createdBy': _crop_actor(decoded)})
        txn.set(cycle_ref, {'plantingDate': planting, 'forcingDate': forcing or '', 'daf': 0, 'status': 'active',
                            'createdAt': now, 'updatedAt': now, 'createdBy': _crop_actor(decoded)})
        txn.update(block_ref, {'activeCycleId': cycle_ref.id, 'latestCycleId': cycle_ref.id, 'planted': planting,
                               'forcingDate': forcing or '', 'daf': 0})
        audit = cycle_ref.collection('history').document()
        txn.set(audit, {'type': 'Crop Cycle Started', 'field': 'plantingDate', 'previousValue': '',
                        'newValue': planting, 'updatedBy': _crop_actor(decoded), 'updatedAt': now,
                        'cropCycleId': cycle_ref.id})
        if forcing:
            txn.set(cycle_ref.collection('history').document(), {'type': 'forcingDate Updated',
                    'field': 'forcingDate', 'previousValue': '', 'newValue': forcing,
                    'updatedBy': _crop_actor(decoded), 'updatedAt': now, 'cropCycleId': cycle_ref.id})
    try:
        create_cycle(transaction)
    except ValueError as exc:
        return jsonify({'ok': False, 'message': str(exc)}), 409
    except Exception:
        return jsonify({'ok': False, 'message': 'Could not start crop cycle.'}), 500
    return jsonify({'ok': True, 'cycleId': cycle_ref.id}), 201


@app.route('/api/blocks/<block_id>/cycles/<cycle_id>', methods=['PATCH'])
def update_block_cycle(block_id, cycle_id):
    decoded, block, error = _verify_block_owner(block_id)
    if error:
        return error
    body = request.get_json(silent=True) or {}
    allowed = {'plantingDate', 'forcingDate', 'daf'}
    if set(body) != {'field', 'value'} or body.get('field') not in allowed:
        return jsonify({'ok': False, 'message': 'Choose exactly one supported field to update.'}), 400
    field = body['field']
    try:
        if field == 'daf':
            value = body['value']
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError('Growth Stage (DAF) must be a whole number of 0 or more.')
        else:
            value = _valid_crop_date(body['value'], field.replace('Date', ' date'))
    except ValueError as exc:
        return jsonify({'ok': False, 'message': str(exc)}), 400
    block_ref = db.collection('blocks').document(block_id)
    cycle_ref = block_ref.collection('cycles').document(cycle_id)
    transaction = db.transaction()
    @firestore.transactional
    def update_cycle(txn):
        cycle = txn.get(cycle_ref)
        if not cycle.exists or cycle.to_dict().get('status') != 'active' or block.to_dict().get('activeCycleId') != cycle_id:
            raise ValueError('Only the current active crop cycle can be corrected.')
        old = cycle.to_dict().get(field, '') or ''
        other = cycle.to_dict().get('forcingDate' if field == 'plantingDate' else 'plantingDate', '') or ''
        if field == 'forcingDate' and other and _date_is_before(value, other):
            raise ValueError('Forcing date cannot be before planting date.')
        if field == 'plantingDate' and other and _date_is_before(other, value):
            raise ValueError('Planting date cannot be after forcing date.')
        now = firestore.SERVER_TIMESTAMP
        txn.update(cycle_ref, {field: value, 'updatedAt': now})
        block_field = {'plantingDate': 'planted', 'forcingDate': 'forcingDate', 'daf': 'daf'}[field]
        txn.update(block_ref, {block_field: value})
        audit = cycle_ref.collection('history').document()
        txn.set(audit, {'type': field + ' Updated', 'field': field, 'previousValue': old,
                        'newValue': value, 'updatedBy': _crop_actor(decoded), 'updatedAt': now,
                        'cropCycleId': cycle_id})
    try:
        update_cycle(transaction)
    except ValueError as exc:
        return jsonify({'ok': False, 'message': str(exc)}), 400
    except Exception:
        return jsonify({'ok': False, 'message': 'Could not update crop cycle.'}), 500
    return jsonify({'ok': True}), 200


@app.route('/api/blocks/<block_id>/cycles/legacy-correction', methods=['POST'])
def correct_legacy_block_cycle(block_id):
    decoded, block, error = _verify_block_owner(block_id)
    if error:
        return error
    body = request.get_json(silent=True) or {}
    if set(body) != {'field', 'value'} or body.get('field') not in {'plantingDate', 'forcingDate', 'daf'}:
        return jsonify({'ok': False, 'message': 'Choose exactly one supported field to update.'}), 400
    field = body['field']
    try:
        if field == 'daf':
            value = body['value']
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError('Growth Stage (DAF) must be a whole number of 0 or more.')
        else:
            value = _valid_crop_date(body['value'], field.replace('Date', ' date'))
    except ValueError as exc:
        return jsonify({'ok': False, 'message': str(exc)}), 400
    block_ref = db.collection('blocks').document(block_id)
    if list(block_ref.collection('cycles').limit(1).stream()):
        return jsonify({'ok': False, 'message': 'This block already has crop cycle history. Select its current cycle or start a new cycle.'}), 409
    transaction = db.transaction()
    @firestore.transactional
    def materialize_legacy(txn):
        latest = txn.get(block_ref)
        data = latest.to_dict()
        if data.get('activeCycleId') or data.get('latestCycleId'):
            raise ValueError('A crop cycle was added while this update was open. Reload and try again.')
        planting = data.get('planted') or ''
        forcing = data.get('forcingDate') or ''
        if field == 'forcingDate' and planting and _date_is_before(value, planting):
            raise ValueError('Forcing date cannot be before planting date.')
        if field == 'plantingDate' and forcing and _date_is_before(forcing, value):
            raise ValueError('Planting date cannot be after forcing date.')
        now = firestore.SERVER_TIMESTAMP
        cycle_ref = block_ref.collection('cycles').document()
        cycle_data = {'plantingDate': planting, 'forcingDate': forcing, 'daf': data.get('daf', 0),
                      'status': 'active', 'legacy': True, 'createdAt': now, 'updatedAt': now,
                      'createdBy': _crop_actor(decoded)}
        final_value = value
        cycle_data[field] = final_value
        txn.set(cycle_ref, cycle_data)
        block_field = {'plantingDate': 'planted', 'forcingDate': 'forcingDate', 'daf': 'daf'}[field]
        txn.update(block_ref, {'activeCycleId': cycle_ref.id, 'latestCycleId': cycle_ref.id,
                               block_field: final_value})
        txn.set(cycle_ref.collection('history').document(), {'type': 'Legacy Cycle Recorded',
                'field': 'plantingDate', 'previousValue': '', 'newValue': planting,
                'updatedBy': _crop_actor(decoded), 'updatedAt': now, 'cropCycleId': cycle_ref.id})
        previous = data.get(block_field, '')
        txn.set(cycle_ref.collection('history').document(), {'type': field + ' Updated', 'field': field,
                'previousValue': previous, 'newValue': final_value, 'updatedBy': _crop_actor(decoded),
                'updatedAt': now, 'cropCycleId': cycle_ref.id})
    try:
        materialize_legacy(transaction)
    except ValueError as exc:
        return jsonify({'ok': False, 'message': str(exc)}), 409
    except Exception:
        return jsonify({'ok': False, 'message': 'Could not update legacy crop information.'}), 500
    return jsonify({'ok': True}), 200


@app.route('/api/blocks/<block_id>/cycles/<cycle_id>/history', methods=['GET'])
def get_block_cycle_history(block_id, cycle_id):
    _, block, error = _verify_block_owner(block_id)
    if error:
        return error
    cycle_ref = db.collection('blocks').document(block_id).collection('cycles').document(cycle_id)
    if not cycle_ref.get().exists:
        return jsonify({'ok': False, 'message': 'Crop cycle not found.'}), 404
    history = []
    for snap in cycle_ref.collection('history').order_by('updatedAt').stream():
        item = snap.to_dict()
        item['id'] = snap.id
        if item.get('updatedAt') and hasattr(item['updatedAt'], 'isoformat'):
            item['updatedAt'] = item['updatedAt'].isoformat()
        history.append(item)
    return jsonify({'ok': True, 'history': history}), 200


@app.route('/api/blocks/<block_id>/cycles/<cycle_id>/close', methods=['POST'])
def close_block_cycle(block_id, cycle_id):
    decoded, block, error = _verify_block_owner(block_id)
    if error:
        return error
    body = request.get_json(silent=True) or {}
    try:
        harvested = _valid_crop_date(body.get('harvestedAt'), 'Harvest date')
    except ValueError as exc:
        return jsonify({'ok': False, 'message': str(exc)}), 400
    block_ref = db.collection('blocks').document(block_id)
    cycle_ref = block_ref.collection('cycles').document(cycle_id)
    transaction = db.transaction()
    @firestore.transactional
    def close_cycle(txn):
        cycle = txn.get(cycle_ref)
        if not cycle.exists or cycle.to_dict().get('status') != 'active' or block.to_dict().get('activeCycleId') != cycle_id:
            raise ValueError('This crop cycle is not active.')
        planting = cycle.to_dict().get('plantingDate', '')
        if _date_is_before(harvested, planting):
            raise ValueError('Harvest date cannot be before planting date.')
        forcing = cycle.to_dict().get('forcingDate', '')
        if forcing and _date_is_before(harvested, forcing):
            raise ValueError('Harvest date cannot be before forcing date.')
        now = firestore.SERVER_TIMESTAMP
        txn.update(cycle_ref, {'status': 'completed', 'harvestedAt': harvested, 'updatedAt': now,
                               'completedBy': _crop_actor(decoded)})
        txn.update(block_ref, {'activeCycleId': firestore.DELETE_FIELD})
        txn.set(cycle_ref.collection('history').document(), {'type': 'Crop Cycle Completed',
                'field': 'status', 'previousValue': 'active', 'newValue': 'completed',
                'updatedBy': _crop_actor(decoded), 'updatedAt': now, 'cropCycleId': cycle_id})
    try:
        close_cycle(transaction)
    except ValueError as exc:
        return jsonify({'ok': False, 'message': str(exc)}), 400
    except Exception:
        return jsonify({'ok': False, 'message': 'Could not complete crop cycle.'}), 500
    return jsonify({'ok': True}), 200

@app.route('/api/test', methods=['GET'])
def api_test():
    """Test endpoint to verify backend and Firebase connection"""
    return jsonify({
        'message': 'Backend is working!', 
        'status': 'success',
        'firebase': 'connected' if db else 'disconnected'
    }), 200


@app.route('/api/auth/password-reset', methods=['POST'])
def request_password_reset():
    """Send Firebase's password reset email for a username or email address."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    identifier = data.get('identifier', '')
    if not isinstance(identifier, str) or not identifier.strip():
        return jsonify({'error': 'Username or email is required'}), 400

    identifier = identifier.strip()
    email = identifier if '@' in identifier else None

    if email is None:
        if not db:
            return jsonify({'error': 'Password reset is temporarily unavailable'}), 503
        try:
            matches = db.collection('users').where('username', '==', identifier).limit(1).get()
            if matches:
                email = (matches[0].to_dict() or {}).get('email')
        except Exception as error:
            print(f"❌ Password reset lookup failed: {error}")
            return jsonify({'error': 'Password reset is temporarily unavailable'}), 503

    # Keep the response the same for unknown usernames/emails to avoid account discovery.
    if not email:
        return jsonify({'message': 'If an account matches those details, you’ll receive a password reset email.'}), 200

    try:
        response = requests.post(
            'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode',
            params={'key': 'AIzaSyBQT2B0OHvBeoDgEWGt9dnMfpeu_D1T34c'},
            json={'requestType': 'PASSWORD_RESET', 'email': email},
            timeout=10,
        )
    except requests.RequestException as error:
        print(f"❌ Firebase password reset request failed: {error}")
        return jsonify({'error': 'Password reset is temporarily unavailable'}), 503

    if response.ok:
        return jsonify({'message': 'If an account matches those details, you’ll receive a password reset email.'}), 200

    try:
        error_data = response.json().get('error', {})
    except ValueError:
        error_data = {}
    error_code = error_data.get('message', '')
    if error_code in ('EMAIL_NOT_FOUND', 'INVALID_EMAIL'):
        return jsonify({'message': 'If an account matches those details, you’ll receive a password reset email.'}), 200
    if error_code == 'TOO_MANY_ATTEMPTS_TRY_LATER':
        return jsonify({'error': 'Too many reset requests. Please try again later.'}), 429

    print(f"❌ Firebase password reset failed: {error_code or response.status_code}")
    return jsonify({'error': 'Password reset is temporarily unavailable'}), 503


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

    # Pre-initialize the YOLO detector before accepting any HTTP requests.
    # With debug=True Werkzeug spawns a child process (WERKZEUG_RUN_MAIN=true)
    # that actually handles requests; the parent is only the file-change watcher.
    # Initializing in the child ensures the model loads exactly once, before the
    # first upload request arrives, without wasting time in the watcher process.
    if os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        from drone_conn.detection import get_detector as _get_detector
        print("📦 Pre-initializing YOLO detector...")
        try:
            _get_detector()
            print("✅ YOLO detector ready")
        except Exception as _exc:
            print(f"⚠️  Detector pre-initialization failed: {_exc}")
            print("   Upload requests will return a proper JSON error if the model cannot load.")

    app.run(host='0.0.0.0', port=5000, debug=True)
