"""
Iteration 49 - Comprehensive Smoke Test
Tests all recent changes:
1) Backend health: GET /api/config/boards returns board list
2) Auth: login, create-user, forgot-password, reset-password, user profile/password update
3) Orders: create with custom_fields merged at top level, list orders
4) Users: GET excludes password_hash

Test context: cancel_date excluded from filters, date range filter, sticky PO column, custom fields at top level
"""
import pytest
import requests
import os
import uuid
from datetime import datetime

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestBackendHealth:
    """Test backend health endpoints"""
    
    def test_get_boards_list(self):
        """GET /api/config/boards returns board list"""
        response = requests.get(f"{BASE_URL}/api/config/boards")
        assert response.status_code == 200
        data = response.json()
        assert "boards" in data
        assert isinstance(data["boards"], list)
        assert len(data["boards"]) > 0
        # Check expected boards exist
        assert "SCHEDULING" in data["boards"]
        assert "MASTER" in data["boards"]
        print(f"GET /api/config/boards: PASS - {len(data['boards'])} boards found")


class TestEmailAuth:
    """Test email/password authentication flows"""
    
    @pytest.fixture(autouse=True)
    def setup_admin_session(self):
        """Setup: create admin session directly in MongoDB"""
        from pymongo import MongoClient
        self.client = MongoClient("mongodb://localhost:27017")
        self.db = self.client["test_database"]
        
        # Create test admin user and session
        self.admin_email = "test_admin_smoke@test.com"
        self.admin_user_id = f"user_{uuid.uuid4().hex[:12]}"
        self.session_token = f"test_admin_session_{uuid.uuid4().hex}"
        
        # Insert admin user
        self.db.users.update_one(
            {"email": self.admin_email},
            {"$set": {
                "user_id": self.admin_user_id,
                "email": self.admin_email,
                "name": "Test Admin Smoke",
                "role": "admin",
                "auth_type": "google",
                "created_at": datetime.utcnow().isoformat()
            }},
            upsert=True
        )
        
        # Insert session
        from datetime import timedelta
        expires = datetime.utcnow() + timedelta(days=1)
        self.db.user_sessions.insert_one({
            "user_id": self.admin_user_id,
            "session_token": self.session_token,
            "expires_at": expires.isoformat(),
            "created_at": datetime.utcnow().isoformat()
        })
        
        self.admin_cookies = {"session_token": self.session_token}
        yield
        
        # Cleanup
        self.db.user_sessions.delete_one({"session_token": self.session_token})
        self.db.users.delete_one({"email": self.admin_email})
        self.db.users.delete_many({"email": {"$regex": "^TEST_smoke_"}})
        self.db.password_resets.delete_many({"email": {"$regex": "^TEST_smoke_"}})
        self.client.close()
    
    def test_login_valid_credentials(self, setup_admin_session):
        """POST /api/auth/login with valid email/password returns user without password_hash"""
        # First create a test user
        test_email = f"TEST_smoke_login_{uuid.uuid4().hex[:6]}@test.com"
        test_password = "testpass123"
        
        # Create user via admin
        create_res = requests.post(
            f"{BASE_URL}/api/auth/create-user",
            json={"email": test_email, "password": test_password, "name": "Login Test"},
            cookies=self.admin_cookies
        )
        assert create_res.status_code == 200
        
        # Now login
        login_res = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": test_email, "password": test_password}
        )
        assert login_res.status_code == 200
        data = login_res.json()
        assert "password_hash" not in data
        # Email is lowercased by backend
        assert data["email"] == test_email.lower()
        assert data.get("auth_type") == "email"
        print(f"POST /api/auth/login valid: PASS - user returned without password_hash")
        
        # Cleanup
        self.db.users.delete_one({"email": test_email})
    
    def test_login_wrong_credentials(self, setup_admin_session):
        """POST /api/auth/login with wrong credentials returns 401"""
        response = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": "nonexistent@test.com", "password": "wrongpass"}
        )
        assert response.status_code == 401
        print(f"POST /api/auth/login wrong creds: PASS - 401 returned")
    
    def test_create_user_success(self, setup_admin_session):
        """POST /api/auth/create-user (admin) creates email user successfully"""
        test_email = f"TEST_smoke_create_{uuid.uuid4().hex[:6]}@test.com"
        response = requests.post(
            f"{BASE_URL}/api/auth/create-user",
            json={"email": test_email, "password": "testpass123", "name": "Created User", "role": "user"},
            cookies=self.admin_cookies
        )
        assert response.status_code == 200
        data = response.json()
        assert "user_id" in data
        print(f"POST /api/auth/create-user: PASS - user created")
        
        # Cleanup
        self.db.users.delete_one({"email": test_email})
    
    def test_create_user_duplicate_email(self, setup_admin_session):
        """POST /api/auth/create-user rejects duplicate email"""
        test_email = f"TEST_smoke_dup_{uuid.uuid4().hex[:6]}@test.com"
        
        # Create first
        requests.post(
            f"{BASE_URL}/api/auth/create-user",
            json={"email": test_email, "password": "testpass123"},
            cookies=self.admin_cookies
        )
        
        # Try duplicate
        response = requests.post(
            f"{BASE_URL}/api/auth/create-user",
            json={"email": test_email, "password": "testpass456"},
            cookies=self.admin_cookies
        )
        assert response.status_code == 400
        assert "ya existe" in response.json().get("detail", "").lower()
        print(f"POST /api/auth/create-user duplicate: PASS - 400 returned")
        
        # Cleanup
        self.db.users.delete_one({"email": test_email})
    
    def test_forgot_password_returns_reset_link(self, setup_admin_session):
        """POST /api/auth/forgot-password returns message with reset_link"""
        # Create email user first
        test_email = f"TEST_smoke_forgot_{uuid.uuid4().hex[:6]}@test.com"
        requests.post(
            f"{BASE_URL}/api/auth/create-user",
            json={"email": test_email, "password": "testpass123"},
            cookies=self.admin_cookies
        )
        
        # Request password reset
        response = requests.post(
            f"{BASE_URL}/api/auth/forgot-password",
            json={"email": test_email}
        )
        assert response.status_code == 200
        data = response.json()
        assert "message" in data
        # Since RESEND_API_KEY is empty, reset_link should be returned
        assert "reset_link" in data
        assert "token=" in data["reset_link"]
        print(f"POST /api/auth/forgot-password: PASS - reset_link returned")
        
        # Cleanup
        self.db.users.delete_one({"email": test_email})
        self.db.password_resets.delete_one({"email": test_email})
    
    def test_reset_password_valid_token(self, setup_admin_session):
        """POST /api/auth/reset-password with valid token resets password"""
        # Create email user
        test_email = f"TEST_smoke_reset_{uuid.uuid4().hex[:6]}@test.com"
        requests.post(
            f"{BASE_URL}/api/auth/create-user",
            json={"email": test_email, "password": "oldpass123"},
            cookies=self.admin_cookies
        )
        
        # Request reset
        forgot_res = requests.post(
            f"{BASE_URL}/api/auth/forgot-password",
            json={"email": test_email}
        )
        reset_link = forgot_res.json().get("reset_link", "")
        token = reset_link.split("token=")[-1] if "token=" in reset_link else None
        assert token, "No token in reset link"
        
        # Reset password
        response = requests.post(
            f"{BASE_URL}/api/auth/reset-password",
            json={"token": token, "password": "newpass123"}
        )
        assert response.status_code == 200
        print(f"POST /api/auth/reset-password: PASS - password reset")
        
        # Verify login with new password works
        login_res = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": test_email, "password": "newpass123"}
        )
        assert login_res.status_code == 200
        print(f"  Login with new password: PASS")
        
        # Cleanup
        self.db.users.delete_one({"email": test_email})
        self.db.password_resets.delete_one({"email": test_email})


