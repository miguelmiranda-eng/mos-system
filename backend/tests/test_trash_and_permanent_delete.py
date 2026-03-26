"""
Backend tests for Trash functionality and Permanent Delete endpoint
Testing iteration 3: Bug fixes for light theme and trash icon
"""
import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = "test_session_1772136570038"  # From previous iteration

class TestTrashFunctionality:
    """Test trash board and permanent delete functionality"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test headers"""
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SESSION_TOKEN}"
        }
    
    def test_auth_is_working(self):
        """Verify auth token is valid"""
        response = requests.get(
            f"{BASE_URL}/api/auth/me",
            headers=self.headers
        )
        assert response.status_code == 200, f"Auth failed: {response.text}"
        data = response.json()
        assert "user_id" in data
        assert data.get("role") == "admin"
        print(f"Auth verified - User: {data.get('name')}")
    
    def test_get_trash_orders(self):
        """Test fetching orders from trash board (PAPELERA DE RECICLAJE)"""
        response = requests.get(
            f"{BASE_URL}/api/orders",
            params={"board": "PAPELERA DE RECICLAJE"},
            headers=self.headers
        )
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        print(f"Trash orders count: {len(data)}")
        
        # Verify all returned orders are in trash board
        for order in data:
            assert order.get("board") == "PAPELERA DE RECICLAJE"
    
    def test_move_order_to_trash_and_permanent_delete(self):
        """Full flow: Create -> Move to Trash -> Permanent Delete"""
        # 1. Create a test order
        test_order_number = f"TEST-TRASH-{uuid.uuid4().hex[:8].upper()}"
        create_response = requests.post(
            f"{BASE_URL}/api/orders",
            headers=self.headers,
            json={
                "order_number": test_order_number,
                "client": "ROSS",
                "priority": "RUSH",
                "quantity": 25
            }
        )
        assert create_response.status_code == 200
        created_order = create_response.json()
        order_id = created_order["order_id"]
        assert created_order["board"] == "SCHEDULING"
        print(f"Created order: {order_id}")
        
        # 2. Move to trash using bulk-move
        trash_response = requests.post(
            f"{BASE_URL}/api/orders/bulk-move",
            headers=self.headers,
            json={
                "order_ids": [order_id],
                "board": "PAPELERA DE RECICLAJE"
            }
        )
        assert trash_response.status_code == 200
        assert trash_response.json().get("modified_count") == 1
        print(f"Moved order to trash")
        
        # 3. Verify order is in trash
        get_response = requests.get(
            f"{BASE_URL}/api/orders/{order_id}",
            headers=self.headers
        )
        assert get_response.status_code == 200
        order_data = get_response.json()
        assert order_data["board"] == "PAPELERA DE RECICLAJE"
        print(f"Verified order is in trash")
        
        # 4. Permanent delete
        delete_response = requests.delete(
            f"{BASE_URL}/api/orders/{order_id}/permanent",
            headers=self.headers
        )
        assert delete_response.status_code == 200
        assert "permanently deleted" in delete_response.json().get("message", "").lower()
        print(f"Permanently deleted order")
        
        # 5. Verify order no longer exists
        verify_response = requests.get(
            f"{BASE_URL}/api/orders/{order_id}",
            headers=self.headers
        )
        assert verify_response.status_code == 404
        print(f"Verified order no longer exists")
    
    def test_permanent_delete_nonexistent_order(self):
        """Test permanent delete returns 404 for nonexistent order"""
        response = requests.delete(
            f"{BASE_URL}/api/orders/nonexistent_order_id/permanent",
            headers=self.headers
        )
        assert response.status_code == 404
        assert "not found" in response.json().get("detail", "").lower()
    
    def test_restore_order_from_trash(self):
        """Test restoring an order from trash back to a board"""
        # 1. Create a test order
        test_order_number = f"TEST-RESTORE-{uuid.uuid4().hex[:8].upper()}"
        create_response = requests.post(
            f"{BASE_URL}/api/orders",
            headers=self.headers,
            json={
                "order_number": test_order_number,
                "client": "TARGET",
                "priority": "PRIORITY 1",
                "quantity": 30
            }
        )
        assert create_response.status_code == 200
        order_id = create_response.json()["order_id"]
        
        # 2. Move to trash
        requests.post(
            f"{BASE_URL}/api/orders/bulk-move",
            headers=self.headers,
            json={"order_ids": [order_id], "board": "PAPELERA DE RECICLAJE"}
        )
        
        # 3. Restore to BLANKS board
        restore_response = requests.post(
            f"{BASE_URL}/api/orders/bulk-move",
            headers=self.headers,
            json={"order_ids": [order_id], "board": "BLANKS"}
        )
        assert restore_response.status_code == 200
        
        # 4. Verify order is now in BLANKS
        get_response = requests.get(
            f"{BASE_URL}/api/orders/{order_id}",
            headers=self.headers
        )
        assert get_response.status_code == 200
        assert get_response.json()["board"] == "BLANKS"
        print(f"Order successfully restored to BLANKS")
        
        # Cleanup - permanent delete
        requests.delete(
            f"{BASE_URL}/api/orders/{order_id}/permanent",
            headers=self.headers
        )


class TestConfigOptions:
    """Test config options endpoint returns expected dropdown values"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SESSION_TOKEN}"
        }
    
    def test_get_config_options(self):
        """Verify config options returns all expected keys"""
        response = requests.get(
            f"{BASE_URL}/api/config/options",
            headers=self.headers
        )
        assert response.status_code == 200
        options = response.json()
        
        # Check required option keys exist
        required_keys = [
            "priorities", "clients", "brandings", "blank_sources",
            "blank_statuses", "production_statuses", "trim_statuses",
            "trim_boxes", "samples", "artwork_statuses", "betty_columns", "shippings"
        ]
        for key in required_keys:
            assert key in options, f"Missing option key: {key}"
            assert isinstance(options[key], list), f"{key} should be a list"
            assert len(options[key]) > 0, f"{key} should not be empty"
        
        print(f"Config options verified - {len(options)} option groups")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
