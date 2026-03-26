"""
Test Iteration 25: MAQUINA3 Capacity Plan Bug Fix
Bug: MAQUINA3 showed 3 orders when there are 0 physical orders in that board.
Fix: capacity-plan now ONLY shows data based on orders physically present in each machine board.
Historical production_logs should only appear in Gantt, not affect order counts.
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = os.environ.get('SESSION_TOKEN', '')

@pytest.fixture(scope="module")
def auth_headers():
    """Get auth headers with session token"""
    return {"Authorization": f"Bearer {SESSION_TOKEN}"}

class TestCapacityPlanMaquina3Fix:
    """Tests for MAQUINA3 capacity plan bug fix - verifies physical orders only"""
    
    def test_01_capacity_plan_endpoint_accessible(self, auth_headers):
        """Verify capacity-plan endpoint returns 200"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert "machines" in data
        assert len(data["machines"]) == 14
    
    def test_02_maquina3_has_zero_orders(self, auth_headers):
        """CRITICAL: MAQUINA3 should have order_count=0 (no physical orders in board)"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        m3 = next((m for m in data["machines"] if m["machine"] == "MAQUINA3"), None)
        assert m3 is not None, "MAQUINA3 not found in response"
        assert m3["order_count"] == 0, f"MAQUINA3 should have 0 orders, got {m3['order_count']}"
    
    def test_03_maquina3_has_zero_remaining_pieces(self, auth_headers):
        """CRITICAL: MAQUINA3 remaining_pieces should be 0"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        m3 = next((m for m in data["machines"] if m["machine"] == "MAQUINA3"), None)
        assert m3["remaining_pieces"] == 0, f"MAQUINA3 remaining_pieces should be 0, got {m3['remaining_pieces']}"
    
    def test_04_maquina3_load_status_is_idle(self, auth_headers):
        """CRITICAL: MAQUINA3 load_status should be 'idle' with 0 orders"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        m3 = next((m for m in data["machines"] if m["machine"] == "MAQUINA3"), None)
        assert m3["load_status"] == "idle", f"MAQUINA3 load_status should be 'idle', got {m3['load_status']}"
    
    def test_05_maquina3_orders_in_progress_empty(self, auth_headers):
        """CRITICAL: MAQUINA3 orders_in_progress should be empty list"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        m3 = next((m for m in data["machines"] if m["machine"] == "MAQUINA3"), None)
        assert len(m3["orders_in_progress"]) == 0, f"MAQUINA3 orders_in_progress should be empty, got {m3['orders_in_progress']}"
    
    def test_06_maquina1_has_one_order(self, auth_headers):
        """MAQUINA1 should have exactly 1 order (order 2014, qty=6000)"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        m1 = next((m for m in data["machines"] if m["machine"] == "MAQUINA1"), None)
        assert m1 is not None, "MAQUINA1 not found"
        assert m1["order_count"] == 1, f"MAQUINA1 should have 1 order, got {m1['order_count']}"
        assert m1["remaining_pieces"] == 6000, f"MAQUINA1 remaining_pieces should be 6000, got {m1['remaining_pieces']}"
    
    def test_07_maquina1_order_details_correct(self, auth_headers):
        """MAQUINA1 order should be order 2014 with qty 6000"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        m1 = next((m for m in data["machines"] if m["machine"] == "MAQUINA1"), None)
        assert len(m1["orders_in_progress"]) == 1
        order = m1["orders_in_progress"][0]
        assert order["order_number"] == "2014", f"Expected order 2014, got {order['order_number']}"
        assert order["total"] == 6000, f"Expected qty 6000, got {order['total']}"
    
    def test_08_maquina2_through_14_all_idle(self, auth_headers):
        """All MAQUINA2-14 (except MAQUINA1) should be idle with 0 orders"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        # All machines except MAQUINA1 should be idle
        for i in range(2, 15):
            machine_name = f"MAQUINA{i}"
            m = next((m for m in data["machines"] if m["machine"] == machine_name), None)
            assert m is not None, f"{machine_name} not found"
            assert m["order_count"] == 0, f"{machine_name} should have 0 orders, got {m['order_count']}"
            assert m["remaining_pieces"] == 0, f"{machine_name} remaining_pieces should be 0"
            assert m["load_status"] == "idle", f"{machine_name} should be idle"
    
    def test_09_total_completed_equals_completos_qty_sum(self, auth_headers):
        """total_completed = sum of qty from COMPLETOS board orders (5288)"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        # COMPLETOS has: 288 + 0 + 5000 = 5288
        assert data["total_completed"] == 5288, f"total_completed should be 5288, got {data['total_completed']}"
    
    def test_10_in_production_equals_machine_boards_qty_sum(self, auth_headers):
        """in_production = sum of qty from MAQUINA* boards (6000)"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        # Only MAQUINA1 has order 2014 with qty 6000
        assert data["in_production"] == 6000, f"in_production should be 6000, got {data['in_production']}"


class TestGanttDataHistoricalLogs:
    """Verify Gantt data still shows historical production_logs for MAQUINA3"""
    
    def test_11_gantt_data_endpoint_accessible(self, auth_headers):
        """Verify gantt-data endpoint returns 200"""
        response = requests.get(f"{BASE_URL}/api/gantt-data", headers=auth_headers)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert "bars" in data
        assert "pending" in data
    
    def test_12_gantt_shows_maquina3_historical_bars(self, auth_headers):
        """Gantt should show historical production bars for MAQUINA3"""
        response = requests.get(f"{BASE_URL}/api/gantt-data", headers=auth_headers)
        data = response.json()
        
        # Filter bars for MAQUINA3
        m3_bars = [b for b in data["bars"] if b.get("machine") == "MAQUINA3"]
        
        # MAQUINA3 should have multiple historical bars (from 12 production_logs)
        assert len(m3_bars) >= 1, f"Expected MAQUINA3 historical bars in gantt, got {len(m3_bars)}"
        
        # Verify total produced from all M3 bars
        total_m3_produced = sum(b.get("quantity_produced", 0) for b in m3_bars)
        assert total_m3_produced > 0, f"MAQUINA3 historical production should be > 0, got {total_m3_produced}"
    
    def test_13_gantt_total_logs_count(self, auth_headers):
        """Gantt should show all 43 production_logs (historical data)"""
        response = requests.get(f"{BASE_URL}/api/gantt-data", headers=auth_headers)
        data = response.json()
        
        total_logs = sum(b.get("log_count", 0) for b in data["bars"])
        # There should be many historical logs
        assert total_logs >= 40, f"Expected >= 40 total logs in gantt, got {total_logs}"


class TestCapacityPlanStructure:
    """Verify capacity-plan response structure is correct"""
    
    def test_14_response_has_required_fields(self, auth_headers):
        """Verify response has all required top-level fields"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        required_fields = ["machines", "total_pieces_system", "total_completed", "in_production"]
        for field in required_fields:
            assert field in data, f"Missing field: {field}"
    
    def test_15_machine_object_structure(self, auth_headers):
        """Verify each machine object has required fields"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        data = response.json()
        
        machine_fields = [
            "machine", "total_produced", "active_days", "avg_daily_production",
            "max_daily_production", "remaining_pieces", "estimated_days",
            "load_status", "orders_in_progress", "order_count"
        ]
        
        for m in data["machines"]:
            for field in machine_fields:
                assert field in m, f"Machine {m.get('machine', 'unknown')} missing field: {field}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
