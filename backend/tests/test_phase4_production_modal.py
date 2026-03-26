"""
Test Phase 4: Production Modal Adjustments
- Backend endpoints for production logs remain unchanged
- Tests verify API functionality
"""
import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = "test_undo_c3f0af7baf5a"

class TestProductionEndpoints:
    """Test production log API endpoints"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test session"""
        self.session = requests.Session()
        self.session.cookies.set("session_token", SESSION_TOKEN)
        self.session.headers.update({"Content-Type": "application/json"})
        
    def test_health_and_auth(self):
        """Verify auth is working"""
        response = self.session.get(f"{BASE_URL}/api/auth/me")
        assert response.status_code == 200, f"Auth failed: {response.text}"
        user = response.json()
        assert "name" in user
        assert user.get("role") == "admin"
        print(f"✓ Auth working, user: {user.get('name')}, role: {user.get('role')}")
        
    def test_get_orders_list(self):
        """Verify we can get orders for production modal dropdown"""
        response = self.session.get(f"{BASE_URL}/api/orders")
        assert response.status_code == 200
        orders = response.json()
        assert isinstance(orders, list)
        print(f"✓ Orders list returned: {len(orders)} orders")
        
        # Look for UNDO-E2E test order
        undo_order = next((o for o in orders if o.get("order_number") == "UNDO-E2E"), None)
        if undo_order:
            print(f"  Found UNDO-E2E order: {undo_order.get('order_id')}")
            
    def test_create_production_log_valid_machine(self):
        """Test POST /api/production-logs with valid machine"""
        # First create a test order
        order_data = {
            "order_number": f"PROD_TEST_{uuid.uuid4().hex[:8].upper()}",
            "client": "TEST CLIENT",
            "quantity": 1000
        }
        create_resp = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        assert create_resp.status_code == 200
        order = create_resp.json()
        order_id = order.get("order_id")
        
        # Test production log creation
        prod_data = {
            "order_id": order_id,
            "quantity_produced": 100,
            "machine": "MAQUINA5",
            "setup": 15
        }
        response = self.session.post(f"{BASE_URL}/api/production-logs", json=prod_data)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        log = response.json()
        
        # Validate response data
        assert log.get("order_id") == order_id
        assert log.get("quantity_produced") == 100
        assert log.get("machine") == "MAQUINA5"
        assert log.get("setup") == 15
        assert "log_id" in log
        print(f"✓ Production log created: {log.get('log_id')}")
        
        # Cleanup - delete test order
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        
    def test_create_production_log_invalid_machine(self):
        """Test POST /api/production-logs rejects invalid machine"""
        # Create a temp order
        order_data = {"order_number": f"INVALID_M_{uuid.uuid4().hex[:6].upper()}", "quantity": 500}
        create_resp = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        assert create_resp.status_code == 200
        order_id = create_resp.json().get("order_id")
        
        # Test invalid machines
        invalid_machines = ["MAQUINA0", "MAQUINA15", "MACHINE1", "maquina1", ""]
        
        for invalid in invalid_machines:
            prod_data = {
                "order_id": order_id,
                "quantity_produced": 50,
                "machine": invalid,
                "setup": 0
            }
            response = self.session.post(f"{BASE_URL}/api/production-logs", json=prod_data)
            assert response.status_code == 400, f"Expected 400 for machine '{invalid}', got {response.status_code}"
            print(f"✓ Invalid machine '{invalid}' correctly rejected (400)")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        
    def test_create_production_log_invalid_order(self):
        """Test POST /api/production-logs returns 404 for non-existent order"""
        prod_data = {
            "order_id": "non_existent_order_12345",
            "quantity_produced": 100,
            "machine": "MAQUINA1",
            "setup": 0
        }
        response = self.session.post(f"{BASE_URL}/api/production-logs", json=prod_data)
        assert response.status_code == 404
        print("✓ Non-existent order returns 404")
        
    def test_get_production_logs_for_order(self):
        """Test GET /api/production-logs/{order_id} returns logs and total"""
        # First get orders and find UNDO-E2E
        orders_resp = self.session.get(f"{BASE_URL}/api/orders")
        orders = orders_resp.json()
        undo_order = next((o for o in orders if o.get("order_number") == "UNDO-E2E"), None)
        
        if not undo_order:
            # Create test order with production
            order_data = {"order_number": "TEST_PRODLOGS", "quantity": 500}
            create_resp = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
            order_id = create_resp.json().get("order_id")
            
            # Add production log
            self.session.post(f"{BASE_URL}/api/production-logs", json={
                "order_id": order_id,
                "quantity_produced": 200,
                "machine": "MAQUINA3"
            })
        else:
            order_id = undo_order.get("order_id")
        
        # Get logs
        response = self.session.get(f"{BASE_URL}/api/production-logs/{order_id}")
        assert response.status_code == 200
        data = response.json()
        
        assert "logs" in data
        assert "total_produced" in data
        assert isinstance(data["logs"], list)
        assert isinstance(data["total_produced"], int)
        print(f"✓ Logs for order {order_id}: {len(data['logs'])} entries, total: {data['total_produced']}")
        
    def test_get_production_summary(self):
        """Test GET /api/production-summary returns aggregated data"""
        response = self.session.get(f"{BASE_URL}/api/production-summary")
        assert response.status_code == 200
        summary = response.json()
        
        # Should return dict of order_id -> {total_produced, log_count}
        assert isinstance(summary, dict)
        print(f"✓ Production summary: {len(summary)} orders with production data")
        
        # Verify structure if any data exists
        for order_id, data in summary.items():
            assert "total_produced" in data
            assert "log_count" in data
            
    def test_all_14_machines_valid(self):
        """Test that all MAQUINA1-14 are accepted"""
        # Create temp order
        order_data = {"order_number": f"MACHINE_TEST_{uuid.uuid4().hex[:6].upper()}", "quantity": 1400}
        create_resp = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        order_id = create_resp.json().get("order_id")
        
        valid_machines = [f"MAQUINA{i}" for i in range(1, 15)]
        
        for machine in valid_machines:
            prod_data = {
                "order_id": order_id,
                "quantity_produced": 10,
                "machine": machine
            }
            response = self.session.post(f"{BASE_URL}/api/production-logs", json=prod_data)
            assert response.status_code == 200, f"Machine {machine} should be valid, got {response.status_code}"
        
        print(f"✓ All 14 machines (MAQUINA1-14) are valid")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        
    def test_production_log_requires_auth(self):
        """Test production endpoints require authentication"""
        # Unauthenticated session
        unauth_session = requests.Session()
        unauth_session.headers.update({"Content-Type": "application/json"})
        
        # Test POST
        response = unauth_session.post(f"{BASE_URL}/api/production-logs", json={
            "order_id": "any",
            "quantity_produced": 100,
            "machine": "MAQUINA1"
        })
        assert response.status_code == 401
        print("✓ POST /api/production-logs requires auth (401)")
        
        # Test GET
        response = unauth_session.get(f"{BASE_URL}/api/production-logs/any_order")
        assert response.status_code == 401
        print("✓ GET /api/production-logs/{order_id} requires auth (401)")
        
        # Test GET summary
        response = unauth_session.get(f"{BASE_URL}/api/production-summary")
        assert response.status_code == 401
        print("✓ GET /api/production-summary requires auth (401)")
        
    def test_delete_production_log_admin_only(self):
        """Test DELETE /api/production-logs/{log_id} requires admin"""
        # First create order and log
        order_data = {"order_number": f"DEL_TEST_{uuid.uuid4().hex[:6].upper()}", "quantity": 100}
        create_resp = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        order_id = create_resp.json().get("order_id")
        
        log_resp = self.session.post(f"{BASE_URL}/api/production-logs", json={
            "order_id": order_id,
            "quantity_produced": 50,
            "machine": "MAQUINA7"
        })
        log_id = log_resp.json().get("log_id")
        
        # Admin should be able to delete
        response = self.session.delete(f"{BASE_URL}/api/production-logs/{log_id}")
        assert response.status_code == 200
        print(f"✓ Admin can delete production log")
        
        # Verify deleted
        response = self.session.delete(f"{BASE_URL}/api/production-logs/{log_id}")
        assert response.status_code == 404
        print("✓ Deleted log returns 404")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
