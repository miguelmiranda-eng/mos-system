"""
Test suite for Email/Password Authentication - Iteration 48
Tests:
- POST /api/auth/login - email/password login
- POST /api/auth/create-user - admin creates user with email/password
- POST /api/auth/forgot-password - password reset request
- POST /api/auth/reset-password - reset password with token
- GET /api/auth/me - returns user without password_hash
- GET /api/users - returns user list without password_hash
- POST /api/auth/session - Google OAuth flow (unchanged)
- auth_type field validation
"""

import pytest
import requests
import os
import uuid
from passlib.hash import bcrypt
from pymongo import MongoClient
from datetime import datetime, timezone, timedelta

# Use production URL for testing
BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://production-crm-1.preview.emergentagent.com').rstrip('/')
MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')

# Test data prefix for cleanup
TEST_PREFIX = "TEST_AUTH_"


@pytest.fixture(scope="module")
def mongo_client():
    """MongoDB connection for direct database operations."""
    client = MongoClient(MONGO_URL)
    yield client
    client.close()


@pytest.fixture(scope="module")
def db(mongo_client):
    """Get the test database."""
    return mongo_client[DB_NAME]


@pytest.fixture
def api_client():
    """Shared requests session."""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


@pytest.fixture(scope="module")
def admin_user_and_session(mongo_client):
    """Create admin user and session for testing admin endpoints."""
    db = mongo_client[DB_NAME]
    admin_email = f"{TEST_PREFIX}admin_{uuid.uuid4().hex[:8]}@test.com"
    admin_user_id = f"user_{uuid.uuid4().hex[:12]}"
    session_token = f"test_session_{uuid.uuid4().hex}"
    
    # Create admin user in DB
    admin_user = {
        "user_id": admin_user_id,
        "email": admin_email,
        "name": "Test Admin",
        "role": "admin",
        "auth_type": "email",
        "password_hash": bcrypt.hash("adminpass123"),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    db.users.update_one({"email": admin_email}, {"$set": admin_user}, upsert=True)
    
    # Create session
    session_doc = {
        "user_id": admin_user_id,
        "session_token": session_token,
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    db.user_sessions.insert_one(session_doc)
    
    yield {"email": admin_email, "user_id": admin_user_id, "session_token": session_token}
    
    # Cleanup
    db.users.delete_one({"email": admin_email})
    db.user_sessions.delete_one({"session_token": session_token})


@pytest.fixture
def admin_client(api_client, admin_user_and_session):
    """Session with admin auth cookie."""
    api_client.cookies.set("session_token", admin_user_and_session["session_token"])
    return api_client


@pytest.fixture(scope="module")
def test_email_user(mongo_client):
    """Create a test user with email/password for login tests."""
    db = mongo_client[DB_NAME]
    email = f"{TEST_PREFIX}user_{uuid.uuid4().hex[:8]}@test.com"
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    password = "testpass123"
    
    user_doc = {
        "user_id": user_id,
        "email": email,
        "name": "Test Email User",
        "role": "user",
        "auth_type": "email",
        "password_hash": bcrypt.hash(password),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    db.users.update_one({"email": email}, {"$set": user_doc}, upsert=True)
    
    yield {"email": email, "user_id": user_id, "password": password}
    
    # Cleanup
    db.users.delete_one({"email": email})


@pytest.fixture
def cleanup_test_users(db):
    """Cleanup TEST_ prefixed users after each test."""
    yield
    db.users.delete_many({"email": {"$regex": f"^{TEST_PREFIX}"}})
    db.password_resets.delete_many({"email": {"$regex": f"^{TEST_PREFIX}"}})


class TestEmailLogin:
    """Tests for POST /api/auth/login endpoint."""
    
    def test_login_success(self, api_client, test_email_user):
        """Test successful login with correct email and password."""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": test_email_user["email"],
            "password": test_email_user["password"]
        })
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        # Verify user data is returned
        assert "email" in data
        assert data["email"] == test_email_user["email"]
        assert "user_id" in data
        assert "name" in data
        assert "auth_type" in data
        assert data["auth_type"] == "email"
        
        # CRITICAL: password_hash should NOT be in response
        assert "password_hash" not in data, "password_hash should not be returned in login response"
        
        # Verify session cookie is set
        assert "session_token" in response.cookies or response.headers.get("set-cookie"), \
            "Session cookie should be set on successful login"
        print(f"✅ Login success test passed - user {test_email_user['email']}")
    
    def test_login_wrong_password(self, api_client, test_email_user):
        """Test login with wrong password returns 401."""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": test_email_user["email"],
            "password": "wrongpassword123"
        })
        
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        data = response.json()
        assert "detail" in data
        assert "Credenciales invalidas" in data["detail"] or "Invalid" in data["detail"]
        print("✅ Login wrong password test passed - 401 returned")
    
    def test_login_nonexistent_email(self, api_client):
        """Test login with non-existent email returns 401."""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": "nonexistent_user_xyz@example.com",
            "password": "somepassword"
        })
        
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("✅ Login nonexistent email test passed - 401 returned")
    
    def test_login_missing_fields(self, api_client):
        """Test login with missing fields returns 400."""
        # Missing password
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": "test@example.com"
        })
        assert response.status_code == 400, f"Expected 400 for missing password, got {response.status_code}"
        
        # Missing email
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "password": "somepass"
        })
        assert response.status_code == 400, f"Expected 400 for missing email, got {response.status_code}"
        print("✅ Login missing fields test passed - 400 returned")


