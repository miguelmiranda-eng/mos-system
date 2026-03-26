"""
Backend API Tests for Iteration 4 Features:
- /api/config/colors - GET and PUT (admin only)
- /api/users - GET, POST invite, PUT role, DELETE user (admin only)
- Auth requirements for protected endpoints
"""

import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://production-crm-1.preview.emergentagent.com')
SESSION_TOKEN = "test_session_1772136570038"  # Admin session from previous iterations

@pytest.fixture(scope="module")
def api_client():
    """Shared requests session with auth"""
    session = requests.Session()
    session.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {SESSION_TOKEN}"
    })
    return session

@pytest.fixture(scope="module")
def unauthenticated_client():
    """Session without auth for testing 401 responses"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


# ================ AUTH CHECK ================

class TestAuth:
    """Verify auth is working"""
    
    def test_auth_me_returns_admin_user(self, api_client):
        """GET /api/auth/me should return admin user"""
        response = api_client.get(f"{BASE_URL}/api/auth/me")
        assert response.status_code == 200
        data = response.json()
        assert data["role"] == "admin"
        assert "email" in data
        print(f"Auth OK: {data['name']} ({data['role']})")
    
    def test_auth_me_without_token_returns_401(self, unauthenticated_client):
        """GET /api/auth/me without token should return 401"""
        response = unauthenticated_client.get(f"{BASE_URL}/api/auth/me")
        assert response.status_code == 401


# ================ CONFIG COLORS ================

class TestConfigColors:
    """Test /api/config/colors endpoints"""
    
    def test_get_colors_returns_object(self, api_client):
        """GET /api/config/colors should return object (empty or with data)"""
        response = api_client.get(f"{BASE_URL}/api/config/colors")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)
        print(f"Colors endpoint returns {len(data)} color mappings")
    
    def test_put_colors_saves_mapping(self, api_client):
        """PUT /api/config/colors should save color data (admin only)"""
        test_colors = {
            "TEST_STATUS": {"bg": "#FF0000", "text": "#FFFFFF"},
            "TEST_STATUS_2": {"bg": "#00FF00", "text": "#000000"}
        }
        response = api_client.put(f"{BASE_URL}/api/config/colors", json=test_colors)
        assert response.status_code == 200
        
        # Verify persistence
        get_response = api_client.get(f"{BASE_URL}/api/config/colors")
        assert get_response.status_code == 200
        saved = get_response.json()
        assert saved.get("TEST_STATUS", {}).get("bg") == "#FF0000"
        print("Color mapping saved and verified")
    
    def test_get_colors_without_auth_returns_401(self, unauthenticated_client):
        """GET /api/config/colors without auth should return 401"""
        response = unauthenticated_client.get(f"{BASE_URL}/api/config/colors")
        assert response.status_code == 401


# ================ USERS MANAGEMENT ================

class TestUsersManagement:
    """Test /api/users endpoints (admin only)"""
    
    def test_get_users_returns_list(self, api_client):
        """GET /api/users should return list of users (admin only)"""
        response = api_client.get(f"{BASE_URL}/api/users")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"Users endpoint returns {len(data)} users")
    
    def test_get_users_without_auth_returns_401(self, unauthenticated_client):
        """GET /api/users without auth should return 401"""
        response = unauthenticated_client.get(f"{BASE_URL}/api/users")
        assert response.status_code == 401
    
    def test_invite_user_creates_entry(self, api_client):
        """POST /api/users/invite should create new user entry"""
        import uuid
        test_email = f"test.invite.{uuid.uuid4().hex[:8]}@example.com"
        
        response = api_client.post(f"{BASE_URL}/api/users/invite", json={
            "email": test_email,
            "role": "user"
        })
        assert response.status_code == 200
        
        # Verify user was created
        get_response = api_client.get(f"{BASE_URL}/api/users")
        users = get_response.json()
        user_emails = [u.get("email") for u in users]
        assert test_email in user_emails
        print(f"Invited user {test_email} created successfully")
        
        # Cleanup: delete the test user
        del_response = api_client.delete(f"{BASE_URL}/api/users/{test_email}")
        assert del_response.status_code == 200
        print(f"Cleanup: deleted test user {test_email}")
    
    def test_invite_duplicate_user_returns_400(self, api_client):
        """POST /api/users/invite with existing email should return 400"""
        import uuid
        test_email = f"test.dup.{uuid.uuid4().hex[:8]}@example.com"
        
        # First invite
        api_client.post(f"{BASE_URL}/api/users/invite", json={"email": test_email, "role": "user"})
        
        # Second invite - should fail
        response = api_client.post(f"{BASE_URL}/api/users/invite", json={
            "email": test_email,
            "role": "user"
        })
        assert response.status_code == 400
        
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/users/{test_email}")
    
    def test_invite_invalid_email_returns_400(self, api_client):
        """POST /api/users/invite with invalid email should return 400"""
        response = api_client.post(f"{BASE_URL}/api/users/invite", json={
            "email": "not-an-email",
            "role": "user"
        })
        assert response.status_code == 400
    
    def test_update_user_role(self, api_client):
        """PUT /api/users/{user_id}/role should update user role"""
        import uuid
        test_email = f"test.role.{uuid.uuid4().hex[:8]}@example.com"
        
        # Create user first
        api_client.post(f"{BASE_URL}/api/users/invite", json={"email": test_email, "role": "user"})
        
        # Update role
        response = api_client.put(f"{BASE_URL}/api/users/{test_email}/role", json={"role": "admin"})
        assert response.status_code == 200
        
        # Verify role change
        get_response = api_client.get(f"{BASE_URL}/api/users")
        users = get_response.json()
        test_user = next((u for u in users if u.get("email") == test_email), None)
        assert test_user is not None
        assert test_user.get("role") == "admin"
        print(f"User role updated to admin for {test_email}")
        
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/users/{test_email}")
    
    def test_delete_user_removes_entry(self, api_client):
        """DELETE /api/users/{user_id} should remove user"""
        import uuid
        test_email = f"test.del.{uuid.uuid4().hex[:8]}@example.com"
        
        # Create user
        api_client.post(f"{BASE_URL}/api/users/invite", json={"email": test_email, "role": "user"})
        
        # Delete user
        response = api_client.delete(f"{BASE_URL}/api/users/{test_email}")
        assert response.status_code == 200
        
        # Verify deletion
        get_response = api_client.get(f"{BASE_URL}/api/users")
        users = get_response.json()
        user_emails = [u.get("email") for u in users]
        assert test_email not in user_emails
        print(f"User {test_email} deleted successfully")
    
    def test_delete_admin_email_returns_400(self, api_client):
        """DELETE /api/users/{admin_email} should return 400"""
        admin_email = "miguel.miranda@prosper-mfg.com"
        response = api_client.delete(f"{BASE_URL}/api/users/{admin_email}")
        assert response.status_code == 400
        print("Admin user protected from deletion - OK")
    
    def test_delete_nonexistent_user_returns_404(self, api_client):
        """DELETE /api/users/{nonexistent} should return 404"""
        response = api_client.delete(f"{BASE_URL}/api/users/nonexistent@example.com")
        assert response.status_code == 404


# ================ CONFIG OPTIONS ================

class TestConfigOptions:
    """Test /api/config/options endpoint"""
    
    def test_get_options_returns_all_categories(self, api_client):
        """GET /api/config/options should return all option categories"""
        response = api_client.get(f"{BASE_URL}/api/config/options")
        assert response.status_code == 200
        data = response.json()
        
        # Verify expected keys
        expected_keys = ["priorities", "clients", "production_statuses", "blank_statuses", "artwork_statuses"]
        for key in expected_keys:
            assert key in data, f"Missing key: {key}"
            assert isinstance(data[key], list)
        
        print(f"Options endpoint returns {len(data)} categories")


# ================ AUTOMATIONS ================

class TestAutomations:
    """Test /api/automations endpoint"""
    
    def test_get_automations_returns_list(self, api_client):
        """GET /api/automations should return list"""
        response = api_client.get(f"{BASE_URL}/api/automations")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"Automations endpoint returns {len(data)} rules")
    
    def test_create_automation_with_conditions(self, api_client):
        """POST /api/automations should create rule with trigger_conditions"""
        import uuid
        rule_name = f"Test Rule {uuid.uuid4().hex[:8]}"
        
        response = api_client.post(f"{BASE_URL}/api/automations", json={
            "name": rule_name,
            "trigger_type": "update",
            "trigger_conditions": {
                "production_status": "EN PRODUCCION",
                "priority": "RUSH"
            },
            "action_type": "move_board",
            "action_params": {"target_board": "MAQUINA1"},
            "is_active": True
        })
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == rule_name
        assert data["trigger_conditions"]["production_status"] == "EN PRODUCCION"
        
        automation_id = data["automation_id"]
        print(f"Created automation {automation_id} with conditions")
        
        # Cleanup
        del_response = api_client.delete(f"{BASE_URL}/api/automations/{automation_id}")
        assert del_response.status_code == 200


# ================ ORDERS (Verify existing endpoints still work) ================

class TestOrders:
    """Test /api/orders endpoints still work"""
    
    def test_get_orders_returns_list(self, api_client):
        """GET /api/orders should return list"""
        response = api_client.get(f"{BASE_URL}/api/orders")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"Orders endpoint returns {len(data)} orders")
    
    def test_create_order_and_verify(self, api_client):
        """POST /api/orders should create order in SCHEDULING"""
        import uuid
        order_number = f"TEST-{uuid.uuid4().hex[:8].upper()}"
        
        response = api_client.post(f"{BASE_URL}/api/orders", json={
            "order_number": order_number,
            "client": "LOVE IN FAITH",
            "priority": "RUSH",
            "quantity": 100
        })
        assert response.status_code == 200
        data = response.json()
        assert data["order_number"] == order_number
        assert data["board"] == "SCHEDULING"
        
        order_id = data["order_id"]
        
        # Cleanup: delete permanently
        del_response = api_client.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        assert del_response.status_code == 200
        print(f"Created and cleaned up test order {order_number}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
