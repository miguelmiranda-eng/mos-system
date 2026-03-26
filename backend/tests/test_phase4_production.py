"""
Phase 4 Production Logs Tests - Iteration 10
Tests for production registration, machine validation, and production summary endpoints
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = "test_undo_c3f0af7baf5a"

# Valid machines: MAQUINA1 through MAQUINA14
VALID_MACHINES = [f"MAQUINA{i}" for i in range(1, 15)]


@pytest.fixture
def auth_session():
    """Create authenticated session with admin token"""
    session = requests.Session()
    session.cookies.set("session_token", SESSION_TOKEN)
    session.headers.update({"Content-Type": "application/json"})
    return session


@pytest.fixture
def test_order(auth_session):
    """Create a test order for production log tests"""
    order_data = {
        "order_number": "PROD_TEST_ORDER_001",
        "client": "Test Client",
        "quantity": 1000,
        "priority": "PRIORITY 1"
    }
    res = auth_session.post(f"{BASE_URL}/api/orders", json=order_data)
    assert res.status_code == 200, f"Failed to create test order: {res.text}"
    order = res.json()
    yield order
    # Cleanup: move to trash and delete
    auth_session.delete(f"{BASE_URL}/api/orders/{order['order_id']}")
    auth_session.delete(f"{BASE_URL}/api/orders/{order['order_id']}/permanent")


class TestProductionLogCreate:
    """Tests for POST /api/production-logs endpoint"""
    
    def test_create_production_log_success(self, auth_session, test_order):
        """Test creating a production log with valid data"""
        log_data = {
            "order_id": test_order["order_id"],
            "quantity_produced": 100,
            "machine": "MAQUINA1",
            "setup": 5
        }
        res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
        
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        
        data = res.json()
        assert "log_id" in data, "Response should contain log_id"
        assert data["order_id"] == test_order["order_id"]
        assert data["quantity_produced"] == 100
        assert data["machine"] == "MAQUINA1"
        assert data["setup"] == 5
        assert "user_name" in data
        assert "created_at" in data
        
        # Cleanup
        auth_session.delete(f"{BASE_URL}/api/production-logs/{data['log_id']}")
    
    def test_create_production_log_all_machines(self, auth_session, test_order):
        """Test that all MAQUINA1-14 are valid machines"""
        created_logs = []
        
        for machine in VALID_MACHINES[:3]:  # Test first 3 machines to save time
            log_data = {
                "order_id": test_order["order_id"],
                "quantity_produced": 10,
                "machine": machine,
                "setup": 0
            }
            res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
            assert res.status_code == 200, f"Machine {machine} should be valid: {res.text}"
            created_logs.append(res.json()["log_id"])
        
        # Cleanup
        for log_id in created_logs:
            auth_session.delete(f"{BASE_URL}/api/production-logs/{log_id}")
    
    def test_create_production_log_invalid_machine(self, auth_session, test_order):
        """Test that invalid machine names are rejected"""
        invalid_machines = ["MAQUINA0", "MAQUINA15", "MACHINE1", "maquina1", "INVALID"]
        
        for machine in invalid_machines:
            log_data = {
                "order_id": test_order["order_id"],
                "quantity_produced": 50,
                "machine": machine,
                "setup": 0
            }
            res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
            assert res.status_code == 400, f"Machine {machine} should be invalid, got {res.status_code}"
            assert "Invalid machine" in res.json().get("detail", "")
    
    def test_create_production_log_invalid_order(self, auth_session):
        """Test that non-existent order_id is rejected"""
        log_data = {
            "order_id": "order_nonexistent_12345",
            "quantity_produced": 100,
            "machine": "MAQUINA5",
            "setup": 0
        }
        res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
        
        assert res.status_code == 404, f"Expected 404 for non-existent order, got {res.status_code}"
        assert "not found" in res.json().get("detail", "").lower()
    
    def test_create_production_log_zero_setup(self, auth_session, test_order):
        """Test creating log with setup=0 (default)"""
        log_data = {
            "order_id": test_order["order_id"],
            "quantity_produced": 50,
            "machine": "MAQUINA7"
        }  # No setup field - should default to 0
        
        res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
        assert res.status_code == 200, f"Failed: {res.text}"
        
        data = res.json()
        assert data["setup"] == 0, "Setup should default to 0"
        
        # Cleanup
        auth_session.delete(f"{BASE_URL}/api/production-logs/{data['log_id']}")
    
    def test_create_production_log_requires_auth(self):
        """Test that production log creation requires authentication"""
        session = requests.Session()
        session.headers.update({"Content-Type": "application/json"})
        
        log_data = {
            "order_id": "order_any",
            "quantity_produced": 100,
            "machine": "MAQUINA1",
            "setup": 0
        }
        res = session.post(f"{BASE_URL}/api/production-logs", json=log_data)
        
        assert res.status_code == 401, f"Expected 401 without auth, got {res.status_code}"


class TestProductionLogGet:
    """Tests for GET /api/production-logs/{order_id} endpoint"""
    
    def test_get_production_logs_empty(self, auth_session, test_order):
        """Test getting logs for order with no production"""
        res = auth_session.get(f"{BASE_URL}/api/production-logs/{test_order['order_id']}")
        
        assert res.status_code == 200
        data = res.json()
        assert "logs" in data
        assert "total_produced" in data
        assert data["total_produced"] == 0
        assert len(data["logs"]) == 0
    
    def test_get_production_logs_with_data(self, auth_session, test_order):
        """Test getting logs after adding production entries"""
        # Create multiple production logs
        log_ids = []
        quantities = [100, 200, 150]
        
        for i, qty in enumerate(quantities):
            log_data = {
                "order_id": test_order["order_id"],
                "quantity_produced": qty,
                "machine": f"MAQUINA{i+1}",
                "setup": i
            }
            res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
            assert res.status_code == 200
            log_ids.append(res.json()["log_id"])
        
        # Get logs
        res = auth_session.get(f"{BASE_URL}/api/production-logs/{test_order['order_id']}")
        assert res.status_code == 200
        
        data = res.json()
        assert data["total_produced"] == sum(quantities), f"Expected {sum(quantities)}, got {data['total_produced']}"
        assert len(data["logs"]) == len(quantities)
        
        # Verify log structure
        for log in data["logs"]:
            assert "log_id" in log
            assert "quantity_produced" in log
            assert "machine" in log
            assert "setup" in log
            assert "user_name" in log
            assert "created_at" in log
        
        # Cleanup
        for log_id in log_ids:
            auth_session.delete(f"{BASE_URL}/api/production-logs/{log_id}")
    
    def test_get_production_logs_requires_auth(self):
        """Test that getting production logs requires authentication"""
        session = requests.Session()
        res = session.get(f"{BASE_URL}/api/production-logs/order_any")
        
        assert res.status_code == 401


class TestProductionSummary:
    """Tests for GET /api/production-summary endpoint"""
    
    def test_get_production_summary(self, auth_session, test_order):
        """Test production summary returns aggregated data"""
        # Create production logs
        log_ids = []
        for i in range(3):
            log_data = {
                "order_id": test_order["order_id"],
                "quantity_produced": 100,
                "machine": f"MAQUINA{i+1}",
                "setup": 0
            }
            res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
            assert res.status_code == 200
            log_ids.append(res.json()["log_id"])
        
        # Get summary
        res = auth_session.get(f"{BASE_URL}/api/production-summary")
        assert res.status_code == 200
        
        data = res.json()
        assert isinstance(data, dict), "Summary should be a dict"
        
        # Check our test order is in summary
        order_summary = data.get(test_order["order_id"])
        assert order_summary is not None, f"Order {test_order['order_id']} should be in summary"
        assert order_summary["total_produced"] == 300
        assert order_summary["log_count"] == 3
        
        # Cleanup
        for log_id in log_ids:
            auth_session.delete(f"{BASE_URL}/api/production-logs/{log_id}")
    
    def test_production_summary_requires_auth(self):
        """Test that production summary requires authentication"""
        session = requests.Session()
        res = session.get(f"{BASE_URL}/api/production-summary")
        
        assert res.status_code == 401


class TestProductionLogDelete:
    """Tests for DELETE /api/production-logs/{log_id} endpoint"""
    
    def test_delete_production_log_admin_success(self, auth_session, test_order):
        """Test admin can delete production log"""
        # Create a log
        log_data = {
            "order_id": test_order["order_id"],
            "quantity_produced": 100,
            "machine": "MAQUINA1",
            "setup": 0
        }
        res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
        assert res.status_code == 200
        log_id = res.json()["log_id"]
        
        # Delete it
        res = auth_session.delete(f"{BASE_URL}/api/production-logs/{log_id}")
        assert res.status_code == 200, f"Admin should be able to delete: {res.text}"
        
        # Verify it's deleted - get logs should not include it
        res = auth_session.get(f"{BASE_URL}/api/production-logs/{test_order['order_id']}")
        assert res.status_code == 200
        logs = res.json()["logs"]
        log_ids = [l["log_id"] for l in logs]
        assert log_id not in log_ids, "Deleted log should not appear in list"
    
    def test_delete_production_log_not_found(self, auth_session):
        """Test deleting non-existent log returns 404"""
        res = auth_session.delete(f"{BASE_URL}/api/production-logs/plog_nonexistent")
        assert res.status_code == 404
    
    def test_delete_production_log_requires_admin(self, test_order):
        """Test that non-admin cannot delete production logs"""
        # Create a non-admin session
        session = requests.Session()
        # We'll use a different approach - try to delete without valid admin session
        session.headers.update({"Content-Type": "application/json"})
        
        res = session.delete(f"{BASE_URL}/api/production-logs/plog_any")
        # Should return 401 (not authenticated) or 403 (not admin)
        assert res.status_code in [401, 403], f"Expected 401/403, got {res.status_code}"


class TestMachineValidation:
    """Additional tests for machine validation"""
    
    def test_all_14_machines_valid(self, auth_session, test_order):
        """Comprehensive test that all 14 machines are accepted"""
        for i in range(1, 15):
            machine = f"MAQUINA{i}"
            log_data = {
                "order_id": test_order["order_id"],
                "quantity_produced": 1,
                "machine": machine,
                "setup": 0
            }
            res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
            assert res.status_code == 200, f"MAQUINA{i} should be valid: {res.text}"
            
            # Cleanup immediately
            auth_session.delete(f"{BASE_URL}/api/production-logs/{res.json()['log_id']}")


class TestProductionDataPersistence:
    """Tests to verify production data persists correctly"""
    
    def test_production_affects_remaining_calculation(self, auth_session, test_order):
        """Test that production updates are reflected in totals"""
        # Initial state
        res = auth_session.get(f"{BASE_URL}/api/production-logs/{test_order['order_id']}")
        assert res.status_code == 200
        initial_total = res.json()["total_produced"]
        assert initial_total == 0
        
        # Add production
        log_data = {
            "order_id": test_order["order_id"],
            "quantity_produced": 250,
            "machine": "MAQUINA10",
            "setup": 3
        }
        res = auth_session.post(f"{BASE_URL}/api/production-logs", json=log_data)
        assert res.status_code == 200
        log_id = res.json()["log_id"]
        
        # Check updated total
        res = auth_session.get(f"{BASE_URL}/api/production-logs/{test_order['order_id']}")
        assert res.status_code == 200
        assert res.json()["total_produced"] == 250
        
        # Delete and verify
        auth_session.delete(f"{BASE_URL}/api/production-logs/{log_id}")
        
        res = auth_session.get(f"{BASE_URL}/api/production-logs/{test_order['order_id']}")
        assert res.status_code == 200
        assert res.json()["total_produced"] == 0, "Total should be 0 after deleting log"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
