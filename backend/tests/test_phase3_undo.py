"""
Phase 3 Testing: Activity Log + Undo Functionality
Tests cover:
- POST /api/undo/{activity_id} for various action types
- GET /api/activity with action_filter parameter
- Activity log fields: undoable, undone, previous_data
- Admin-only access control
"""

import pytest
import requests
import os
import time
from datetime import datetime

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

# Admin session token from test setup
ADMIN_SESSION_TOKEN = "test_undo_c3f0af7baf5a"


class TestUndoEndpoint:
    """Tests for POST /api/undo/{activity_id}"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup for each test - create admin session"""
        self.session = requests.Session()
        self.session.cookies.set('session_token', ADMIN_SESSION_TOKEN)
        self.session.headers.update({'Content-Type': 'application/json'})
        
    def test_undo_update_order(self):
        """Test undo of update_order action - restores previous field values"""
        # Step 1: Create a test order
        order_data = {
            "order_number": f"UNDO_TEST_UPDATE_{int(time.time())}",
            "client": "ROSS",
            "priority": "RUSH",
            "quantity": 100
        }
        create_res = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        assert create_res.status_code == 200, f"Failed to create order: {create_res.text}"
        order = create_res.json()
        order_id = order['order_id']
        print(f"Created test order: {order['order_number']}")
        
        # Step 2: Update the order (change client and priority)
        update_data = {"client": "TARGET", "priority": "PRIORITY 1"}
        update_res = self.session.put(f"{BASE_URL}/api/orders/{order_id}", json=update_data)
        assert update_res.status_code == 200, f"Failed to update order: {update_res.text}"
        print("Updated order: client=TARGET, priority=PRIORITY 1")
        
        # Step 3: Get the activity log to find the update_order action
        time.sleep(0.5)
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=update_order&limit=10")
        assert activity_res.status_code == 200, f"Failed to get activity: {activity_res.text}"
        logs = activity_res.json()['logs']
        
        # Find the activity for our order
        activity = None
        for log in logs:
            if log.get('details', {}).get('order_id') == order_id:
                activity = log
                break
        
        assert activity is not None, "Could not find update_order activity for our order"
        assert activity.get('undoable') == True, "Activity should be undoable"
        assert activity.get('undone') == False, "Activity should not be undone yet"
        assert activity.get('previous_data') is not None, "Activity should have previous_data"
        activity_id = activity['activity_id']
        print(f"Found activity: {activity_id}")
        
        # Step 4: Undo the update
        undo_res = self.session.post(f"{BASE_URL}/api/undo/{activity_id}")
        assert undo_res.status_code == 200, f"Failed to undo: {undo_res.text}"
        undo_data = undo_res.json()
        assert undo_data.get('undone_action') == 'update_order', "Should report undone action"
        print("Undo successful")
        
        # Step 5: Verify the order was restored
        get_res = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        assert get_res.status_code == 200
        restored_order = get_res.json()
        assert restored_order['client'] == "ROSS", f"Client should be restored to ROSS, got {restored_order['client']}"
        assert restored_order['priority'] == "RUSH", f"Priority should be restored to RUSH, got {restored_order['priority']}"
        print("Order correctly restored to original values")
        
        # Cleanup: delete test order
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        print("Test passed: undo_update_order")

    def test_undo_delete_order(self):
        """Test undo of delete_order action - restores order from trash to original board"""
        # Step 1: Create a test order
        order_data = {
            "order_number": f"UNDO_TEST_DELETE_{int(time.time())}",
            "client": "SCREENWORKS",
            "priority": "OVERSOLD"
        }
        create_res = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        assert create_res.status_code == 200
        order = create_res.json()
        order_id = order['order_id']
        original_board = order['board']  # Should be SCHEDULING
        print(f"Created order in board: {original_board}")
        
        # Step 2: Delete the order (moves to trash)
        delete_res = self.session.delete(f"{BASE_URL}/api/orders/{order_id}")
        assert delete_res.status_code == 200
        print("Order moved to trash")
        
        # Verify it's in trash
        get_res = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        assert get_res.status_code == 200
        assert get_res.json()['board'] == "PAPELERA DE RECICLAJE"
        
        # Step 3: Get the delete_order activity
        time.sleep(0.5)
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=delete_order&limit=10")
        assert activity_res.status_code == 200
        logs = activity_res.json()['logs']
        
        activity = None
        for log in logs:
            if log.get('details', {}).get('order_id') == order_id:
                activity = log
                break
        
        assert activity is not None
        assert activity.get('undoable') == True
        activity_id = activity['activity_id']
        print(f"Found delete activity: {activity_id}")
        
        # Step 4: Undo the delete
        undo_res = self.session.post(f"{BASE_URL}/api/undo/{activity_id}")
        assert undo_res.status_code == 200
        print("Undo delete successful")
        
        # Step 5: Verify order restored to original board
        get_res = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        assert get_res.status_code == 200
        restored_order = get_res.json()
        assert restored_order['board'] == original_board, f"Should be restored to {original_board}, got {restored_order['board']}"
        print(f"Order restored to {original_board}")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        print("Test passed: undo_delete_order")

    def test_undo_move_order(self):
        """Test undo of move_order action - moves order back to original board"""
        # Step 1: Create a test order
        order_data = {
            "order_number": f"UNDO_TEST_MOVE_{int(time.time())}",
            "client": "Hot Topic"
        }
        create_res = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        assert create_res.status_code == 200
        order = create_res.json()
        order_id = order['order_id']
        original_board = order['board']  # SCHEDULING
        print(f"Created order in: {original_board}")
        
        # Step 2: Move order to another board
        move_res = self.session.post(f"{BASE_URL}/api/orders/{order_id}/move", json={"board": "BLANKS"})
        assert move_res.status_code == 200
        print("Moved order to BLANKS")
        
        # Step 3: Get the move_order activity
        time.sleep(0.5)
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=move_order&limit=10")
        assert activity_res.status_code == 200
        logs = activity_res.json()['logs']
        
        activity = None
        for log in logs:
            if log.get('details', {}).get('order_id') == order_id:
                activity = log
                break
        
        assert activity is not None
        assert activity.get('undoable') == True
        activity_id = activity['activity_id']
        print(f"Found move activity: {activity_id}")
        
        # Step 4: Undo the move
        undo_res = self.session.post(f"{BASE_URL}/api/undo/{activity_id}")
        assert undo_res.status_code == 200
        print("Undo move successful")
        
        # Step 5: Verify order back in original board
        get_res = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        assert get_res.status_code == 200
        restored_order = get_res.json()
        assert restored_order['board'] == original_board
        print(f"Order restored to {original_board}")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        print("Test passed: undo_move_order")

    def test_undo_create_order(self):
        """Test undo of create_order action - moves newly created order to trash"""
        # Step 1: Create a test order
        order_data = {
            "order_number": f"UNDO_TEST_CREATE_{int(time.time())}",
            "client": "Fashion Nova"
        }
        create_res = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        assert create_res.status_code == 200
        order = create_res.json()
        order_id = order['order_id']
        print(f"Created order: {order['order_number']}")
        
        # Step 2: Get the create_order activity
        time.sleep(0.5)
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=create_order&limit=10")
        assert activity_res.status_code == 200
        logs = activity_res.json()['logs']
        
        activity = None
        for log in logs:
            if log.get('details', {}).get('order_id') == order_id:
                activity = log
                break
        
        assert activity is not None
        assert activity.get('undoable') == True
        activity_id = activity['activity_id']
        print(f"Found create activity: {activity_id}")
        
        # Step 3: Undo the create (should move to trash)
        undo_res = self.session.post(f"{BASE_URL}/api/undo/{activity_id}")
        assert undo_res.status_code == 200
        print("Undo create successful")
        
        # Step 4: Verify order is in trash
        get_res = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        assert get_res.status_code == 200
        order_after = get_res.json()
        assert order_after['board'] == "PAPELERA DE RECICLAJE", f"Should be in trash, got {order_after['board']}"
        print("Order moved to trash")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        print("Test passed: undo_create_order")

    def test_undo_bulk_move_orders(self):
        """Test undo of bulk_move_orders action - restores each order to original board"""
        # Step 1: Create multiple test orders
        order_ids = []
        for i in range(2):
            order_data = {
                "order_number": f"UNDO_BULK_{int(time.time())}_{i}",
                "client": "Pacsun"
            }
            create_res = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
            assert create_res.status_code == 200
            order_ids.append(create_res.json()['order_id'])
        print(f"Created {len(order_ids)} test orders")
        
        # Step 2: Bulk move orders to SCREENS
        bulk_res = self.session.post(f"{BASE_URL}/api/orders/bulk-move", json={
            "order_ids": order_ids,
            "board": "SCREENS"
        })
        assert bulk_res.status_code == 200
        print("Bulk moved orders to SCREENS")
        
        # Step 3: Get the bulk_move_orders activity
        time.sleep(0.5)
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=bulk_move_orders&limit=10")
        assert activity_res.status_code == 200
        logs = activity_res.json()['logs']
        
        activity = logs[0] if logs else None  # Most recent bulk move
        assert activity is not None
        assert activity.get('undoable') == True
        activity_id = activity['activity_id']
        print(f"Found bulk move activity: {activity_id}")
        
        # Step 4: Undo the bulk move
        undo_res = self.session.post(f"{BASE_URL}/api/undo/{activity_id}")
        assert undo_res.status_code == 200
        print("Undo bulk move successful")
        
        # Step 5: Verify all orders restored to SCHEDULING
        for oid in order_ids:
            get_res = self.session.get(f"{BASE_URL}/api/orders/{oid}")
            assert get_res.status_code == 200
            assert get_res.json()['board'] == "SCHEDULING", f"Order {oid} should be in SCHEDULING"
        print("All orders restored to SCHEDULING")
        
        # Cleanup
        for oid in order_ids:
            self.session.delete(f"{BASE_URL}/api/orders/{oid}/permanent")
        print("Test passed: undo_bulk_move_orders")

    def test_undo_non_undoable_action_returns_400(self):
        """Test that non-undoable actions return 400 error"""
        # Get a login activity (not undoable)
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=login&limit=5")
        assert activity_res.status_code == 200
        logs = activity_res.json()['logs']
        
        if logs:
            activity_id = logs[0]['activity_id']
            undo_res = self.session.post(f"{BASE_URL}/api/undo/{activity_id}")
            assert undo_res.status_code == 400, "Should return 400 for non-undoable action"
            error = undo_res.json()
            assert "cannot be undone" in error.get('detail', '').lower() or "undoable" in error.get('detail', '').lower()
            print("Correctly rejected non-undoable action")
        else:
            print("No login activities found, skipping test")
        
        print("Test passed: undo_non_undoable_action_returns_400")

    def test_undo_already_undone_returns_400(self):
        """Test that already-undone actions return 400 error"""
        # Create and update an order
        order_data = {"order_number": f"UNDO_TWICE_{int(time.time())}", "client": "ROSS"}
        create_res = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        order = create_res.json()
        order_id = order['order_id']
        
        # Update it
        self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={"client": "TARGET"})
        
        time.sleep(0.5)
        # Get the update activity
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=update_order&limit=10")
        logs = activity_res.json()['logs']
        activity = next((l for l in logs if l.get('details', {}).get('order_id') == order_id), None)
        
        if activity:
            activity_id = activity['activity_id']
            
            # First undo - should succeed
            undo_res1 = self.session.post(f"{BASE_URL}/api/undo/{activity_id}")
            assert undo_res1.status_code == 200
            
            # Second undo - should fail
            undo_res2 = self.session.post(f"{BASE_URL}/api/undo/{activity_id}")
            assert undo_res2.status_code == 400, "Should return 400 for already-undone action"
            error = undo_res2.json()
            assert "already" in error.get('detail', '').lower()
            print("Correctly rejected already-undone action")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        print("Test passed: undo_already_undone_returns_400")

    def test_undo_requires_admin(self):
        """Test that undo endpoint requires admin role"""
        # Create a non-admin session (use a fake/non-existent token)
        non_admin_session = requests.Session()
        non_admin_session.cookies.set('session_token', 'fake_non_admin_token_xyz')
        
        # Try to undo something
        undo_res = non_admin_session.post(f"{BASE_URL}/api/undo/act_fake123")
        assert undo_res.status_code in [401, 403], f"Should return 401 or 403 for non-admin, got {undo_res.status_code}"
        print(f"Correctly rejected non-admin: {undo_res.status_code}")
        print("Test passed: undo_requires_admin")


