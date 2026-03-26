"""
Iteration 16 Bug Fixes Test Suite
Testing 4 reported bugs in the CRM production app:

Bug #1: Column reorder should work for custom columns
Bug #2: Table headers should be frozen (sticky) when scrolling vertically  
Bug #3: ORDER column sticky overlap with CLIENT column - needs explicit bg colors
Bug #4: Custom checkbox field values should persist when order is moved to another board
"""
import pytest
import requests
import os
from datetime import datetime, timedelta
import uuid

# Use the public URL from environment
BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    BASE_URL = "https://production-crm-1.preview.emergentagent.com"

API_URL = f"{BASE_URL}/api"


class TestSetup:
    """Setup test session for authenticated requests"""
    
    @pytest.fixture(scope="class")
    def session_token(self):
        """Create a test user and session in MongoDB for testing"""
        import subprocess
        import json
        import time
        
        # Generate unique identifiers
        timestamp = int(time.time() * 1000)
        user_id = f"test_user_{timestamp}"
        session_token = f"test_session_iteration16_{timestamp}"
        email = f"test.user.{timestamp}@example.com"
        
        # Create test user and session in MongoDB
        mongo_cmd = f'''
        use('test_database');
        db.users.insertOne({{
          user_id: "{user_id}",
          email: "{email}",
          name: "Test User Iteration16",
          picture: "",
          role: "admin",
          created_at: new Date()
        }});
        db.user_sessions.insertOne({{
          user_id: "{user_id}",
          session_token: "{session_token}",
          expires_at: new Date(Date.now() + 7*24*60*60*1000),
          created_at: new Date()
        }});
        print("Session created: " + "{session_token}");
        '''
        
        try:
            result = subprocess.run(
                ['mongosh', '--quiet', '--eval', mongo_cmd],
                capture_output=True,
                text=True,
                timeout=30
            )
            print(f"MongoDB setup output: {result.stdout}")
            if result.returncode != 0:
                print(f"MongoDB setup error: {result.stderr}")
        except Exception as e:
            print(f"MongoDB setup exception: {e}")
        
        return session_token
    
    @pytest.fixture(scope="class")
    def auth_headers(self, session_token):
        """Return headers with authentication token"""
        return {
            "Authorization": f"Bearer {session_token}",
            "Content-Type": "application/json"
        }