class TestAdminCreateUser:
    """Tests for POST /api/auth/create-user endpoint (admin only)."""
    
    def test_create_user_success(self, admin_client, db, cleanup_test_users):
        """Test admin can create user with email/password."""
        new_email = f"{TEST_PREFIX}newuser_{uuid.uuid4().hex[:8]}@test.com"
        
        response = admin_client.post(f"{BASE_URL}/api/auth/create-user", json={
            "email": new_email,
            "password": "newpass123",
            "name": "New User",
            "role": "user"
        })
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        assert "message" in data
        assert "user_id" in data
        assert new_email in data["message"]
        
        # Verify user in database
        user = db.users.find_one({"email": new_email})
        assert user is not None, "User should exist in database"
        assert user["auth_type"] == "email", "auth_type should be 'email'"
        assert "password_hash" in user, "password_hash should be stored"
        assert bcrypt.verify("newpass123", user["password_hash"]), "Password should be correctly hashed"
        
        print(f"✅ Admin create user success - {new_email}")
    
    def test_create_user_invalid_email(self, admin_client):
        """Test create user with invalid email returns 400."""
        response = admin_client.post(f"{BASE_URL}/api/auth/create-user", json={
            "email": "invalidemail",
            "password": "pass123456",
            "name": "Bad User"
        })
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        assert "Email invalido" in response.json().get("detail", "")
        print("✅ Create user invalid email test passed")
    
    def test_create_user_short_password(self, admin_client):
        """Test create user with password < 6 chars returns 400."""
        response = admin_client.post(f"{BASE_URL}/api/auth/create-user", json={
            "email": f"{TEST_PREFIX}short@test.com",
            "password": "12345",  # Only 5 chars
            "name": "Short Pass User"
        })
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        assert "6 caracteres" in response.json().get("detail", "")
        print("✅ Create user short password test passed")
    
    def test_create_user_duplicate_email(self, admin_client, test_email_user):
        """Test create user with existing email returns 400."""
        response = admin_client.post(f"{BASE_URL}/api/auth/create-user", json={
            "email": test_email_user["email"],  # Already exists
            "password": "newpass123",
            "name": "Duplicate User"
        })
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        assert "ya existe" in response.json().get("detail", "")
        print("✅ Create user duplicate email test passed")
    
    def test_create_user_unauthorized(self, api_client):
        """Test non-admin cannot create user."""
        response = api_client.post(f"{BASE_URL}/api/auth/create-user", json={
            "email": f"{TEST_PREFIX}unauth@test.com",
            "password": "pass123456",
            "name": "Unauth User"
        })
        
        # Should fail without session (401) or if not admin (403)
        assert response.status_code in [401, 403], f"Expected 401/403, got {response.status_code}"
        print("✅ Create user unauthorized test passed")