class TestActivityLogFilter:
    """Tests for GET /api/activity with action_filter"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.session = requests.Session()
        self.session.cookies.set('session_token', ADMIN_SESSION_TOKEN)
        
    def test_activity_filter_by_action_type(self):
        """Test that action_filter query param works correctly"""
        # Test filter by create_order
        res = self.session.get(f"{BASE_URL}/api/activity?action_filter=create_order&limit=5")
        assert res.status_code == 200
        data = res.json()
        logs = data['logs']
        for log in logs:
            assert log['action'] == 'create_order', f"Expected create_order, got {log['action']}"
        print(f"create_order filter working: {len(logs)} logs")
        
        # Test filter by update_order
        res = self.session.get(f"{BASE_URL}/api/activity?action_filter=update_order&limit=5")
        assert res.status_code == 200
        data = res.json()
        logs = data['logs']
        for log in logs:
            assert log['action'] == 'update_order'
        print(f"update_order filter working: {len(logs)} logs")
        
        # Test filter by move_order
        res = self.session.get(f"{BASE_URL}/api/activity?action_filter=move_order&limit=5")
        assert res.status_code == 200
        data = res.json()
        logs = data['logs']
        for log in logs:
            assert log['action'] == 'move_order'
        print(f"move_order filter working: {len(logs)} logs")
        
        print("Test passed: activity_filter_by_action_type")

    def test_activity_without_filter_returns_all(self):
        """Test that no filter returns all action types"""
        res = self.session.get(f"{BASE_URL}/api/activity?limit=50")
        assert res.status_code == 200
        data = res.json()
        logs = data['logs']
        
        # Should have mixed action types
        action_types = set(log['action'] for log in logs)
        print(f"Action types without filter: {action_types}")
        assert len(action_types) >= 1, "Should have at least one action type"
        
        print("Test passed: activity_without_filter_returns_all")


class TestActivityLogFields:
    """Tests for activity log fields: undoable, undone, previous_data"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.session = requests.Session()
        self.session.cookies.set('session_token', ADMIN_SESSION_TOKEN)
        
    def test_create_order_has_undoable_fields(self):
        """Test that create_order logs have undoable=True and previous_data"""
        # Create an order
        order_data = {"order_number": f"FIELD_TEST_{int(time.time())}", "client": "FOCO"}
        create_res = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        assert create_res.status_code == 200
        order_id = create_res.json()['order_id']
        
        time.sleep(0.5)
        # Get activity
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=create_order&limit=10")
        logs = activity_res.json()['logs']
        activity = next((l for l in logs if l.get('details', {}).get('order_id') == order_id), None)
        
        assert activity is not None
        assert 'undoable' in activity, "Should have undoable field"
        assert activity['undoable'] == True, "create_order should be undoable"
        assert 'undone' in activity, "Should have undone field"
        assert activity['undone'] == False, "Should not be undone yet"
        assert 'previous_data' in activity, "Should have previous_data field"
        assert activity['previous_data'] is not None, "previous_data should not be None"
        print(f"create_order activity fields correct: undoable={activity['undoable']}, undone={activity['undone']}")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        print("Test passed: create_order_has_undoable_fields")

    def test_update_order_previous_data_contains_old_values(self):
        """Test that update_order previous_data contains the old field values"""
        # Create order
        order_data = {"order_number": f"PREV_DATA_TEST_{int(time.time())}", "client": "TREVCO", "priority": "RUSH"}
        create_res = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        order_id = create_res.json()['order_id']
        
        # Update order
        self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={"client": "WALLMART", "priority": "EVENT"})
        
        time.sleep(0.5)
        # Get activity
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=update_order&limit=10")
        logs = activity_res.json()['logs']
        activity = next((l for l in logs if l.get('details', {}).get('order_id') == order_id), None)
        
        assert activity is not None
        prev_data = activity.get('previous_data', {})
        fields = prev_data.get('fields', {})
        
        assert 'client' in fields, "previous_data should have client field"
        assert fields['client'] == "TREVCO", f"Old client should be TREVCO, got {fields['client']}"
        assert 'priority' in fields, "previous_data should have priority field"
        assert fields['priority'] == "RUSH", f"Old priority should be RUSH, got {fields['priority']}"
        print(f"previous_data contains correct old values: {fields}")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        print("Test passed: update_order_previous_data_contains_old_values")

    def test_non_undoable_actions_have_undoable_false(self):
        """Test that non-undoable actions have undoable=False"""
        # Login actions are not undoable
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=login&limit=5")
        assert activity_res.status_code == 200
        logs = activity_res.json()['logs']
        
        for log in logs:
            assert log.get('undoable') == False or log.get('undoable') is None, f"Login should not be undoable: {log}"
        print(f"Verified {len(logs)} login activities are not undoable")
        
        print("Test passed: non_undoable_actions_have_undoable_false")


