"""
Test Suite for Phase 1 Features - MOS SYSTEM CRM
Tests: Status colors, Search highlight, New column types, QTY totals, Column management
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://production-crm-1.preview.emergentagent.com').rstrip('/')

# Test session from main agent
TEST_SESSION = "test_session_1772136570038"

class TestBackendAPIs:
    """Backend API endpoint tests - ensuring existing functionality works"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up session for all tests"""
        self.session = requests.Session()
        self.session.cookies.set("session_token", TEST_SESSION)
        self.session.headers.update({"Content-Type": "application/json"})
    
    # === HEALTH & OPTIONS ===
    
    def test_get_options_endpoint(self):
        """Test GET /api/config/options - should return dropdown options for various fields"""
        response = self.session.get(f"{BASE_URL}/api/config/options")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        # Verify essential option keys exist
        assert "priorities" in data, "Missing 'priorities' in options"
        assert "clients" in data, "Missing 'clients' in options"
        assert "production_statuses" in data, "Missing 'production_statuses' in options"
        assert "boards" in data, "Missing 'boards' in options"
        print(f"Options contains {len(data)} categories")
    
    def test_get_orders_endpoint(self):
        """Test GET /api/orders - should return list of orders"""
        response = self.session.get(f"{BASE_URL}/api/orders")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Orders should be a list"
        if len(data) > 0:
            order = data[0]
            assert "order_id" in order, "Order missing order_id"
            assert "order_number" in order, "Order missing order_number"
            assert "quantity" in order, "Order missing quantity field (needed for QTY totals)"
            print(f"Found {len(data)} orders")
    
    def test_get_orders_by_board(self):
        """Test GET /api/orders?board=SCHEDULING - filter by board"""
        response = self.session.get(f"{BASE_URL}/api/orders", params={"board": "SCHEDULING"})
        assert response.status_code == 200
        
        data = response.json()
        # All orders should be from SCHEDULING board
        for order in data:
            assert order.get("board") == "SCHEDULING", f"Order {order.get('order_id')} not from SCHEDULING"
        print(f"Found {len(data)} orders in SCHEDULING board")
    
    def test_search_orders_by_order_number(self):
        """Test GET /api/orders?search=xxx - Search functionality"""
        # First get an existing order number
        all_orders = self.session.get(f"{BASE_URL}/api/orders").json()
        if len(all_orders) > 0:
            test_order_number = all_orders[0]["order_number"]
            
            # Search for it
            response = self.session.get(f"{BASE_URL}/api/orders", params={"search": test_order_number})
            assert response.status_code == 200
            
            data = response.json()
            assert len(data) >= 1, f"Search for '{test_order_number}' should return at least 1 result"
            # Verify the searched order is in results
            found = any(o["order_number"] == test_order_number for o in data)
            assert found, f"Order {test_order_number} not found in search results"
            print(f"Search for '{test_order_number}' returned {len(data)} orders")
    
    # === ORDER CRUD ===
    
    def test_create_and_update_order(self):
        """Test POST /api/orders and PUT /api/orders/{id} - Create and Update"""
        # Create a test order
        new_order = {
            "order_number": f"TEST_PHASE1_{int(time.time())}",
            "client": "LOVE IN FAITH",
            "branding": "LIF Regular",
            "priority": "RUSH",
            "quantity": 150,
            "board": "SCHEDULING"
        }
        
        create_resp = self.session.post(f"{BASE_URL}/api/orders", json=new_order)
        assert create_resp.status_code == 200, f"Create failed: {create_resp.text}"
        
        created = create_resp.json()
        order_id = created.get("order_id")
        assert order_id, "Created order missing order_id"
        assert created.get("quantity") == 150, "Quantity not set correctly"
        print(f"Created order: {order_id}")
        
        # Update the order - simulate status color change
        update_data = {
            "production_status": "NECESITA EMPACAR",
            "quantity": 200
        }
        update_resp = self.session.put(f"{BASE_URL}/api/orders/{order_id}", json=update_data)
        assert update_resp.status_code == 200, f"Update failed: {update_resp.text}"
        
        updated = update_resp.json()
        assert updated.get("production_status") == "NECESITA EMPACAR", "Status not updated"
        assert updated.get("quantity") == 200, "Quantity not updated"
        print(f"Updated order production_status to NECESITA EMPACAR, quantity to 200")
        
        # Verify the update persisted
        get_resp = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        assert get_resp.status_code == 200
        fetched = get_resp.json()
        assert fetched.get("production_status") == "NECESITA EMPACAR", "Update not persisted"
        
        # Clean up - delete test order
        del_resp = self.session.delete(f"{BASE_URL}/api/orders/{order_id}")
        assert del_resp.status_code == 200, f"Delete failed: {del_resp.text}"
        print(f"Cleaned up test order {order_id}")
    
    def test_order_quantity_for_qty_totals(self):
        """Test that orders have quantity field which is used for QTY footer totals"""
        response = self.session.get(f"{BASE_URL}/api/orders", params={"board": "SCHEDULING"})
        assert response.status_code == 200
        
        data = response.json()
        total_qty = 0
        for order in data:
            qty = order.get("quantity", 0)
            assert isinstance(qty, (int, float)), f"Quantity should be numeric, got {type(qty)}"
            total_qty += qty
        
        print(f"Total quantity in SCHEDULING: {total_qty}")
        # This total should match the footer-total-quantity in the UI
    
    # === AUTOMATIONS ===
    
    def test_automations_endpoint(self):
        """Test GET /api/automations - list automations"""
        response = self.session.get(f"{BASE_URL}/api/automations")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Automations should be a list"
        print(f"Found {len(data)} automations")
    
    # === ACTIVITY LOG ===
    
    def test_activity_log_endpoint(self):
        """Test GET /api/activity - get activity logs"""
        response = self.session.get(f"{BASE_URL}/api/activity", params={"limit": 10})
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert "logs" in data, "Response should contain 'logs'"
        assert "total" in data, "Response should contain 'total'"
        print(f"Activity log has {data['total']} total entries")
    
    # === COMMENTS ===
    
    def test_comments_endpoint(self):
        """Test GET /api/orders/{id}/comments"""
        # Get an existing order
        orders = self.session.get(f"{BASE_URL}/api/orders").json()
        if len(orders) > 0:
            order_id = orders[0]["order_id"]
            
            response = self.session.get(f"{BASE_URL}/api/orders/{order_id}/comments")
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            
            data = response.json()
            assert isinstance(data, list), "Comments should be a list"
            print(f"Order {order_id} has {len(data)} comments")