class TestForgotPassword:
    """Tests for POST /api/auth/forgot-password endpoint."""
    
    def test_forgot_password_existing_user(self, api_client, test_email_user, db):
        """Test forgot password for existing email user returns reset link."""
        response = api_client.post(f"{BASE_URL}/api/auth/forgot-password", json={
            "email": test_email_user["email"]
        })
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        assert "message" in data
        
        # Since RESEND_API_KEY is not configured, reset_link should be returned
        assert "reset_link" in data, "reset_link should be returned when RESEND_API_KEY is not configured"
        assert "token=" in data["reset_link"], "reset_link should contain token"
        
        # Verify token in database
        reset_doc = db.password_resets.find_one({"email": test_email_user["email"]})
        assert reset_doc is not None, "Reset token should be stored in database"
        assert reset_doc["used"] == False, "Token should not be marked as used"
        
        print(f"✅ Forgot password test passed - reset link returned")
        return data["reset_link"]
    
    def test_forgot_password_nonexistent_email(self, api_client):
        """Test forgot password for non-existent email (security - same response)."""
        response = api_client.post(f"{BASE_URL}/api/auth/forgot-password", json={
            "email": "nonexistent_user_xyz@example.com"
        })
        
        # Should return success message for security (don't reveal if email exists)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert "message" in data
        print("✅ Forgot password non-existent email test passed (same response for security)")
    
    def test_forgot_password_google_user(self, api_client, db):
        """Test forgot password for Google auth user (no password_hash)."""
        # Create a Google user
        google_email = f"{TEST_PREFIX}google_{uuid.uuid4().hex[:8]}@test.com"
        db.users.insert_one({
            "user_id": f"user_{uuid.uuid4().hex[:12]}",
            "email": google_email,
            "name": "Google User",
            "auth_type": "google",
            # No password_hash
            "created_at": datetime.now(timezone.utc).isoformat()
        })
        
        response = api_client.post(f"{BASE_URL}/api/auth/forgot-password", json={
            "email": google_email
        })
        
        # Should return success message (security) but no reset link since user has no password
        assert response.status_code == 200
        # Cleanup
        db.users.delete_one({"email": google_email})
        print("✅ Forgot password for Google user test passed")


class TestResetPassword:
    """Tests for POST /api/auth/reset-password endpoint."""
    
    def test_reset_password_success(self, api_client, test_email_user, db):
        """Test reset password with valid token."""
        # First request a reset
        forgot_resp = api_client.post(f"{BASE_URL}/api/auth/forgot-password", json={
            "email": test_email_user["email"]
        })
        assert forgot_resp.status_code == 200
        reset_link = forgot_resp.json().get("reset_link", "")
        token = reset_link.split("token=")[-1].split("&")[0] if reset_link else None
        
        assert token, "Should have a reset token"
        
        # Reset the password
        new_password = "newpassword789"
        response = api_client.post(f"{BASE_URL}/api/auth/reset-password", json={
            "token": token,
            "password": new_password
        })
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "Contrasena actualizada" in data.get("message", "")
        
        # Verify token is now marked as used
        reset_doc = db.password_resets.find_one({"token": token})
        assert reset_doc["used"] == True, "Token should be marked as used"
        
        # Verify new password works
        login_resp = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": test_email_user["email"],
            "password": new_password
        })
        assert login_resp.status_code == 200, "Should be able to login with new password"
        
        # Restore original password for other tests
        db.users.update_one(
            {"email": test_email_user["email"]},
            {"$set": {"password_hash": bcrypt.hash(test_email_user["password"])}}
        )
        
        print("✅ Reset password success test passed")
    
    def test_reset_password_invalid_token(self, api_client):
        """Test reset password with invalid token returns 400."""
        response = api_client.post(f"{BASE_URL}/api/auth/reset-password", json={
            "token": "invalidtoken123456",
            "password": "newpass123"
        })
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        assert "invalido" in response.json().get("detail", "").lower() or "expirado" in response.json().get("detail", "").lower()
        print("✅ Reset password invalid token test passed")
    
    def test_reset_password_used_token(self, api_client, test_email_user, db):
        """Test reset password with already used token returns 400."""
        # Create a used token
        used_token = f"used_token_{uuid.uuid4().hex}"
        db.password_resets.insert_one({
            "email": test_email_user["email"],
            "token": used_token,
            "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "used": True
        })
        
        response = api_client.post(f"{BASE_URL}/api/auth/reset-password", json={
            "token": used_token,
            "password": "newpass123"
        })
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        
        # Cleanup
        db.password_resets.delete_one({"token": used_token})
        print("✅ Reset password used token test passed")
    
    def test_reset_password_expired_token(self, api_client, test_email_user, db):
        """Test reset password with expired token returns 400."""
        expired_token = f"expired_token_{uuid.uuid4().hex}"
        db.password_resets.insert_one({
            "email": test_email_user["email"],
            "token": expired_token,
            "expires_at": (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),  # Already expired
            "used": False
        })
        
        response = api_client.post(f"{BASE_URL}/api/auth/reset-password", json={
            "token": expired_token,
            "password": "newpass123"
        })
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        assert "expirado" in response.json().get("detail", "").lower()
        
        # Cleanup
        db.password_resets.delete_one({"token": expired_token})
        print("✅ Reset password expired token test passed")
    
    def test_reset_password_short_password(self, api_client, test_email_user, db):
        """Test reset password with password < 6 chars returns 400."""
        # Get a valid token
        forgot_resp = api_client.post(f"{BASE_URL}/api/auth/forgot-password", json={
            "email": test_email_user["email"]
        })
        reset_link = forgot_resp.json().get("reset_link", "")
        token = reset_link.split("token=")[-1].split("&")[0] if reset_link else None
        
        response = api_client.post(f"{BASE_URL}/api/auth/reset-password", json={
            "token": token,
            "password": "12345"  # Only 5 chars
        })
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        assert "6 caracteres" in response.json().get("detail", "")
        print("✅ Reset password short password test passed")