class TestUndoActionCreatesLog:
    """Test that undo itself creates an undo_action log entry"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.session = requests.Session()
        self.session.cookies.set('session_token', ADMIN_SESSION_TOKEN)
        
    def test_undo_creates_undo_action_log(self):
        """Test that performing undo creates a new undo_action activity log"""
        # Create and update an order
        order_data = {"order_number": f"UNDO_LOG_TEST_{int(time.time())}", "client": "Buckle"}
        create_res = self.session.post(f"{BASE_URL}/api/orders", json=order_data)
        order_id = create_res.json()['order_id']
        
        self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={"client": "Tillys"})
        
        time.sleep(0.5)
        # Get and undo the update
        activity_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=update_order&limit=10")
        logs = activity_res.json()['logs']
        activity = next((l for l in logs if l.get('details', {}).get('order_id') == order_id), None)
        
        if activity:
            activity_id = activity['activity_id']
            self.session.post(f"{BASE_URL}/api/undo/{activity_id}")
            
            time.sleep(0.5)
            # Check for undo_action log
            undo_res = self.session.get(f"{BASE_URL}/api/activity?action_filter=undo_action&limit=10")
            assert undo_res.status_code == 200
            undo_logs = undo_res.json()['logs']
            
            # Find the undo log for our activity
            undo_log = next((l for l in undo_logs if l.get('details', {}).get('undone_activity_id') == activity_id), None)
            assert undo_log is not None, "Should create undo_action log entry"
            assert undo_log['action'] == 'undo_action'
            assert undo_log['details']['undone_action'] == 'update_order'
            print(f"undo_action log created correctly: {undo_log['activity_id']}")
        
        # Cleanup
        self.session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        print("Test passed: undo_creates_undo_action_log")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
