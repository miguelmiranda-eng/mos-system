"""
Test Iteration 14: i18n System & Total Pieces in System Feature
Tests:
- Backend API /api/gantt-data returns total_pieces_system field
- Backend API /api/capacity-plan returns total_pieces_system field  
- Both APIs return numeric value for total_pieces_system
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = os.environ.get('TEST_SESSION_TOKEN', 'test_i18n_session_1772572027445')


class TestTotalPiecesSystem:
    """Tests for total_pieces_system field in APIs"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup for all tests"""
        self.headers = {
            "Authorization": f"Bearer {SESSION_TOKEN}",
            "Content-Type": "application/json"
        }
    
    def test_gantt_data_requires_auth(self):
        """Test that /api/gantt-data requires authentication"""
        response = requests.get(f"{BASE_URL}/api/gantt-data")
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print("✓ /api/gantt-data requires authentication")
    
    def test_gantt_data_returns_total_pieces_system(self):
        """Test that /api/gantt-data returns total_pieces_system field"""
        response = requests.get(f"{BASE_URL}/api/gantt-data", headers=self.headers)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert "total_pieces_system" in data, "Missing total_pieces_system field in gantt-data"
        assert isinstance(data["total_pieces_system"], (int, float)), "total_pieces_system should be numeric"
        assert data["total_pieces_system"] >= 0, "total_pieces_system should be non-negative"
        print(f"✓ /api/gantt-data returns total_pieces_system: {data['total_pieces_system']}")
    
    def test_gantt_data_structure(self):
        """Test that /api/gantt-data has correct structure"""
        response = requests.get(f"{BASE_URL}/api/gantt-data", headers=self.headers)
        assert response.status_code == 200
        
        data = response.json()
        # Required fields
        assert "bars" in data, "Missing bars field"
        assert "pending" in data, "Missing pending field"
        assert "total_pieces_system" in data, "Missing total_pieces_system field"
        
        # bars is a list
        assert isinstance(data["bars"], list), "bars should be a list"
        
        # pending is a list
        assert isinstance(data["pending"], list), "pending should be a list"
        
        print(f"✓ /api/gantt-data structure correct: {len(data['bars'])} bars, {len(data['pending'])} pending")
    
    def test_capacity_plan_requires_auth(self):
        """Test that /api/capacity-plan requires authentication"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan")
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print("✓ /api/capacity-plan requires authentication")
    
    def test_capacity_plan_returns_total_pieces_system(self):
        """Test that /api/capacity-plan returns total_pieces_system field"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert "total_pieces_system" in data, "Missing total_pieces_system field in capacity-plan"
        assert isinstance(data["total_pieces_system"], (int, float)), "total_pieces_system should be numeric"
        assert data["total_pieces_system"] >= 0, "total_pieces_system should be non-negative"
        print(f"✓ /api/capacity-plan returns total_pieces_system: {data['total_pieces_system']}")
    
    def test_capacity_plan_structure(self):
        """Test that /api/capacity-plan has correct structure"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        
        data = response.json()
        # Required fields
        assert "machines" in data, "Missing machines field"
        assert "total_pieces_system" in data, "Missing total_pieces_system field"
        
        # machines is a list of 14 machines
        assert isinstance(data["machines"], list), "machines should be a list"
        assert len(data["machines"]) == 14, f"Expected 14 machines, got {len(data['machines'])}"
        
        # Each machine should have required fields
        for machine in data["machines"]:
            assert "machine" in machine, "Missing machine name"
            assert "load_status" in machine, "Missing load_status"
            assert "remaining_pieces" in machine, "Missing remaining_pieces"
            assert "avg_daily_production" in machine, "Missing avg_daily_production"
        
        print(f"✓ /api/capacity-plan structure correct: {len(data['machines'])} machines")
    
    def test_total_pieces_system_consistency(self):
        """Test that total_pieces_system is consistent between gantt-data and capacity-plan"""
        gantt_response = requests.get(f"{BASE_URL}/api/gantt-data", headers=self.headers)
        plan_response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        
        assert gantt_response.status_code == 200
        assert plan_response.status_code == 200
        
        gantt_total = gantt_response.json().get("total_pieces_system", 0)
        plan_total = plan_response.json().get("total_pieces_system", 0)
        
        assert gantt_total == plan_total, f"total_pieces_system mismatch: gantt={gantt_total}, plan={plan_total}"
        print(f"✓ total_pieces_system is consistent: {gantt_total} in both APIs")
    
    def test_machine_load_status_values(self):
        """Test that machine load_status has valid values"""
        response = requests.get(f"{BASE_URL}/api/capacity-plan", headers=self.headers)
        assert response.status_code == 200
        
        data = response.json()
        valid_statuses = {"idle", "green", "yellow", "red"}
        
        for machine in data["machines"]:
            status = machine.get("load_status", "")
            assert status in valid_statuses, f"Invalid load_status '{status}' for {machine['machine']}"
        
        print("✓ All machine load_status values are valid")


class TestGanttDataFiltering:
    """Tests for date filtering in gantt-data API"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup for all tests"""
        self.headers = {
            "Authorization": f"Bearer {SESSION_TOKEN}",
            "Content-Type": "application/json"
        }
    
    def test_gantt_data_with_date_filter(self):
        """Test that /api/gantt-data accepts date parameters"""
        params = {
            "start_date": "2026-01-01T00:00:00Z",
            "end_date": "2026-12-31T23:59:59Z"
        }
        response = requests.get(f"{BASE_URL}/api/gantt-data", headers=self.headers, params=params)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert "bars" in data
        assert "pending" in data
        assert "total_pieces_system" in data
        print(f"✓ /api/gantt-data accepts date filters")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
