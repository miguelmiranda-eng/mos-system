"""
Test iteration 24: Capacity Plan Bug Fix - Total Completed and In Production metrics
Bug: After deleting orders, Total Produced still showed 10,030 from old production_logs
Fix: 'total_completed' = sum of qty from COMPLETOS orders
     'in_production' = sum of qty from MAQUINA* boards
     Machine total_produced only counts logs for existing orders
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = "test_session_capacity_1772740447233"

class TestCapacityPlanFix:
    """Test capacity-plan endpoint returns corrected metrics"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.headers = {
            "Authorization": f"Bearer {SESSION_TOKEN}",
            "Content-Type": "application/json"
        }
    
    def test_01_capacity_plan_returns_total_completed(self):
        """GET /api/capacity-plan returns 'total_completed' field"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        data = response.json()
        assert "total_completed" in data, "total_completed field missing from response"
        assert isinstance(data["total_completed"], int), "total_completed should be integer"
        print(f"total_completed: {data['total_completed']}")
    
    def test_02_capacity_plan_returns_in_production(self):
        """GET /api/capacity-plan returns 'in_production' field"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        data = response.json()
        assert "in_production" in data, "in_production field missing from response"
        assert isinstance(data["in_production"], int), "in_production should be integer"
        print(f"in_production: {data['in_production']}")
    
    def test_03_total_completed_equals_completos_qty_sum(self):
        """total_completed should be sum of qty from COMPLETOS board orders (5288)"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        data = response.json()
        # COMPLETOS has 3 orders: 288 + 0 + 5000 = 5288
        expected_completed = 5288
        assert data["total_completed"] == expected_completed, \
            f"total_completed expected {expected_completed}, got {data['total_completed']}"
        print(f"PASS: total_completed = {data['total_completed']} (correct for COMPLETOS orders)")
    
    def test_04_in_production_equals_machine_boards_qty_sum(self):
        """in_production should be sum of qty from MAQUINA1-14 board orders (6000)"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        data = response.json()
        # MAQUINA1 has 1 order with qty=6000
        expected_in_production = 6000
        assert data["in_production"] == expected_in_production, \
            f"in_production expected {expected_in_production}, got {data['in_production']}"
        print(f"PASS: in_production = {data['in_production']} (correct for MAQUINA* orders)")
    
    def test_05_no_old_total_produced_field(self):
        """Old 'total_produced' field should NOT be at root level"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        data = response.json()
        # The old total_produced was based on ALL production_logs (10,030)
        assert "total_produced" not in data, \
            f"Old total_produced field still exists: {data.get('total_produced')}"
        print("PASS: No old 'total_produced' field in response")
    
    def test_06_machine_total_produced_excludes_deleted_orders(self):
        """Each machine's total_produced should only count logs for existing orders"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        data = response.json()
        
        # Sum all machine total_produced
        machines_total = sum(m.get("total_produced", 0) for m in data.get("machines", []))
        
        # Old total from ALL production_logs was 10,030
        # New total should be less (only counting logs for completed orders)
        assert machines_total != 10030, \
            f"Machine total_produced still shows old 10,030 value (not filtered by existing orders)"
        
        print(f"PASS: Machine total_produced sum = {machines_total} (not 10,030 - properly filtered)")
    
    def test_07_machines_array_has_14_entries(self):
        """Should return data for all 14 machines"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        data = response.json()
        assert len(data["machines"]) == 14, f"Expected 14 machines, got {len(data['machines'])}"
        
        # Verify machine names
        machine_names = [m["machine"] for m in data["machines"]]
        for i in range(1, 15):
            expected_name = f"MAQUINA{i}"
            assert expected_name in machine_names, f"{expected_name} missing from machines"
        
        print("PASS: All 14 machines present in response")
    
    def test_08_machine_structure_correct(self):
        """Each machine should have correct fields"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        data = response.json()
        
        required_fields = [
            "machine", "total_produced", "active_days", "avg_daily_production",
            "max_daily_production", "remaining_pieces", "estimated_days", 
            "load_status", "orders_in_progress"
        ]
        
        for machine in data["machines"]:
            for field in required_fields:
                assert field in machine, f"Machine {machine.get('machine')} missing field '{field}'"
        
        print("PASS: All machines have correct structure")
    
    def test_09_unauthorized_returns_401(self):
        """Request without auth should return 401"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan")
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("PASS: Unauthorized request returns 401")
    
    def test_10_total_pieces_system_present(self):
        """total_pieces_system should be present"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        data = response.json()
        assert "total_pieces_system" in data, "total_pieces_system field missing"
        assert isinstance(data["total_pieces_system"], int), "total_pieces_system should be integer"
        assert data["total_pieces_system"] > 0, "total_pieces_system should be > 0"
        print(f"total_pieces_system: {data['total_pieces_system']}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