class TestAuthMe:
    """Tests for GET /api/auth/me endpoint."""
    
    def test_auth_me_returns_user(self, test_email_user, db):
        """Test /auth/me returns user data without password_hash."""
        # Create session for test user
        session_token = f"test_session_{uuid.uuid4().hex}"
        db.user_sessions.insert_one({
            "user_id": test_email_user["user_id"],
            "session_token": session_token,
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            "created_at": datetime.now(timezone.utc).isoformat()
        })
        
        session = requests.Session()
        session.cookies.set("session_token", session_token)
        
        response = session.get(f"{BASE_URL}/api/auth/me")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert "email" in data
        assert data["email"] == test_email_user["email"]
        
        # CRITICAL: password_hash should NOT be returned
        assert "password_hash" not in data, "password_hash should not be in /auth/me response"
        
        # Cleanup
        db.user_sessions.delete_one({"session_token": session_token})
        print("✅ Auth/me test passed - password_hash excluded")
    
    def test_auth_me_unauthenticated(self, api_client):
        """Test /auth/me without session returns 401."""
        response = api_client.get(f"{BASE_URL}/api/auth/me")
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("✅ Auth/me unauthenticated test passed")


class TestUsersEndpoint:
    """Tests for GET /api/users endpoint - password_hash exclusion."""
    
    def test_users_list_excludes_password_hash(self, admin_client, test_email_user):
        """Test GET /api/users excludes password_hash field."""
        response = admin_client.get(f"{BASE_URL}/api/users")
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        users = response.json()
        assert isinstance(users, list)
        
        for user in users:
            # CRITICAL: password_hash should not be in any user object
            assert "password_hash" not in user, f"password_hash found in user: {user.get('email')}"
        
        print(f"✅ Users list test passed - password_hash excluded from {len(users)} users")


class TestAuthTypeField:
    """Tests for auth_type field correctness."""
    
    def test_email_user_has_auth_type_email(self, test_email_user, db):
        """Test email users have auth_type='email'."""
        user = db.users.find_one({"email": test_email_user["email"]})
        assert user["auth_type"] == "email", f"Expected auth_type='email', got {user.get('auth_type')}"
        print("✅ Email user auth_type test passed")
    
    def test_created_email_user_has_auth_type_email(self, admin_client, db, cleanup_test_users):
        """Test admin-created users have auth_type='email'."""
        new_email = f"{TEST_PREFIX}authtype_{uuid.uuid4().hex[:8]}@test.com"
        
        admin_client.post(f"{BASE_URL}/api/auth/create-user", json={
            "email": new_email,
            "password": "pass123456",
            "name": "Auth Type Test",
            "role": "user"
        })
        
        user = db.users.find_one({"email": new_email})
        assert user is not None
        assert user["auth_type"] == "email"
        print("✅ Created email user auth_type test passed")


# Run with: pytest /app/backend/tests/test_iteration48_email_auth.py -v
