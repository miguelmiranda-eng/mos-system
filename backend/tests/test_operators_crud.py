"""
Test suite for Operators CRUD endpoints (iteration 30)
Tests: GET /api/operators, POST /api/operators, PUT /api/operators/{id}, DELETE /api/operators/{id}
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = "test_session_iter30_1772751337435"

# Track created operators for cleanup
created_operator_ids = []


@pytest.fixture(scope="module")
def api_client():
    """Shared requests session with auth cookie"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    session.cookies.set("session_token", SESSION_TOKEN)
    return session


class TestOperatorsAuth:
    """Test authentication requirements"""
    
    def test_01_list_operators_requires_auth(self):
        """GET /api/operators requires authentication"""
        response = requests.get(f"{BASE_URL}/api/operators")
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("PASS: GET /api/operators returns 401 without auth")
    
    def test_02_create_operator_requires_admin(self, api_client):
        """POST /api/operators requires admin role"""
        # Create regular user session
        import subprocess
        result = subprocess.run([
            'mongosh', '--quiet', '--eval', '''
            use("test_database");
            var userId = "test_regular_user_" + Date.now();
            var sessionToken = "test_regular_session_" + Date.now();
            db.users.insertOne({
              user_id: userId,
              email: "regular@example.com",
              name: "Regular User",
              role: "user",
              created_at: new Date()
            });
            db.user_sessions.insertOne({
              user_id: userId,
              session_token: sessionToken,
              expires_at: new Date(Date.now() + 60*60*1000),
              created_at: new Date()
            });
            print(sessionToken);
            '''
        ], capture_output=True, text=True)
        regular_token = result.stdout.strip().split('\n')[-1]
        
        # Try to create operator with regular user
        regular_session = requests.Session()
        regular_session.cookies.set("session_token", regular_token)
        response = regular_session.post(
            f"{BASE_URL}/api/operators",
            json={"name": "Should Not Work"},
            headers={"Content-Type": "application/json"}
        )
        assert response.status_code in [401, 403], f"Expected 401/403, got {response.status_code}"
        print("PASS: POST /api/operators returns 401/403 for non-admin")


class TestOperatorsCRUD:
    """Test CRUD operations for operators"""
    
    def test_03_list_operators_with_auth(self, api_client):
        """GET /api/operators returns list with auth"""
        response = api_client.get(f"{BASE_URL}/api/operators")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        print(f"PASS: GET /api/operators returns {len(data)} operators")
    
    def test_04_create_operator(self, api_client):
        """POST /api/operators creates operator with name"""
        test_name = f"TEST_Operator_{int(time.time())}"
        response = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": test_name}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        assert "operator_id" in data, "Response should include operator_id"
        assert data["name"] == test_name, f"Name should be {test_name}"
        assert data["active"] == True, "New operator should be active by default"
        assert "created_at" in data, "Response should include created_at"
        
        # Store for cleanup
        created_operator_ids.append(data["operator_id"])
        print(f"PASS: Created operator {data['operator_id']} with name '{test_name}'")
        return data["operator_id"]
    
    def test_05_create_operator_rejects_empty_name(self, api_client):
        """POST /api/operators rejects empty name"""
        response = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": ""}
        )
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        print("PASS: POST /api/operators rejects empty name with 400")
    
    def test_06_create_operator_rejects_duplicate_name(self, api_client):
        """POST /api/operators rejects duplicate name (case-insensitive)"""
        unique_name = f"TEST_DuplicateCheck_{int(time.time())}"
        
        # Create first operator
        response1 = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": unique_name}
        )
        assert response1.status_code == 200
        created_operator_ids.append(response1.json()["operator_id"])
        
        # Try to create duplicate with different case
        response2 = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": unique_name.upper()}
        )
        assert response2.status_code == 400, f"Expected 400 for duplicate, got {response2.status_code}"
        assert "already exists" in response2.json().get("detail", "").lower()
        print("PASS: POST /api/operators rejects duplicate names")
    
    def test_07_get_operators_includes_created(self, api_client):
        """GET /api/operators includes newly created operators"""
        # Create a new operator
        test_name = f"TEST_ListCheck_{int(time.time())}"
        create_response = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": test_name}
        )
        assert create_response.status_code == 200
        operator_id = create_response.json()["operator_id"]
        created_operator_ids.append(operator_id)
        
        # Verify it appears in list
        list_response = api_client.get(f"{BASE_URL}/api/operators")
        assert list_response.status_code == 200
        operators = list_response.json()
        found = any(op["operator_id"] == operator_id for op in operators)
        assert found, f"Created operator {operator_id} should be in list"
        print(f"PASS: GET /api/operators includes created operator {operator_id}")
    
    def test_08_update_operator_name(self, api_client):
        """PUT /api/operators/{id} updates operator name"""
        # Create operator first
        original_name = f"TEST_UpdateName_{int(time.time())}"
        create_response = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": original_name}
        )
        assert create_response.status_code == 200
        operator_id = create_response.json()["operator_id"]
        created_operator_ids.append(operator_id)
        
        # Update name
        new_name = f"TEST_UpdatedName_{int(time.time())}"
        update_response = api_client.put(
            f"{BASE_URL}/api/operators/{operator_id}",
            json={"name": new_name}
        )
        assert update_response.status_code == 200, f"Expected 200, got {update_response.status_code}"
        updated = update_response.json()
        assert updated["name"] == new_name, f"Name should be updated to {new_name}"
        
        # Verify persistence via GET
        list_response = api_client.get(f"{BASE_URL}/api/operators")
        operators = list_response.json()
        found_op = next((op for op in operators if op["operator_id"] == operator_id), None)
        assert found_op is not None, "Operator should still exist"
        assert found_op["name"] == new_name, "Name change should persist"
        print(f"PASS: PUT /api/operators/{operator_id} updates name")
    
    def test_09_update_operator_active_status(self, api_client):
        """PUT /api/operators/{id} toggles active status"""
        # Create operator (default active=True)
        create_response = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": f"TEST_ToggleActive_{int(time.time())}"}
        )
        assert create_response.status_code == 200
        operator_id = create_response.json()["operator_id"]
        created_operator_ids.append(operator_id)
        assert create_response.json()["active"] == True
        
        # Deactivate
        update_response = api_client.put(
            f"{BASE_URL}/api/operators/{operator_id}",
            json={"active": False}
        )
        assert update_response.status_code == 200
        assert update_response.json()["active"] == False, "active should be False after update"
        
        # Re-activate
        reactivate_response = api_client.put(
            f"{BASE_URL}/api/operators/{operator_id}",
            json={"active": True}
        )
        assert reactivate_response.status_code == 200
        assert reactivate_response.json()["active"] == True, "active should be True after re-activate"
        print(f"PASS: PUT /api/operators/{operator_id} toggles active status")
    
    def test_10_update_nonexistent_operator_returns_404(self, api_client):
        """PUT /api/operators/{id} returns 404 for non-existent operator"""
        fake_id = "op_doesnotexist12345"
        response = api_client.put(
            f"{BASE_URL}/api/operators/{fake_id}",
            json={"name": "Test"}
        )
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        print("PASS: PUT /api/operators returns 404 for non-existent operator")
    
    def test_11_delete_operator(self, api_client):
        """DELETE /api/operators/{id} deletes operator"""
        # Create operator to delete
        create_response = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": f"TEST_ToDelete_{int(time.time())}"}
        )
        assert create_response.status_code == 200
        operator_id = create_response.json()["operator_id"]
        
        # Delete it
        delete_response = api_client.delete(f"{BASE_URL}/api/operators/{operator_id}")
        assert delete_response.status_code == 200, f"Expected 200, got {delete_response.status_code}"
        
        # Verify it's gone from list
        list_response = api_client.get(f"{BASE_URL}/api/operators")
        operators = list_response.json()
        found = any(op["operator_id"] == operator_id for op in operators)
        assert not found, "Deleted operator should not be in list"
        print(f"PASS: DELETE /api/operators/{operator_id} removes operator")
    
    def test_12_delete_nonexistent_operator_returns_404(self, api_client):
        """DELETE /api/operators/{id} returns 404 for non-existent operator"""
        fake_id = "op_doesnotexist67890"
        response = api_client.delete(f"{BASE_URL}/api/operators/{fake_id}")
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        print("PASS: DELETE /api/operators returns 404 for non-existent operator")


