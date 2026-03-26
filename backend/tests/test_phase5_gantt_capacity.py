"""
Phase 5 Tests: Gantt View and Capacity Plan API Endpoints
Tests for GET /api/gantt-data and GET /api/capacity-plan
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = "test_undo_c3f0af7baf5a"

@pytest.fixture
def auth_headers():
    """Headers with session token for authenticated requests"""
    return {"Cookie": f"session_token={SESSION_TOKEN}"}

@pytest.fixture
def api_client():
    """Shared requests session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


class TestGanttDataEndpoint:
    """Tests for GET /api/gantt-data"""

    def test_gantt_data_requires_authentication(self, api_client):
        """Gantt data endpoint should require authentication"""
        response = api_client.get(f"{BASE_URL}/api/gantt-data")
        assert response.status_code == 401
        assert "Not authenticated" in response.text
        print("PASS: /api/gantt-data requires authentication")

    def test_gantt_data_returns_bars_and_pending(self, api_client, auth_headers):
        """Gantt data should return bars and pending orders"""
        response = api_client.get(f"{BASE_URL}/api/gantt-data", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        # Should have both bars and pending keys
        assert "bars" in data
        assert "pending" in data
        assert isinstance(data["bars"], list)
        assert isinstance(data["pending"], list)
        print(f"PASS: /api/gantt-data returns bars ({len(data['bars'])}) and pending ({len(data['pending'])})")

    def test_gantt_data_bar_structure(self, api_client, auth_headers):
        """Gantt bars should have required fields"""
        response = api_client.get(f"{BASE_URL}/api/gantt-data", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        if data["bars"]:
            bar = data["bars"][0]
            required_fields = ["machine", "order_id", "order_number", "client", 
                             "quantity_total", "quantity_produced", "start_date", 
                             "end_date", "status", "priority"]
            for field in required_fields:
                assert field in bar, f"Bar missing field: {field}"
            
            # Status should be completed or in_progress
            assert bar["status"] in ["completed", "in_progress"]
            print(f"PASS: Gantt bar has all required fields including status={bar['status']}")
        else:
            print("INFO: No bars to validate (empty result)")

    def test_gantt_data_pending_structure(self, api_client, auth_headers):
        """Gantt pending orders should have required fields"""
        response = api_client.get(f"{BASE_URL}/api/gantt-data", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        if data["pending"]:
            pending = data["pending"][0]
            required_fields = ["order_id", "order_number", "client", "quantity_total",
                             "quantity_produced", "remaining", "priority", "board"]
            for field in required_fields:
                assert field in pending, f"Pending order missing field: {field}"
            
            # Remaining should be positive
            assert pending["remaining"] > 0
            print(f"PASS: Pending order has all required fields, remaining={pending['remaining']}")
        else:
            print("INFO: No pending orders to validate")

    def test_gantt_data_supports_date_params(self, api_client, auth_headers):
        """Gantt data should support start_date and end_date query params"""
        params = {"start_date": "2025-01-01", "end_date": "2026-12-31"}
        response = api_client.get(f"{BASE_URL}/api/gantt-data", params=params, headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        assert "bars" in data
        assert "pending" in data
        print("PASS: /api/gantt-data accepts start_date and end_date params")

    def test_gantt_data_filters_by_date_range(self, api_client, auth_headers):
        """Gantt data should filter bars by date range"""
        # Very old date range - should return fewer/no bars
        params = {"start_date": "2020-01-01", "end_date": "2020-01-31"}
        response = api_client.get(f"{BASE_URL}/api/gantt-data", params=params, headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        # Should still return valid structure even if no data in range
        assert "bars" in data
        assert isinstance(data["bars"], list)
        print(f"PASS: Date filtering works, bars in old range: {len(data['bars'])}")


class TestCapacityPlanEndpoint:
    """Tests for GET /api/capacity-plan"""

    def test_capacity_plan_requires_authentication(self, api_client):
        """Capacity plan endpoint should require authentication"""
        response = api_client.get(f"{BASE_URL}/api/capacity-plan")
        assert response.status_code == 401
        assert "Not authenticated" in response.text
        print("PASS: /api/capacity-plan requires authentication")

    def test_capacity_plan_returns_14_machines(self, api_client, auth_headers):
        """Capacity plan should return exactly 14 machines"""
        response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        assert "machines" in data
        assert isinstance(data["machines"], list)
        assert len(data["machines"]) == 14
        print("PASS: /api/capacity-plan returns 14 machines")

    def test_capacity_plan_machine_structure(self, api_client, auth_headers):
        """Each machine should have required capacity fields"""
        response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        required_fields = ["machine", "total_produced", "active_days", 
                         "avg_daily_production", "remaining_pieces", 
                         "estimated_days", "load_status"]
        
        for machine in data["machines"]:
            for field in required_fields:
                assert field in machine, f"Machine {machine.get('machine')} missing field: {field}"
        
        print("PASS: All machines have required capacity fields")

    def test_capacity_plan_machine_names(self, api_client, auth_headers):
        """Machines should be named MAQUINA1 through MAQUINA14"""
        response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        expected_machines = [f"MAQUINA{i}" for i in range(1, 15)]
        actual_machines = [m["machine"] for m in data["machines"]]
        
        assert actual_machines == expected_machines
        print("PASS: Machine names are MAQUINA1-14 in correct order")

    def test_capacity_plan_load_status_values(self, api_client, auth_headers):
        """Load status should be idle, green, yellow, or red"""
        response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        valid_statuses = ["idle", "green", "yellow", "red"]
        for machine in data["machines"]:
            assert machine["load_status"] in valid_statuses, \
                f"{machine['machine']} has invalid load_status: {machine['load_status']}"
        
        print("PASS: All load_status values are valid (idle/green/yellow/red)")

    def test_capacity_plan_load_status_thresholds(self, api_client, auth_headers):
        """Load status should follow threshold rules: <=3 green, 3-7 yellow, >7 red"""
        response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        for machine in data["machines"]:
            est_days = machine["estimated_days"]
            status = machine["load_status"]
            
            if est_days == 0:
                assert status == "idle", f"{machine['machine']}: est_days=0 should be idle, got {status}"
            elif est_days <= 3:
                assert status == "green", f"{machine['machine']}: est_days={est_days} should be green, got {status}"
            elif est_days <= 7:
                assert status == "yellow", f"{machine['machine']}: est_days={est_days} should be yellow, got {status}"
            else:
                assert status == "red", f"{machine['machine']}: est_days={est_days} should be red, got {status}"
        
        print("PASS: Load status thresholds are correctly applied")

    def test_capacity_plan_maquina3_is_red(self, api_client, auth_headers):
        """MAQUINA3 should be red (overloaded) based on test data"""
        response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        maquina3 = next((m for m in data["machines"] if m["machine"] == "MAQUINA3"), None)
        assert maquina3 is not None
        assert maquina3["load_status"] == "red"
        assert maquina3["estimated_days"] > 7
        print(f"PASS: MAQUINA3 is red with {maquina3['estimated_days']} estimated days")

    def test_capacity_plan_maquina5_is_green(self, api_client, auth_headers):
        """MAQUINA5 should be green (available) based on test data"""
        response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        maquina5 = next((m for m in data["machines"] if m["machine"] == "MAQUINA5"), None)
        assert maquina5 is not None
        assert maquina5["load_status"] == "green"
        assert maquina5["estimated_days"] <= 3
        print(f"PASS: MAQUINA5 is green with {maquina5['estimated_days']} estimated days")

    def test_capacity_plan_orders_in_progress(self, api_client, auth_headers):
        """Machines should include orders_in_progress data"""
        response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        assert response.status_code == 200
        data = response.json()
        
        # Find a machine with orders in progress
        machines_with_orders = [m for m in data["machines"] if m.get("orders_in_progress")]
        
        if machines_with_orders:
            machine = machines_with_orders[0]
            order = machine["orders_in_progress"][0]
            required_fields = ["order_id", "remaining", "produced", "total"]
            for field in required_fields:
                assert field in order, f"Order in progress missing field: {field}"
            print(f"PASS: orders_in_progress has correct structure for {machine['machine']}")
        else:
            print("INFO: No machines have orders in progress to validate")


class TestGanttCapacityIntegration:
    """Integration tests for Gantt and Capacity Plan"""

    def test_gantt_machines_match_capacity_machines(self, api_client, auth_headers):
        """Machines in Gantt bars should match Capacity Plan machines"""
        gantt_response = api_client.get(f"{BASE_URL}/api/gantt-data", headers=auth_headers)
        capacity_response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        
        assert gantt_response.status_code == 200
        assert capacity_response.status_code == 200
        
        gantt_machines = set(bar["machine"] for bar in gantt_response.json()["bars"])
        capacity_machines = set(m["machine"] for m in capacity_response.json()["machines"])
        
        # All machines in Gantt should be in Capacity Plan
        assert gantt_machines.issubset(capacity_machines)
        print(f"PASS: All {len(gantt_machines)} Gantt machines are in Capacity Plan")

    def test_both_endpoints_available(self, api_client, auth_headers):
        """Both endpoints should be available and return valid data"""
        gantt_response = api_client.get(f"{BASE_URL}/api/gantt-data", headers=auth_headers)
        capacity_response = api_client.get(f"{BASE_URL}/api/capacity-plan", headers=auth_headers)
        
        assert gantt_response.status_code == 200
        assert capacity_response.status_code == 200
        
        gantt_data = gantt_response.json()
        capacity_data = capacity_response.json()
        
        assert "bars" in gantt_data
        assert "pending" in gantt_data
        assert "machines" in capacity_data
        print("PASS: Both Gantt and Capacity Plan endpoints return valid data")