class TestUserManagement:
    """Test user profile and password management"""
    
    @pytest.fixture(autouse=True)
    def setup_admin_session(self):
        """Setup: create admin session directly in MongoDB"""
        from pymongo import MongoClient
        self.client = MongoClient("mongodb://localhost:27017")
        self.db = self.client["test_database"]
        
        self.admin_email = "test_admin_users@test.com"
        self.admin_user_id = f"user_{uuid.uuid4().hex[:12]}"
        self.session_token = f"test_admin_session_{uuid.uuid4().hex}"
        
        self.db.users.update_one(
            {"email": self.admin_email},
            {"$set": {
                "user_id": self.admin_user_id,
                "email": self.admin_email,
                "name": "Test Admin Users",
                "role": "admin",
                "auth_type": "google",
                "created_at": datetime.utcnow().isoformat()
            }},
            upsert=True
        )
        
        from datetime import timedelta
        expires = datetime.utcnow() + timedelta(days=1)
        self.db.user_sessions.insert_one({
            "user_id": self.admin_user_id,
            "session_token": self.session_token,
            "expires_at": expires.isoformat(),
            "created_at": datetime.utcnow().isoformat()
        })
        
        self.admin_cookies = {"session_token": self.session_token}
        yield
        
        # Cleanup
        self.db.user_sessions.delete_one({"session_token": self.session_token})
        self.db.users.delete_one({"email": self.admin_email})
        self.db.users.delete_many({"email": {"$regex": "^TEST_usersmoke_"}})
        self.client.close()
    
    def test_update_user_profile(self, setup_admin_session):
        """PUT /api/users/{email}/profile updates name"""
        # Create email user - email is lowercased by backend
        test_email = f"test_usersmoke_profile_{uuid.uuid4().hex[:6]}@test.com"
        requests.post(
            f"{BASE_URL}/api/auth/create-user",
            json={"email": test_email, "password": "testpass123", "name": "Original Name"},
            cookies=self.admin_cookies
        )
        
        # Update profile - use lowercased email
        response = requests.put(
            f"{BASE_URL}/api/users/{test_email}/profile",
            json={"name": "Updated Name"},
            cookies=self.admin_cookies
        )
        assert response.status_code == 200
        
        # Verify update
        user = self.db.users.find_one({"email": test_email}, {"_id": 0})
        assert user["name"] == "Updated Name"
        print(f"PUT /api/users/{{email}}/profile: PASS - name updated")
        
        # Cleanup
        self.db.users.delete_one({"email": test_email})
    
    def test_change_user_password(self, setup_admin_session):
        """PUT /api/users/{email}/password changes password"""
        # Create email user - use lowercase email
        test_email = f"test_usersmoke_pw_{uuid.uuid4().hex[:6]}@test.com"
        requests.post(
            f"{BASE_URL}/api/auth/create-user",
            json={"email": test_email, "password": "oldpass123"},
            cookies=self.admin_cookies
        )
        
        # Change password - use lowercased email
        response = requests.put(
            f"{BASE_URL}/api/users/{test_email}/password",
            json={"password": "newpass456"},
            cookies=self.admin_cookies
        )
        assert response.status_code == 200
        
        # Verify login with new password
        login_res = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"email": test_email, "password": "newpass456"}
        )
        assert login_res.status_code == 200
        print(f"PUT /api/users/{{email}}/password: PASS - password changed")
        
        # Cleanup
        self.db.users.delete_one({"email": test_email})
    
    def test_get_users_excludes_password_hash(self, setup_admin_session):
        """GET /api/users excludes password_hash"""
        response = requests.get(
            f"{BASE_URL}/api/users",
            cookies=self.admin_cookies
        )
        assert response.status_code == 200
        users = response.json()
        for user in users:
            assert "password_hash" not in user, f"password_hash found in user {user.get('email')}"
        print(f"GET /api/users: PASS - password_hash excluded from all {len(users)} users")


