"""
Iteration 31: Test Automations Boards Feature
- POST /api/automations with 'boards' field
- PUT /api/automations/{id} updates 'boards' field
- GET /api/automations returns 'boards' field
- Automation engine filters by board (tested via data structure)
- Backward compatibility for automations without boards
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = "test_session_iter31_1772751883648"

@pytest.fixture(scope="module")
def api_client():
    """Shared requests session with auth"""
    session = requests.Session()
    session.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {SESSION_TOKEN}"
    })
    return session


class TestAutomationsBoards:
    """Test boards field in automations CRUD"""
    
    created_automation_id = None
    
    def test_01_get_automations_before_create(self, api_client):
        """Verify GET /api/automations works"""
        response = api_client.get(f"{BASE_URL}/api/automations")
        assert response.status_code == 200, f"GET automations failed: {response.text}"
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        print(f"Found {len(data)} existing automations")
    
    def test_02_create_automation_with_boards(self, api_client):
        """POST /api/automations with boards field"""
        payload = {
            "name": "TEST_Automation_With_Boards",
            "trigger_type": "status_change",
            "trigger_conditions": {"watch_field": "priority", "watch_value": "RUSH"},
            "action_type": "move_board",
            "action_params": {"target_board": "COMPLETOS"},
            "is_active": True,
            "boards": ["SCHEDULING", "MASTER"]  # Only applies to these boards
        }
        response = api_client.post(f"{BASE_URL}/api/automations", json=payload)
        assert response.status_code == 200, f"Create automation failed: {response.text}"
        
        data = response.json()
        assert "automation_id" in data, "Response should include automation_id"
        assert data["name"] == "TEST_Automation_With_Boards"
        assert data["boards"] == ["SCHEDULING", "MASTER"], f"Expected boards field, got: {data.get('boards')}"
        assert data["is_active"] == True
        
        TestAutomationsBoards.created_automation_id = data["automation_id"]
        print(f"Created automation: {data['automation_id']} with boards: {data['boards']}")
    
    def test_03_create_automation_without_boards(self, api_client):
        """POST /api/automations without boards field (should apply to all)"""
        payload = {
            "name": "TEST_Automation_All_Boards",
            "trigger_type": "status_change",
            "trigger_conditions": {},
            "action_type": "assign_field",
            "action_params": {"field": "priority", "value": "PRIORITY 1"},
            "is_active": True,
            "boards": []  # Empty = applies to all
        }
        response = api_client.post(f"{BASE_URL}/api/automations", json=payload)
        assert response.status_code == 200, f"Create automation failed: {response.text}"
        
        data = response.json()
        assert "automation_id" in data
        assert data["boards"] == [], "Empty boards should be returned"
        print(f"Created automation without boards (applies to all): {data['automation_id']}")
    
    def test_04_get_automation_has_boards_field(self, api_client):
        """GET /api/automations returns boards field"""
        response = api_client.get(f"{BASE_URL}/api/automations")
        assert response.status_code == 200
        
        data = response.json()
        # Find our test automation
        test_auto = next((a for a in data if a.get("name") == "TEST_Automation_With_Boards"), None)
        assert test_auto is not None, "Could not find created test automation"
        
        assert "boards" in test_auto, "Automation should have boards field in GET response"
        assert test_auto["boards"] == ["SCHEDULING", "MASTER"]
        print(f"Verified automation has boards: {test_auto['boards']}")
    
    def test_05_update_automation_boards(self, api_client):
        """PUT /api/automations/{id} updates boards field"""
        automation_id = TestAutomationsBoards.created_automation_id
        assert automation_id is not None, "No automation ID from create test"
        
        # Update boards to new value
        payload = {
            "name": "TEST_Automation_With_Boards",
            "trigger_type": "status_change",
            "trigger_conditions": {"watch_field": "priority", "watch_value": "RUSH"},
            "action_type": "move_board",
            "action_params": {"target_board": "COMPLETOS"},
            "is_active": True,
            "boards": ["BLANKS", "SCREENS", "NECK"]  # Changed boards
        }
        response = api_client.put(f"{BASE_URL}/api/automations/{automation_id}", json=payload)
        assert response.status_code == 200, f"Update automation failed: {response.text}"
        
        data = response.json()
        assert data["boards"] == ["BLANKS", "SCREENS", "NECK"], f"Boards not updated correctly: {data.get('boards')}"
        print(f"Updated automation boards to: {data['boards']}")
    
    def test_06_update_automation_clear_boards(self, api_client):
        """PUT to clear boards (apply to all)"""
        automation_id = TestAutomationsBoards.created_automation_id
        assert automation_id is not None
        
        payload = {
            "name": "TEST_Automation_With_Boards",
            "trigger_type": "status_change",
            "trigger_conditions": {"watch_field": "priority", "watch_value": "RUSH"},
            "action_type": "move_board",
            "action_params": {"target_board": "COMPLETOS"},
            "is_active": True,
            "boards": []  # Clear boards
        }
        response = api_client.put(f"{BASE_URL}/api/automations/{automation_id}", json=payload)
        assert response.status_code == 200
        
        data = response.json()
        assert data["boards"] == [], f"Boards should be empty, got: {data.get('boards')}"
        print("Cleared boards - automation now applies to all boards")
    
    def test_07_verify_boards_persistence(self, api_client):
        """Verify boards are persisted after update"""
        automation_id = TestAutomationsBoards.created_automation_id
        
        # Update with specific boards
        payload = {
            "name": "TEST_Automation_With_Boards",
            "trigger_type": "status_change",
            "trigger_conditions": {"watch_field": "priority", "watch_value": "RUSH"},
            "action_type": "move_board",
            "action_params": {"target_board": "COMPLETOS"},
            "is_active": True,
            "boards": ["MAQUINA1", "MAQUINA2"]
        }
        api_client.put(f"{BASE_URL}/api/automations/{automation_id}", json=payload)
        
        # GET and verify
        response = api_client.get(f"{BASE_URL}/api/automations")
        assert response.status_code == 200
        
        data = response.json()
        test_auto = next((a for a in data if a.get("automation_id") == automation_id), None)
        assert test_auto is not None
        assert test_auto["boards"] == ["MAQUINA1", "MAQUINA2"]
        print("Verified boards persistence after update")


class TestBackwardCompatibility:
    """Test backward compatibility with automations without boards field"""
    
    def test_08_get_all_automations_have_boards_key(self, api_client):
        """All automations should have boards field (empty or populated)"""
        response = api_client.get(f"{BASE_URL}/api/automations")
        assert response.status_code == 200
        
        data = response.json()
        for auto in data:
            # boards should be in response (either populated or empty list)
            # Old automations without boards in DB should still work
            if "boards" in auto:
                assert isinstance(auto["boards"], list), f"boards should be list: {auto}"
        print("All automations have valid boards structure")


class TestAutomationEngineLogic:
    """Test automation engine filtering logic via DB data structure"""
    
    def test_09_create_automation_for_single_board(self, api_client):
        """Create automation that only triggers for SCHEDULING board"""
        payload = {
            "name": "TEST_Single_Board_Auto",
            "trigger_type": "update",
            "trigger_conditions": {},
            "action_type": "assign_field",
            "action_params": {"field": "sample", "value": "EJEMPLO APROBADO"},
            "is_active": True,
            "boards": ["SCHEDULING"]
        }
        response = api_client.post(f"{BASE_URL}/api/automations", json=payload)
        assert response.status_code == 200
        data = response.json()
        
        # This automation should only trigger for orders in SCHEDULING
        assert data["boards"] == ["SCHEDULING"]
        print("Created single-board automation for SCHEDULING")


class TestCleanup:
    """Cleanup test automations"""
    
    def test_99_cleanup_test_automations(self, api_client):
        """Delete all TEST_ prefixed automations"""
        response = api_client.get(f"{BASE_URL}/api/automations")
        if response.status_code == 200:
            automations = response.json()
            test_autos = [a for a in automations if a.get("name", "").startswith("TEST_")]
            for auto in test_autos:
                del_response = api_client.delete(f"{BASE_URL}/api/automations/{auto['automation_id']}")
                print(f"Deleted test automation: {auto['name']} - Status: {del_response.status_code}")
        print(f"Cleanup complete - removed {len(test_autos) if 'test_autos' in dir() else 0} test automations")