class TestCustomFieldsForNewColumnTypes:
    """Test custom_fields storage for new column types (checkbox, estado, formula)"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up session for all tests"""
        self.session = requests.Session()
        self.session.cookies.set("session_token", TEST_SESSION)
        self.session.headers.update({"Content-Type": "application/json"})
    
    def test_custom_fields_storage(self):
        """Test that custom_fields can store values for custom columns"""
        # Create order with custom_fields
        new_order = {
            "order_number": f"TEST_CUSTOM_{int(time.time())}",
            "client": "TARGET",
            "quantity": 100,
            "custom_fields": {
                "testcheckbox": True,
                "testformula": "calculated_at_frontend"  # Formula values are calculated in frontend
            }
        }
        
        create_resp = self.session.post(f"{BASE_URL}/api/orders", json=new_order)
        assert create_resp.status_code == 200, f"Create failed: {create_resp.text}"
        
        created = create_resp.json()
        order_id = created.get("order_id")
        
        # Verify custom_fields stored
        custom_fields = created.get("custom_fields", {})
        assert custom_fields.get("testcheckbox") == True, "Checkbox value not stored"
        print(f"Custom fields stored: {custom_fields}")
        
        # Update custom field
        update_resp = self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={
            "custom_fields": {"testcheckbox": False}
        })
        assert update_resp.status_code == 200
        
        # Verify update
        updated = update_resp.json()
        assert updated.get("custom_fields", {}).get("testcheckbox") == False, "Checkbox update failed"
        print("Custom field updated successfully")
        
        # Clean up
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}")


class TestBoardOperations:
    """Test board-related operations for column management per board"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up session for all tests"""
        self.session = requests.Session()
        self.session.cookies.set("session_token", TEST_SESSION)
        self.session.headers.update({"Content-Type": "application/json"})
    
    def test_get_orders_from_multiple_boards(self):
        """Test that we can get orders from different boards"""
        boards_to_test = ["SCHEDULING", "BLANKS", "SCREENS"]
        
        for board in boards_to_test:
            response = self.session.get(f"{BASE_URL}/api/orders", params={"board": board})
            assert response.status_code == 200, f"Failed to get {board} orders"
            
            data = response.json()
            print(f"Board {board}: {len(data)} orders")
    
    def test_move_order_between_boards(self):
        """Test moving order between boards (for column management per board feature)"""
        # Create test order in SCHEDULING
        new_order = {
            "order_number": f"TEST_MOVE_{int(time.time())}",
            "client": "LOVE IN FAITH",
            "quantity": 50,
            "board": "SCHEDULING"
        }
        
        create_resp = self.session.post(f"{BASE_URL}/api/orders", json=new_order)
        assert create_resp.status_code == 200
        
        created = create_resp.json()
        order_id = created.get("order_id")
        assert created.get("board") == "SCHEDULING"
        
        # Move to BLANKS
        update_resp = self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={"board": "BLANKS"})
        assert update_resp.status_code == 200
        
        updated = update_resp.json()
        assert updated.get("board") == "BLANKS", "Board not changed"
        print(f"Order moved from SCHEDULING to BLANKS")
        
        # Clean up
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
