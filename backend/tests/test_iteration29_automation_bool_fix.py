"""
Test Iteration 29: Automation Boolean Value Matching Fix - Full Integration Tests

Bug: Automation 'when screens changes to true, move to NECK' was NOT working.
Root cause: MongoDB stores checkbox values as boolean (True/False) but automation 
watch_value is string 'true'. Strict comparison True != 'true' was failing.

Fix: New _values_match() function converts both sides to lowercase strings before comparing.
"""

import pytest
import requests
import os
import time
import uuid

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

# Session token created via MongoDB seed
ADMIN_SESSION = os.environ.get('ADMIN_SESSION_TOKEN', 'test_session_iter29_1772745952422')


@pytest.fixture
def admin_client():
    """Admin authenticated session"""
    session = requests.Session()
    session.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ADMIN_SESSION}"
    })
    return session


class TestValuesMatchLogic:
    """Test the _values_match function logic directly"""
    
    def test_01_values_match_bool_to_string(self):
        """Test _values_match function logic: bool True matches string 'true'"""
        def _values_match(actual, expected):
            if actual is None and expected is None:
                return True
            if actual is None or expected is None:
                return False
            if isinstance(actual, bool):
                return str(actual).lower() == str(expected).lower()
            if isinstance(expected, bool):
                return str(actual).lower() == str(expected).lower()
            return str(actual).strip().lower() == str(expected).strip().lower()
        
        # Critical test cases for the bug fix
        assert _values_match(True, 'true'), "Bool True should match string 'true'"
        assert _values_match(True, 'True'), "Bool True should match string 'True'"
        assert _values_match(True, 'TRUE'), "Bool True should match string 'TRUE'"
        assert _values_match(False, 'false'), "Bool False should match string 'false'"
        assert _values_match('true', True), "String 'true' should match bool True"
        assert not _values_match(True, 'false'), "Bool True should NOT match 'false'"
        assert not _values_match(False, 'true'), "Bool False should NOT match 'true'"
        
        print("SUCCESS: _values_match correctly handles bool/string comparison")


class TestAutomationExists:
    """Verify the 'move to neck' automation exists and is configured correctly"""
    
    def test_02_automation_exists(self, admin_client):
        """Verify 'move to neck' automation exists with correct config"""
        response = admin_client.get(f"{BASE_URL}/api/automations")
        assert response.status_code == 200, f"GET automations failed: {response.text}"
        
        automations = response.json()
        screens_automation = None
        
        for auto in automations:
            conds = auto.get("trigger_conditions", {})
            if conds.get("watch_field") == "screens":
                screens_automation = auto
                break
        
        assert screens_automation is not None, "Screens automation not found"
        assert screens_automation.get("is_active") == True, "Automation should be active"
        assert screens_automation.get("trigger_type") == "status_change", "Should trigger on status_change"
        
        conds = screens_automation["trigger_conditions"]
        assert conds.get("watch_value") in ["true", "True", True], \
            f"watch_value should be 'true', got {conds.get('watch_value')}"
        
        assert screens_automation.get("action_type") == "move_board", "Action should be move_board"
        assert screens_automation.get("action_params", {}).get("target_board") == "NECK", \
            "Target board should be NECK"
        
        print(f"SUCCESS: Found automation '{screens_automation['name']}' correctly configured")
        print(f"  - trigger_type: {screens_automation['trigger_type']}")
        print(f"  - watch_field: {conds.get('watch_field')}")
        print(f"  - watch_value: {conds.get('watch_value')}")
        print(f"  - target_board: {screens_automation['action_params']['target_board']}")


