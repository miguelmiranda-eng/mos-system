"""
Test cases for iteration 47 bug fixes:
1. Bug 1: POST /api/orders - custom_fields and model_extra should be merged at top level
2. Bug 2: Dashboard group-by-date dropdown - dynamic date columns (frontend code review)
3. Bug 3: Dashboard filter bar - date columns as filterable options (frontend code review)
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')


@pytest.fixture(scope="module")
def test_session():
    """Create a test session for API testing"""
    import subprocess
    import re
    
    result = subprocess.run([
        'mongosh', '--eval', '''
        use('test_database');
        var userId = 'pytest-user-' + Date.now();
        var sessionToken = 'pytest_session_' + Date.now();
        db.users.insertOne({
          user_id: userId,
          email: 'pytest.user.' + Date.now() + '@example.com',
          name: 'Pytest User',
          role: 'admin',
          picture: 'https://via.placeholder.com/150',
          created_at: new Date()
        });
        db.user_sessions.insertOne({
          user_id: userId,
          session_token: sessionToken,
          expires_at: new Date(Date.now() + 7*24*60*60*1000),
          created_at: new Date()
        });
        print('TOKEN:' + sessionToken);
        print('USERID:' + userId);
        '''
    ], capture_output=True, text=True)
    
    token_match = re.search(r'TOKEN:(\S+)', result.stdout)
    userid_match = re.search(r'USERID:(\S+)', result.stdout)
    
    if not token_match or not userid_match:
        pytest.skip("Failed to create test session")
    
    session_token = token_match.group(1)
    user_id = userid_match.group(1)
    
    yield {"token": session_token, "user_id": user_id}
    
    # Cleanup
    subprocess.run([
        'mongosh', '--eval', f'''
        use('test_database');
        db.users.deleteOne({{user_id: '{user_id}'}});
        db.user_sessions.deleteOne({{session_token: '{session_token}'}});
        db.orders.deleteMany({{created_by: '{user_id}'}});
        '''
    ], capture_output=True, text=True)


@pytest.fixture
def auth_headers(test_session):
    """Return headers with auth token"""
    return {
        "Authorization": f"Bearer {test_session['token']}",
        "Content-Type": "application/json"
    }


class TestBug1CustomFieldsMerge:
    """Bug 1: POST /api/orders - custom_fields and model_extra should merge at top level"""
    
    def test_create_order_with_custom_fields_merged_at_top_level(self, auth_headers):
        """Test that custom_fields are merged at top level of order document"""
        order_data = {
            "client": "TEST_BUG1_CLIENT",
            "branding": "TEST_BUG1_BRAND",
            "priority": "NORMAL",
            "quantity": 50,
            "custom_fields": {
                "color": "red",
                "fabric_type": "cotton"
            }
        }
        
        response = requests.post(
            f"{BASE_URL}/api/orders",
            json=order_data,
            headers=auth_headers
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        
        # Verify custom_fields dict is stored
        assert "custom_fields" in data, "custom_fields should be in response"
        assert data["custom_fields"]["color"] == "red", "custom_fields should contain color"
        assert data["custom_fields"]["fabric_type"] == "cotton", "custom_fields should contain fabric_type"
        
        # CRITICAL: Verify custom_fields are ALSO merged at top level
        assert "color" in data, "color should be merged at top level"
        assert data["color"] == "red", f"Top-level color should be 'red', got {data.get('color')}"
        assert "fabric_type" in data, "fabric_type should be merged at top level"
        assert data["fabric_type"] == "cotton", f"Top-level fabric_type should be 'cotton', got {data.get('fabric_type')}"
        
        print("✅ Bug 1 Test PASSED: custom_fields merged at top level")
        
        return data["order_id"]
    
    def test_create_order_with_model_extra_merged_at_top_level(self, auth_headers):
        """Test that model_extra (unknown fields) are merged at top level"""
        order_data = {
            "client": "TEST_BUG1_EXTRA_CLIENT",
            "branding": "TEST_BUG1_EXTRA_BRAND",
            "priority": "RUSH",
            "quantity": 75,
            "unknown_field_1": "value1",
            "unknown_field_2": "value2"
        }
        
        response = requests.post(
            f"{BASE_URL}/api/orders",
            json=order_data,
            headers=auth_headers
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        
        # CRITICAL: Verify model_extra fields are merged at top level
        assert "unknown_field_1" in data, "unknown_field_1 should be merged at top level"
        assert data["unknown_field_1"] == "value1", f"unknown_field_1 should be 'value1', got {data.get('unknown_field_1')}"
        assert "unknown_field_2" in data, "unknown_field_2 should be merged at top level"
        assert data["unknown_field_2"] == "value2", f"unknown_field_2 should be 'value2', got {data.get('unknown_field_2')}"
        
        print("✅ Bug 1 Test PASSED: model_extra merged at top level")
        
        return data["order_id"]
    
    def test_create_order_verify_persistence_of_custom_fields(self, auth_headers):
        """Test that custom_fields persist correctly in database (GET after POST)"""
        order_data = {
            "client": "TEST_BUG1_PERSIST_CLIENT",
            "branding": "TEST_BUG1_PERSIST_BRAND",
            "quantity": 100,
            "custom_fields": {
                "style": "vintage",
                "print_location": "front"
            },
            "dynamic_extra": "dynamic_value"
        }
        
        # Create order
        create_response = requests.post(
            f"{BASE_URL}/api/orders",
            json=order_data,
            headers=auth_headers
        )
        
        assert create_response.status_code == 200
        created = create_response.json()
        order_id = created["order_id"]
        
        # GET to verify persistence
        get_response = requests.get(
            f"{BASE_URL}/api/orders/{order_id}",
            headers=auth_headers
        )
        
        assert get_response.status_code == 200
        fetched = get_response.json()
        
        # Verify all fields persisted at top level
        assert fetched.get("style") == "vintage", "style should persist at top level"
        assert fetched.get("print_location") == "front", "print_location should persist at top level"
        assert fetched.get("dynamic_extra") == "dynamic_value", "dynamic_extra should persist at top level"
        
        # Verify nested custom_fields also persisted
        assert fetched.get("custom_fields", {}).get("style") == "vintage"
        assert fetched.get("custom_fields", {}).get("print_location") == "front"
        
        print("✅ Bug 1 Persistence Test PASSED: custom_fields persist at top level and nested")


class TestApiHealth:
    """Basic API health checks"""
    
    def test_backend_health(self, auth_headers):
        """Test that backend is responding"""
        response = requests.get(f"{BASE_URL}/api/config/boards", headers=auth_headers)
        assert response.status_code == 200, f"Backend health check failed: {response.status_code}"
        print("✅ Backend API responding correctly")
    
    def test_orders_endpoint(self, auth_headers):
        """Test that orders endpoint works"""
        response = requests.get(f"{BASE_URL}/api/orders", headers=auth_headers)
        assert response.status_code == 200, f"Orders endpoint failed: {response.status_code}"
        print("✅ Orders endpoint working")
    
    def test_config_columns_endpoint(self, auth_headers):
        """Test columns config endpoint - needed for Bug 2 and 3 frontend testing"""
        response = requests.get(f"{BASE_URL}/api/config/columns", headers=auth_headers)
        assert response.status_code == 200, f"Columns config failed: {response.status_code}"
        data = response.json()
        print(f"✅ Columns config returned: {len(data.get('custom_columns', []))} custom columns")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