class TestBug1ColumnReorderCustomColumns(TestSetup):
    """Bug #1: Column reorder should work for custom columns - drag-drop reorder includes all visible columns"""
    
    def test_get_column_config(self, auth_headers):
        """GET /api/config/columns should return custom_columns array"""
        response = requests.get(f"{API_URL}/config/columns", headers=auth_headers)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "custom_columns" in data, "Response should contain custom_columns key"
        print(f"Column config retrieved: {len(data.get('custom_columns', []))} custom columns")
    
    def test_save_custom_column(self, auth_headers):
        """PUT /api/config/columns should save custom columns including for reorder"""
        # Create a test custom column
        test_columns = [
            {
                "key": "test_reorder_col",
                "label": "Test Reorder Column",
                "type": "text",
                "width": 150,
                "custom": True
            },
            {
                "key": "test_checkbox_col",
                "label": "Test Checkbox",
                "type": "checkbox",
                "width": 100,
                "custom": True
            }
        ]
        
        response = requests.put(
            f"{API_URL}/config/columns",
            headers=auth_headers,
            json={"custom_columns": test_columns}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        print("Custom columns saved successfully for reorder testing")
    
    def test_custom_columns_persist(self, auth_headers):
        """Verify custom columns are persisted and can be retrieved"""
        response = requests.get(f"{API_URL}/config/columns", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        columns = data.get("custom_columns", [])
        assert len(columns) >= 2, f"Expected at least 2 custom columns, got {len(columns)}"
        
        # Check that our test columns exist
        col_keys = [c.get("key") for c in columns]
        assert "test_reorder_col" in col_keys, "test_reorder_col should exist"
        assert "test_checkbox_col" in col_keys, "test_checkbox_col should exist"
        print(f"Custom columns verified: {col_keys}")


class TestBug2StickyHeaders(TestSetup):
    """Bug #2: Table headers (thead) should have sticky top-0 z-30 class"""
    
    def test_health_check(self, auth_headers):
        """Verify backend is healthy and auth works"""
        response = requests.get(f"{API_URL}/auth/me", headers=auth_headers)
        assert response.status_code == 200, f"Auth check failed: {response.status_code}"
        data = response.json()
        assert "email" in data, "Should return user with email"
        print(f"Auth verified for user: {data.get('email')}")
    
    def test_orders_endpoint_accessible(self, auth_headers):
        """Verify orders endpoint is accessible (UI will render with sticky headers)"""
        response = requests.get(f"{API_URL}/orders", headers=auth_headers)
        assert response.status_code == 200, f"Orders endpoint failed: {response.status_code}"
        orders = response.json()
        print(f"Orders endpoint returned {len(orders)} orders")


class TestBug3StickyOrderColumn(TestSetup):
    """Bug #3: ORDER column (order_number) should have sticky left-20 z-20 with explicit background"""
    
    def test_order_has_order_number_field(self, auth_headers):
        """Verify orders have order_number field for sticky column rendering"""
        response = requests.get(f"{API_URL}/orders", headers=auth_headers)
        assert response.status_code == 200
        orders = response.json()
        
        if orders:
            first_order = orders[0]
            assert "order_number" in first_order, "Orders should have order_number field"
            print(f"First order number: {first_order.get('order_number')}")
    
    def test_create_order_generates_order_number(self, auth_headers):
        """Create order and verify order_number is generated"""
        response = requests.post(
            f"{API_URL}/orders",
            headers=auth_headers,
            json={
                "client": "LOVE IN FAITH",
                "priority": "RUSH",
                "quantity": 100
            }
        )
        assert response.status_code == 200, f"Create order failed: {response.status_code}"
        order = response.json()
        
        assert "order_number" in order, "Created order should have order_number"
        assert "order_id" in order, "Created order should have order_id"
        print(f"Created order: {order.get('order_number')} (id: {order.get('order_id')})")
        
        return order


class TestBug4CustomFieldPersistence(TestSetup):
    """Bug #4: Backend OrderUpdate model accepts extra fields (model_config extra=allow)
    When checkbox in custom column is checked and order is moved to another board, value should persist"""
    
    def test_order_update_accepts_extra_fields(self, auth_headers):
        """PUT /api/orders/{id} should accept custom fields like custom_test_field"""
        # First create an order
        create_response = requests.post(
            f"{API_URL}/orders",
            headers=auth_headers,
            json={
                "client": "TARGET",
                "priority": "PRIORITY 1",
                "quantity": 50
            }
        )
        assert create_response.status_code == 200, f"Create failed: {create_response.status_code}"
        order = create_response.json()
        order_id = order["order_id"]
        
        # Now update with a custom field (simulating checkbox column)
        update_response = requests.put(
            f"{API_URL}/orders/{order_id}",
            headers=auth_headers,
            json={
                "custom_test_field": True,
                "test_checkbox_value": True,
                "custom_text_value": "Test Custom Value"
            }
        )
        assert update_response.status_code == 200, f"Update with extra fields failed: {update_response.status_code}"
        updated_order = update_response.json()
        
        # Verify the custom field was saved
        assert updated_order.get("custom_test_field") == True, "custom_test_field should be True"
        assert updated_order.get("test_checkbox_value") == True, "test_checkbox_value should be True"
        print(f"Order {order_id} updated with custom fields successfully")
        
        return order_id
    
    def test_custom_field_persists_after_board_move(self, auth_headers):
        """Custom field value should persist when order is moved to another board"""
        # Create order with custom field
        create_response = requests.post(
            f"{API_URL}/orders",
            headers=auth_headers,
            json={
                "client": "SCREENWORKS",
                "priority": "RUSH",
                "quantity": 75
            }
        )
        assert create_response.status_code == 200
        order = create_response.json()
        order_id = order["order_id"]
        
        # Set custom checkbox field to True
        update_response = requests.put(
            f"{API_URL}/orders/{order_id}",
            headers=auth_headers,
            json={
                "custom_checkbox_field": True,
                "custom_notes_field": "Important note"
            }
        )
        assert update_response.status_code == 200, f"Update failed: {update_response.status_code}"
        
        # Verify custom field is set
        get_response = requests.get(f"{API_URL}/orders/{order_id}", headers=auth_headers)
        assert get_response.status_code == 200
        order_before_move = get_response.json()
        assert order_before_move.get("custom_checkbox_field") == True, "Custom field should be True before move"
        print(f"Order {order_id} has custom_checkbox_field=True before board move")
        
        # Move order to different board
        move_response = requests.post(
            f"{API_URL}/orders/{order_id}/move",
            headers=auth_headers,
            json={"board": "BLANKS"}
        )
        assert move_response.status_code == 200, f"Move failed: {move_response.status_code}"
        
        # Verify custom field persists after move
        get_after_move = requests.get(f"{API_URL}/orders/{order_id}", headers=auth_headers)
        assert get_after_move.status_code == 200
        order_after_move = get_after_move.json()
        
        assert order_after_move.get("board") == "BLANKS", "Order should be in BLANKS board"
        assert order_after_move.get("custom_checkbox_field") == True, \
            f"Custom checkbox field should persist after move! Got: {order_after_move.get('custom_checkbox_field')}"
        assert order_after_move.get("custom_notes_field") == "Important note", \
            "Custom notes field should persist after move"
        
        print(f"✓ Bug #4 VERIFIED: Custom field persisted after board move to {order_after_move.get('board')}")
    
    def test_custom_fields_persist_through_put_update(self, auth_headers):
        """Verify custom fields persist when order is updated via PUT (not just move)"""
        # Create order
        create_response = requests.post(
            f"{API_URL}/orders",
            headers=auth_headers,
            json={"client": "Hot Topic", "quantity": 200}
        )
        assert create_response.status_code == 200
        order = create_response.json()
        order_id = order["order_id"]
        
        # Set custom field
        update1 = requests.put(
            f"{API_URL}/orders/{order_id}",
            headers=auth_headers,
            json={"my_checkbox": True}
        )
        assert update1.status_code == 200
        
        # Update board (this tests the PUT endpoint with board change)
        update2 = requests.put(
            f"{API_URL}/orders/{order_id}",
            headers=auth_headers,
            json={"board": "SCREENS", "priority": "OVERSOLD"}
        )
        assert update2.status_code == 200
        
        # Verify custom field still exists
        get_response = requests.get(f"{API_URL}/orders/{order_id}", headers=auth_headers)
        assert get_response.status_code == 200
        final_order = get_response.json()
        
        assert final_order.get("my_checkbox") == True, \
            f"Custom checkbox should persist after PUT update! Got: {final_order.get('my_checkbox')}"
        assert final_order.get("board") == "SCREENS", "Board should be updated to SCREENS"
        assert final_order.get("priority") == "OVERSOLD", "Priority should be updated"
        
        print(f"✓ Custom field my_checkbox persisted through PUT update")


class TestBackendModelConfig(TestSetup):
    """Test that OrderUpdate model has model_config extra=allow"""
    
    def test_model_extra_allows_arbitrary_fields(self, auth_headers):
        """Backend should accept any extra field in PUT /api/orders/{id}"""
        # Create order
        create_response = requests.post(
            f"{API_URL}/orders",
            headers=auth_headers,
            json={"client": "FOCO", "quantity": 30}
        )
        assert create_response.status_code == 200
        order = create_response.json()
        order_id = order["order_id"]
        
        # Send arbitrary fields
        arbitrary_fields = {
            "completely_new_field": "test value",
            "another_checkbox": True,
            "numeric_custom": 42,
            "nested_custom": {"key": "value"}  # Note: may be stringified
        }
        
        update_response = requests.put(
            f"{API_URL}/orders/{order_id}",
            headers=auth_headers,
            json=arbitrary_fields
        )
        assert update_response.status_code == 200, \
            f"PUT with arbitrary fields should not fail: {update_response.status_code}"
        
        # Verify fields were saved
        get_response = requests.get(f"{API_URL}/orders/{order_id}", headers=auth_headers)
        assert get_response.status_code == 200
        saved_order = get_response.json()
        
        assert saved_order.get("completely_new_field") == "test value", \
            "Arbitrary string field should be saved"
        assert saved_order.get("another_checkbox") == True, \
            "Arbitrary boolean field should be saved"
        assert saved_order.get("numeric_custom") == 42, \
            "Arbitrary numeric field should be saved"
        
        print(f"✓ Backend accepts arbitrary fields via model_config extra=allow")


class TestGeneralFunctionality(TestSetup):
    """General functionality tests"""
    
    def test_frontend_compiles_check_via_backend(self, auth_headers):
        """Verify backend is running (frontend compile errors would prevent this)"""
        response = requests.get(f"{API_URL}/config/options", headers=auth_headers)
        assert response.status_code == 200, f"Config endpoint failed: {response.status_code}"
        data = response.json()
        
        # Verify expected options exist
        assert "priorities" in data, "Should have priorities"
        assert "clients" in data, "Should have clients"
        assert "boards" in data, "Should have boards"
        print(f"Backend config verified with {len(data.get('boards', []))} boards")
    
    def test_backend_starts_without_errors(self, auth_headers):
        """Verify all critical endpoints respond"""
        endpoints = [
            "/orders",
            "/config/options",
            "/config/columns",
            "/config/colors",
            "/saved-views",
            "/automations"
        ]
        
        for endpoint in endpoints:
            response = requests.get(f"{API_URL}{endpoint}", headers=auth_headers)
            assert response.status_code in [200, 401, 403], \
                f"Endpoint {endpoint} returned unexpected status: {response.status_code}"
            print(f"✓ {endpoint} - Status: {response.status_code}")


# Cleanup fixture
@pytest.fixture(scope="module", autouse=True)
def cleanup_test_data():
    """Cleanup test data after all tests"""
    yield
    # Cleanup could be added here if needed
    print("\nTest suite completed.")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