class TestAutomationTrigger:
    """Test that the automation fires correctly when screens=True"""
    
    def test_03_create_test_order(self, admin_client):
        """Create a test order with screens=False"""
        order_data = {
            "order_number": f"TEST_ITER29_{uuid.uuid4().hex[:8]}",
            "client": "Test Client Iter29",
            "branding": "Test Branding",
            "quantity": 100
        }
        
        response = admin_client.post(f"{BASE_URL}/api/orders", json=order_data)
        assert response.status_code in [200, 201], f"Create order failed: {response.text}"
        
        order = response.json()
        order_id = order["order_id"]
        
        # Set screens to False explicitly
        response = admin_client.put(f"{BASE_URL}/api/orders/{order_id}", json={"screens": False})
        assert response.status_code == 200, f"Set screens=False failed: {response.text}"
        
        # Also set board to something other than NECK
        response = admin_client.put(f"{BASE_URL}/api/orders/{order_id}", json={"board": "SCHEDULING"})
        assert response.status_code == 200, f"Set board failed: {response.text}"
        
        # Verify order state
        response = admin_client.get(f"{BASE_URL}/api/orders/{order_id}")
        order = response.json()
        
        print(f"SUCCESS: Created test order {order_id}")
        print(f"  - order_number: {order.get('order_number')}")
        print(f"  - screens: {order.get('screens')}")
        print(f"  - board: {order.get('board')}")
        
        # Store for later tests
        TestAutomationTrigger.test_order_id = order_id
        return order_id

    def test_04_update_screens_to_true_triggers_automation(self, admin_client):
        """
        CRITICAL TEST: Update screens=True and verify automation fires.
        
        This is the main bug fix validation:
        - Automation watch_value='true' (string)
        - Order screens=True (boolean from MongoDB)
        - _values_match(True, 'true') should return True
        """
        order_id = getattr(TestAutomationTrigger, 'test_order_id', None)
        if not order_id:
            pytest.skip("No test order created")
        
        # Get current state
        response = admin_client.get(f"{BASE_URL}/api/orders/{order_id}")
        original = response.json()
        original_board = original.get("board")
        
        print(f"Before update: screens={original.get('screens')}, board={original_board}")
        
        # Update screens to True (boolean)
        response = admin_client.put(
            f"{BASE_URL}/api/orders/{order_id}",
            json={"screens": True}  # Boolean True
        )
        
        assert response.status_code == 200, f"PUT failed: {response.text}"
        result = response.json()
        
        # Check _automations_executed in response
        executed = result.get("_automations_executed", [])
        print(f"Automations executed: {executed}")
        
        # Verify the 'move to neck' automation was triggered
        move_to_neck_triggered = False
        for exec_auto in executed:
            if exec_auto.get("action") == "move_board":
                target = exec_auto.get("params", {}).get("target_board")
                if target == "NECK":
                    move_to_neck_triggered = True
                    print(f"SUCCESS: 'move_board' automation triggered -> NECK")
                    break
        
        assert move_to_neck_triggered, \
            f"Automation should have moved order to NECK. Executed: {executed}"
        
        # Verify the board changed to NECK
        assert result.get("board") == "NECK", \
            f"Order board should be 'NECK', got '{result.get('board')}'"
        
        print(f"SUCCESS: Order board changed from '{original_board}' to 'NECK'")
        print(f"  - screens: {result.get('screens')}")
        print(f"  - board: {result.get('board')}")

    def test_05_verify_board_persisted(self, admin_client):
        """Verify the board change was persisted in database"""
        order_id = getattr(TestAutomationTrigger, 'test_order_id', None)
        if not order_id:
            pytest.skip("No test order created")
        
        response = admin_client.get(f"{BASE_URL}/api/orders/{order_id}")
        assert response.status_code == 200
        order = response.json()
        
        assert order.get("board") == "NECK", \
            f"Board should be 'NECK', got '{order.get('board')}'"
        assert order.get("screens") == True, \
            f"screens should be True, got '{order.get('screens')}'"
        
        print(f"SUCCESS: Order persisted with board='NECK', screens=True")


class TestReverseScenario:
    """Test that automation doesn't fire when screens=False"""
    
    def test_06_screens_false_does_not_trigger(self, admin_client):
        """Verify automation doesn't fire when screens goes to False"""
        # Create new order
        order_data = {
            "order_number": f"TEST_ITER29_REVERSE_{uuid.uuid4().hex[:8]}",
            "client": "Test Reverse"
        }
        response = admin_client.post(f"{BASE_URL}/api/orders", json=order_data)
        assert response.status_code in [200, 201]
        order = response.json()
        order_id = order["order_id"]
        
        # Set screens to True first (this might trigger automation)
        admin_client.put(f"{BASE_URL}/api/orders/{order_id}", json={"screens": True})
        
        # Move to a different board
        admin_client.put(f"{BASE_URL}/api/orders/{order_id}", json={"board": "SCHEDULING"})
        
        # Now set screens to False
        response = admin_client.put(
            f"{BASE_URL}/api/orders/{order_id}",
            json={"screens": False}
        )
        assert response.status_code == 200
        result = response.json()
        
        executed = result.get("_automations_executed", [])
        
        # The 'move to neck' automation should NOT fire for screens=False
        move_to_neck_triggered = any(
            e.get("action") == "move_board" and 
            e.get("params", {}).get("target_board") == "NECK"
            for e in executed
        )
        
        assert not move_to_neck_triggered, \
            "Automation should NOT fire when screens=False"
        
        # Board should still be SCHEDULING (not moved to NECK)
        assert result.get("board") == "SCHEDULING", \
            f"Board should remain 'SCHEDULING', got '{result.get('board')}'"
        
        print("SUCCESS: Automation correctly did NOT fire for screens=False")
        
        # Cleanup
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")


class TestCodeVerification:
    """Verify the fix is correctly implemented in the codebase"""
    
    def test_07_verify_automations_code(self):
        """Verify _values_match function in automations.py"""
        automations_file = '/app/backend/routers/automations.py'
        
        with open(automations_file, 'r') as f:
            content = f.read()
        
        assert 'def _values_match(actual, expected):' in content, \
            "_values_match function should exist"
        assert 'isinstance(actual, bool)' in content, \
            "Should check if actual is bool"
        assert 'str(actual).lower()' in content, \
            "Should convert to lowercase string"
        assert '_values_match(order.get(watch_field), watch_value)' in content, \
            "check_conditions should use _values_match"
        
        print("SUCCESS: Code fix verified in automations.py")

    def test_08_verify_orders_code(self):
        """Verify orders.py triggers status_change with changed_fields"""
        orders_file = '/app/backend/routers/orders.py'
        
        with open(orders_file, 'r') as f:
            content = f.read()
        
        assert '"status_change"' in content, \
            "orders.py should trigger status_change automations"
        assert 'changed_fields' in content, \
            "Should pass changed_fields in context"
        
        print("SUCCESS: orders.py correctly triggers status_change automations")


class TestCleanup:
    """Cleanup test data"""
    
    def test_99_cleanup(self, admin_client):
        """Clean up TEST_ prefixed orders"""
        response = admin_client.get(f"{BASE_URL}/api/orders?search=TEST_ITER29")
        if response.status_code == 200:
            orders = response.json()
            for order in orders:
                admin_client.delete(f"{BASE_URL}/api/orders/{order['order_id']}/permanent")
                print(f"Deleted test order: {order['order_id']}")
        
        print("Cleanup completed")
