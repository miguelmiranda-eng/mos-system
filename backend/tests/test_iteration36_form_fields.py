"""
Test Suite: Iteration 36 - Form Fields Configuration API
Features tested:
1. GET /api/config/form-fields - returns form field configuration
2. PUT /api/config/form-fields - saves field list (admin only)
3. PUT /api/config/form-fields - returns 403 for non-admin
"""

import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

# Test data
ADMIN_SESSION = None
REGULAR_SESSION = None
ORIGINAL_FIELDS = None


def setup_module():
    """Create test users and sessions"""
    global ADMIN_SESSION, REGULAR_SESSION
    import subprocess
    
    result = subprocess.run([
        'mongosh', '--quiet', '--eval', '''
use('test_database');
var ts = Date.now();
var adminUserId = 'test-admin-' + ts;
var adminSession = 'test_session_admin_' + ts;
db.users.insertOne({
  user_id: adminUserId,
  email: 'admin-pytest-' + ts + '@example.com',
  name: 'Admin Pytest User',
  role: 'admin',
  created_at: new Date()
});
db.user_sessions.insertOne({
  user_id: adminUserId,
  session_token: adminSession,
  expires_at: new Date(Date.now() + 7*24*60*60*1000),
  created_at: new Date()
});
var regularUserId = 'test-user-' + ts;
var regularSession = 'test_session_regular_' + ts;
db.users.insertOne({
  user_id: regularUserId,
  email: 'regular-pytest-' + ts + '@example.com',
  name: 'Regular Pytest User',
  role: 'user',
  created_at: new Date()
});
db.user_sessions.insertOne({
  user_id: regularUserId,
  session_token: regularSession,
  expires_at: new Date(Date.now() + 7*24*60*60*1000),
  created_at: new Date()
});
print('ADMIN=' + adminSession);
print('REGULAR=' + regularSession);
'''
    ], capture_output=True, text=True)
    
    for line in result.stdout.split('\n'):
        if line.startswith('ADMIN='):
            ADMIN_SESSION = line.split('=')[1]
        elif line.startswith('REGULAR='):
            REGULAR_SESSION = line.split('=')[1]
    
    assert ADMIN_SESSION, "Failed to create admin session"
    assert REGULAR_SESSION, "Failed to create regular session"


def teardown_module():
    """Clean up test data"""
    global ORIGINAL_FIELDS
    if ORIGINAL_FIELDS and ADMIN_SESSION:
        # Restore original fields
        requests.put(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}", "Content-Type": "application/json"},
            json={"fields": ORIGINAL_FIELDS}
        )


class TestFormFieldsAPI:
    """Form Fields Configuration API tests"""
    
    def test_get_form_fields_authenticated(self):
        """GET /api/config/form-fields with valid auth returns field configuration"""
        response = requests.get(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        # Should return fields list (or empty object if not configured)
        assert isinstance(data, dict), "Response should be a dict"
        if "fields" in data:
            assert isinstance(data["fields"], list), "fields should be a list"
    
    def test_get_form_fields_unauthenticated(self):
        """GET /api/config/form-fields without auth returns 401"""
        response = requests.get(f"{BASE_URL}/api/config/form-fields")
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
    
    def test_get_form_fields_regular_user_can_read(self):
        """GET /api/config/form-fields - regular users can read (needed for form)"""
        response = requests.get(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {REGULAR_SESSION}"}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    
    def test_put_form_fields_admin_success(self):
        """PUT /api/config/form-fields with admin auth succeeds"""
        global ORIGINAL_FIELDS
        
        # First get current config to restore later
        get_response = requests.get(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        if get_response.status_code == 200:
            data = get_response.json()
            ORIGINAL_FIELDS = data.get("fields", [])
        
        # Now test PUT
        test_fields = ["order_number", "client", "priority", "quantity"]
        response = requests.put(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}", "Content-Type": "application/json"},
            json={"fields": test_fields}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "message" in data, "Response should contain message"
        
        # Verify GET returns updated fields
        verify_response = requests.get(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        assert verify_response.status_code == 200
        verify_data = verify_response.json()
        assert verify_data.get("fields") == test_fields, "Fields not updated correctly"
    
    def test_put_form_fields_non_admin_returns_403(self):
        """PUT /api/config/form-fields with non-admin returns 403"""
        response = requests.put(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {REGULAR_SESSION}", "Content-Type": "application/json"},
            json={"fields": ["order_number", "client"]}
        )
        
        assert response.status_code == 403, f"Expected 403, got {response.status_code}: {response.text}"
        data = response.json()
        assert "detail" in data, "Response should contain detail message"
    
    def test_put_form_fields_unauthenticated(self):
        """PUT /api/config/form-fields without auth returns 401"""
        response = requests.put(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Content-Type": "application/json"},
            json={"fields": ["order_number", "client"]}
        )
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
    
    def test_put_form_fields_empty_list(self):
        """PUT /api/config/form-fields with empty list succeeds"""
        response = requests.put(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}", "Content-Type": "application/json"},
            json={"fields": []}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    
    def test_put_form_fields_with_custom_columns(self):
        """PUT /api/config/form-fields with custom column keys works"""
        # Custom columns might have keys like "custom_xyz"
        test_fields = ["order_number", "client", "custom_test_field"]
        response = requests.put(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}", "Content-Type": "application/json"},
            json={"fields": test_fields}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        # Verify
        verify_response = requests.get(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        assert verify_response.status_code == 200
        data = verify_response.json()
        assert data.get("fields") == test_fields


class TestFormFieldsDataPersistence:
    """Test that form fields config persists correctly"""
    
    def test_fields_persist_across_requests(self):
        """Form fields should persist and be retrievable after save"""
        test_fields = ["order_number", "notes", "quantity"]
        
        # Save
        save_response = requests.put(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}", "Content-Type": "application/json"},
            json={"fields": test_fields}
        )
        assert save_response.status_code == 200
        
        # Small delay to ensure persistence
        time.sleep(0.2)
        
        # Get and verify
        get_response = requests.get(
            f"{BASE_URL}/api/config/form-fields",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        assert get_response.status_code == 200
        
        data = get_response.json()
        assert data.get("fields") == test_fields, "Fields should persist"
        assert "updated_at" in data, "Should have updated_at timestamp"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