class TestProductionModalOperatorDropdown:
    """Test that active operators are filtered correctly"""
    
    def test_13_only_active_operators_should_appear_in_production_dropdown(self, api_client):
        """Create active and inactive operators, verify filtering"""
        # Create active operator
        active_name = f"TEST_ActiveOp_{int(time.time())}"
        active_response = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": active_name}
        )
        assert active_response.status_code == 200
        active_id = active_response.json()["operator_id"]
        created_operator_ids.append(active_id)
        
        # Create another and deactivate it
        inactive_name = f"TEST_InactiveOp_{int(time.time())}"
        inactive_response = api_client.post(
            f"{BASE_URL}/api/operators",
            json={"name": inactive_name}
        )
        assert inactive_response.status_code == 200
        inactive_id = inactive_response.json()["operator_id"]
        created_operator_ids.append(inactive_id)
        
        # Deactivate
        api_client.put(
            f"{BASE_URL}/api/operators/{inactive_id}",
            json={"active": False}
        )
        
        # Get all operators
        list_response = api_client.get(f"{BASE_URL}/api/operators")
        operators = list_response.json()
        
        # Filter active (as frontend does)
        active_operators = [op for op in operators if op["active"]]
        
        # Verify active operator is in active list
        active_found = any(op["operator_id"] == active_id for op in active_operators)
        assert active_found, "Active operator should be in filtered list"
        
        # Verify inactive operator is NOT in active list
        inactive_found = any(op["operator_id"] == inactive_id for op in active_operators)
        assert not inactive_found, "Inactive operator should NOT be in filtered list"
        
        print("PASS: Active/inactive filtering works correctly for production dropdown")


class TestCleanup:
    """Cleanup test data"""
    
    def test_99_cleanup_test_operators(self, api_client):
        """Delete all TEST_ prefixed operators"""
        list_response = api_client.get(f"{BASE_URL}/api/operators")
        if list_response.status_code == 200:
            operators = list_response.json()
            for op in operators:
                if op["name"].startswith("TEST_"):
                    api_client.delete(f"{BASE_URL}/api/operators/{op['operator_id']}")
        print("PASS: Cleanup completed")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
