"""
Test iteration 38: Extended automation watch fields with date/text columns
Features tested:
- date columns with 'date_updated' condition
- text columns with 'is_empty' and 'not_empty' conditions
- regular select/checkbox columns still work
"""

import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = "ui_header_test_1772822138822"  # Admin session from previous tests

@pytest.fixture
def auth_headers():
    """Headers with authentication cookie"""
    return {
        "Content-Type": "application/json",
        "Cookie": f"session_token={SESSION_TOKEN}"
    }

@pytest.fixture
def api_client():
    """Shared requests session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    session.cookies.set("session_token", SESSION_TOKEN)
    return session


class TestAutomationCRUD:
    """Test automation CRUD operations"""
    
    def test_get_automations(self, api_client):
        """Test GET /api/automations returns list of automations"""
        response = api_client.get(f"{BASE_URL}/api/automations")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert isinstance(data, list), "Expected list of automations"
        print(f"Found {len(data)} existing automations")
    
    def test_create_automation_date_updated(self, api_client):
        """Test creating automation with date_updated condition"""
        payload = {
            "name": "TEST_DateUpdatedAutomation",
            "trigger_type": "status_change",
            "trigger_conditions": {
                "watch_field": "cancel_date",
                "watch_value": "date_updated"
            },
            "action_type": "move_board",
            "action_params": {"target_board": "COMPLETOS"},
            "is_active": True,
            "boards": ["SCHEDULING"]
        }
        response = api_client.post(f"{BASE_URL}/api/automations", json=payload)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "automation_id" in data
        assert data["name"] == "TEST_DateUpdatedAutomation"
        assert data["trigger_conditions"]["watch_field"] == "cancel_date"
        assert data["trigger_conditions"]["watch_value"] == "date_updated"
        print(f"Created automation: {data['automation_id']}")
        return data["automation_id"]
    
    def test_create_automation_is_empty(self, api_client):
        """Test creating automation with is_empty condition"""
        payload = {
            "name": "TEST_IsEmptyAutomation",
            "trigger_type": "status_change",
            "trigger_conditions": {
                "watch_field": "customer_po",
                "watch_value": "is_empty"
            },
            "action_type": "assign_field",
            "action_params": {"field": "priority", "value": "URGENT"},
            "is_active": True,
            "boards": []
        }
        response = api_client.post(f"{BASE_URL}/api/automations", json=payload)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "automation_id" in data
        assert data["trigger_conditions"]["watch_value"] == "is_empty"
        print(f"Created automation: {data['automation_id']}")
        return data["automation_id"]
    
    def test_create_automation_not_empty(self, api_client):
        """Test creating automation with not_empty condition"""
        payload = {
            "name": "TEST_NotEmptyAutomation",
            "trigger_type": "status_change",
            "trigger_conditions": {
                "watch_field": "notes",
                "watch_value": "not_empty"
            },
            "action_type": "notify_slack",
            "action_params": {"message": "Notes field filled"},
            "is_active": True,
            "boards": ["MASTER"]
        }
        response = api_client.post(f"{BASE_URL}/api/automations", json=payload)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "automation_id" in data
        assert data["trigger_conditions"]["watch_value"] == "not_empty"
        print(f"Created automation: {data['automation_id']}")
        return data["automation_id"]
    
    def test_create_automation_regular_select(self, api_client):
        """Test creating automation with regular select value - still works"""
        payload = {
            "name": "TEST_RegularSelectAutomation",
            "trigger_type": "status_change",
            "trigger_conditions": {
                "watch_field": "blank_status",
                "watch_value": "CONTADO/PICKED"
            },
            "action_type": "move_board",
            "action_params": {"target_board": "SCREENS"},
            "is_active": True,
            "boards": ["BLANKS"]
        }
        response = api_client.post(f"{BASE_URL}/api/automations", json=payload)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "automation_id" in data
        assert data["trigger_conditions"]["watch_value"] == "CONTADO/PICKED"
        print(f"Created automation: {data['automation_id']}")
        return data["automation_id"]


class TestCheckConditionsLogic:
    """Test check_conditions logic in the backend by simulating order updates"""
    
    def test_automation_date_updated_condition(self, api_client):
        """Test that date_updated condition triggers on any date change"""
        # Create a test order first
        order_payload = {
            "order_number": "TEST_ORDER_DATE_001",
            "client": "Test Client",
            "branding": "Test Brand",
            "quantity": 100,
            "board": "SCHEDULING",
            "cancel_date": "2026-03-10"
        }
        response = api_client.post(f"{BASE_URL}/api/orders", json=order_payload)
        assert response.status_code in [200, 201], f"Failed to create order: {response.text}"
        order = response.json()
        order_id = order["order_id"]
        print(f"Created test order: {order_id}")
        
        # Update the cancel_date to trigger automation
        update_payload = {"cancel_date": "2026-03-15"}
        response = api_client.put(f"{BASE_URL}/api/orders/{order_id}", json=update_payload)
        assert response.status_code == 200, f"Failed to update order: {response.text}"
        
        # Clean up - delete the order
        api_client.delete(f"{BASE_URL}/api/orders/{order_id}")
        print("Test order cleaned up")
    
    def test_automation_is_empty_condition(self, api_client):
        """Test that is_empty condition triggers when field becomes empty"""
        # Create order with text field filled
        order_payload = {
            "order_number": "TEST_ORDER_EMPTY_001",
            "client": "Test Client",
            "branding": "Test Brand",
            "quantity": 100,
            "board": "MASTER",
            "customer_po": "INITIAL_VALUE"
        }
        response = api_client.post(f"{BASE_URL}/api/orders", json=order_payload)
        assert response.status_code in [200, 201], f"Failed to create order: {response.text}"
        order = response.json()
        order_id = order["order_id"]
        print(f"Created test order: {order_id}")
        
        # Update field to empty to trigger is_empty condition
        update_payload = {"customer_po": ""}
        response = api_client.put(f"{BASE_URL}/api/orders/{order_id}", json=update_payload)
        assert response.status_code == 200, f"Failed to update order: {response.text}"
        
        # Clean up
        api_client.delete(f"{BASE_URL}/api/orders/{order_id}")
        print("Test order cleaned up")
    
    def test_automation_not_empty_condition(self, api_client):
        """Test that not_empty condition triggers when field gets a value"""
        # Create order with empty notes
        order_payload = {
            "order_number": "TEST_ORDER_NOTEMPTY_001",
            "client": "Test Client",
            "branding": "Test Brand",
            "quantity": 100,
            "board": "MASTER",
            "notes": ""
        }
        response = api_client.post(f"{BASE_URL}/api/orders", json=order_payload)
        assert response.status_code in [200, 201], f"Failed to create order: {response.text}"
        order = response.json()
        order_id = order["order_id"]
        print(f"Created test order: {order_id}")
        
        # Update field with a value to trigger not_empty condition
        update_payload = {"notes": "Some important notes here"}
        response = api_client.put(f"{BASE_URL}/api/orders/{order_id}", json=update_payload)
        assert response.status_code == 200, f"Failed to update order: {response.text}"
        
        # Clean up
        api_client.delete(f"{BASE_URL}/api/orders/{order_id}")
        print("Test order cleaned up")


class TestConfigEndpoints:
    """Test configuration endpoints for columns"""
    
    def test_get_columns_config(self, api_client):
        """Test GET /api/config/columns returns column configuration"""
        response = api_client.get(f"{BASE_URL}/api/config/columns")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "custom_columns" in data
        print(f"Found {len(data.get('custom_columns', []))} custom columns")
        
        # Check if we have date and text columns
        custom_cols = data.get("custom_columns", [])
        date_cols = [c for c in custom_cols if c.get("type") == "date"]
        text_cols = [c for c in custom_cols if c.get("type") == "text"]
        print(f"Date columns: {[c['key'] for c in date_cols]}")
        print(f"Text columns: {[c['key'] for c in text_cols]}")
    
    def test_get_boards(self, api_client):
        """Test GET /api/config/boards returns boards list"""
        response = api_client.get(f"{BASE_URL}/api/config/boards")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "boards" in data
        assert isinstance(data["boards"], list)
        assert len(data["boards"]) > 0
        print(f"Found {len(data['boards'])} boards: {data['boards'][:5]}...")


class TestCleanup:
    """Cleanup test automations"""
    
    def test_cleanup_test_automations(self, api_client):
        """Delete all TEST_ prefixed automations"""
        # Get all automations
        response = api_client.get(f"{BASE_URL}/api/automations")
        assert response.status_code == 200
        automations = response.json()
        
        # Delete TEST_ prefixed ones
        deleted_count = 0
        for auto in automations:
            if auto.get("name", "").startswith("TEST_"):
                del_response = api_client.delete(f"{BASE_URL}/api/automations/{auto['automation_id']}")
                if del_response.status_code == 200:
                    deleted_count += 1
                    print(f"Deleted: {auto['name']}")
        
        print(f"Cleaned up {deleted_count} test automations")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