class TestOrders:
    """Test order creation with custom_fields"""
    
    @pytest.fixture(autouse=True)
    def setup_admin_session(self):
        """Setup: create admin session directly in MongoDB"""
        from pymongo import MongoClient
        self.client = MongoClient("mongodb://localhost:27017")
        self.db = self.client["test_database"]
        
        self.admin_email = "test_admin_orders@test.com"
        self.admin_user_id = f"user_{uuid.uuid4().hex[:12]}"
        self.session_token = f"test_admin_session_{uuid.uuid4().hex}"
        
        self.db.users.update_one(
            {"email": self.admin_email},
            {"$set": {
                "user_id": self.admin_user_id,
                "email": self.admin_email,
                "name": "Test Admin Orders",
                "role": "admin",
                "auth_type": "google",
                "created_at": datetime.utcnow().isoformat()
            }},
            upsert=True
        )
        
        from datetime import timedelta
        expires = datetime.utcnow() + timedelta(days=1)
        self.db.user_sessions.insert_one({
            "user_id": self.admin_user_id,
            "session_token": self.session_token,
            "expires_at": expires.isoformat(),
            "created_at": datetime.utcnow().isoformat()
        })
        
        self.admin_cookies = {"session_token": self.session_token}
        yield
        
        # Cleanup
        self.db.user_sessions.delete_one({"session_token": self.session_token})
        self.db.users.delete_one({"email": self.admin_email})
        self.db.orders.delete_many({"order_number": {"$regex": "^TEST_SMOKE_"}})
        self.client.close()
    
    def test_create_order_custom_fields_at_top_level(self, setup_admin_session):
        """POST /api/orders creates order with custom_fields merged at top level"""
        order_number = f"TEST_SMOKE_{uuid.uuid4().hex[:8].upper()}"
        custom_field_key = "test_custom_field"
        custom_field_value = "custom_value_123"
        
        response = requests.post(
            f"{BASE_URL}/api/orders",
            json={
                "order_number": order_number,
                "client": "Test Client",
                "quantity": 100,
                "custom_fields": {
                    custom_field_key: custom_field_value
                }
            },
            cookies=self.admin_cookies
        )
        assert response.status_code == 200
        data = response.json()
        
        # Verify custom_fields are at top level
        assert data.get(custom_field_key) == custom_field_value, f"Custom field not at top level: {data}"
        print(f"POST /api/orders: PASS - custom_fields merged at top level")
        
        # Verify in database
        order = self.db.orders.find_one({"order_number": order_number}, {"_id": 0})
        assert order[custom_field_key] == custom_field_value
        print(f"  DB verification: PASS - custom field at top level in DB")
        
        # Cleanup
        self.db.orders.delete_one({"order_number": order_number})
    
    def test_get_orders_returns_list(self, setup_admin_session):
        """GET /api/orders returns orders list"""
        response = requests.get(
            f"{BASE_URL}/api/orders",
            cookies=self.admin_cookies
        )
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"GET /api/orders: PASS - returns list of {len(data)} orders")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
