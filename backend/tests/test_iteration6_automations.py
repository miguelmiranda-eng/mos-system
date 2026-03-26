"""
Iteration 6 Tests: Automation Real-time Feedback + Dashboard Analytics
- Backend: PUT /api/orders/{id} returns '_automations_executed' array and final state
- Backend: run_automations() returns executed automation details
- Backend: status_change trigger fires correctly when field value changes
- Dashboard: AnalyticsView shows Total Piezas, Piezas por Tablero, Piezas por Estado
"""

import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({
        "Content-Type": "application/json",
        "Cookie": "session_token=test_session_1772136570038"
    })
    return s

# ============== AUTOMATION TESTS ==============

class TestAutomationRealtime:
    """Tests for real-time automation feedback in PUT /api/orders/{id}"""
    
    def test_create_test_automation_for_status_change(self, session):
        """Create automation: when production_status changes to EN PRODUCCION, move to MAQUINA1"""
        automation_data = {
            "name": "TEST_AutoMove_To_MAQUINA1",
            "trigger_type": "status_change",
            "trigger_conditions": {
                "production_status": "EN PRODUCCION"
            },
            "action_type": "move_board",
            "action_params": {
                "target_board": "MAQUINA1"
            },
            "is_active": True
        }
        
        res = session.post(f"{BASE_URL}/api/automations", json=automation_data)
        assert res.status_code in [200, 201], f"Failed to create automation: {res.text}"
        
        data = res.json()
        assert "automation_id" in data
        assert data["name"] == "TEST_AutoMove_To_MAQUINA1"
        assert data["trigger_type"] == "status_change"
        assert data["action_type"] == "move_board"
        
        # Store for cleanup
        TestAutomationRealtime.automation_id = data["automation_id"]
        print(f"✓ Created test automation: {data['automation_id']}")
    
    def test_create_test_order_for_automation(self, session):
        """Create a test order in SCHEDULING board"""
        order_data = {
            "order_number": f"TEST_AUTORUN_{int(time.time())}",
            "client": "TEST_CLIENT",
            "quantity": 150,
            "production_status": "EN ESPERA"
        }
        
        res = session.post(f"{BASE_URL}/api/orders", json=order_data)
        assert res.status_code in [200, 201], f"Failed to create order: {res.text}"
        
        data = res.json()
        assert "order_id" in data
        assert data["board"] == "SCHEDULING"  # New orders go to SCHEDULING
        assert data["production_status"] == "EN ESPERA"
        
        TestAutomationRealtime.test_order_id = data["order_id"]
        TestAutomationRealtime.test_order_number = data["order_number"]
        print(f"✓ Created test order: {data['order_id']} with board={data['board']}")
    
    def test_update_triggers_automation_returns_executed_array(self, session):
        """When updating production_status to trigger value, response should include _automations_executed"""
        order_id = TestAutomationRealtime.test_order_id
        
        # Update production_status to trigger the automation
        update_data = {
            "production_status": "EN PRODUCCION"
        }
        
        res = session.put(f"{BASE_URL}/api/orders/{order_id}", json=update_data)
        assert res.status_code == 200, f"Failed to update order: {res.text}"
        
        data = res.json()
        
        # Key assertion: response should contain _automations_executed
        assert "_automations_executed" in data, "Response missing _automations_executed array"
        automations = data["_automations_executed"]
        
        # Should have at least one executed automation
        assert len(automations) >= 1, f"Expected at least 1 automation executed, got {len(automations)}"
        
        # Verify automation details
        executed = automations[0]
        assert "name" in executed
        assert "action" in executed
        assert executed["name"] == "TEST_AutoMove_To_MAQUINA1"
        assert executed["action"] == "move_board"
        
        print(f"✓ Automation executed: {executed['name']} (action: {executed['action']})")
    
    def test_order_moved_to_target_board_after_automation(self, session):
        """Verify the order was actually moved to MAQUINA1 by the automation"""
        order_id = TestAutomationRealtime.test_order_id
        
        res = session.get(f"{BASE_URL}/api/orders/{order_id}")
        assert res.status_code == 200
        
        data = res.json()
        
        # The automation should have moved the order to MAQUINA1
        assert data["board"] == "MAQUINA1", f"Expected board=MAQUINA1, got {data['board']}"
        assert data["production_status"] == "EN PRODUCCION"
        
        print(f"✓ Order board changed to: {data['board']} (as expected)")
    
    def test_final_order_state_returned_in_response(self, session):
        """PUT response should return the FINAL state after automation changed it"""
        order_id = TestAutomationRealtime.test_order_id
        
        # Reset order to test again
        session.put(f"{BASE_URL}/api/orders/{order_id}", json={"board": "SCHEDULING", "production_status": "LABEL LISTO"})
        
        # Now trigger automation again
        res = session.put(f"{BASE_URL}/api/orders/{order_id}", json={"production_status": "EN PRODUCCION"})
        assert res.status_code == 200
        
        data = res.json()
        
        # Response should show FINAL board state (MAQUINA1), not original (SCHEDULING)
        assert data["board"] == "MAQUINA1", f"Expected final board=MAQUINA1 in response, got {data['board']}"
        print(f"✓ Response contains final state: board={data['board']}")
    
    def test_no_automations_when_condition_not_met(self, session):
        """When updating a field that doesn't trigger automation, _automations_executed should be empty"""
        order_id = TestAutomationRealtime.test_order_id
        
        # Update a field that doesn't trigger the automation
        res = session.put(f"{BASE_URL}/api/orders/{order_id}", json={"notes": "Test notes update"})
        assert res.status_code == 200
        
        data = res.json()
        
        # Should still have _automations_executed key but empty
        assert "_automations_executed" in data
        automations = data["_automations_executed"]
        assert len(automations) == 0, f"Expected 0 automations for notes update, got {len(automations)}"
        
        print(f"✓ No automations triggered for non-matching update (as expected)")
    
    def test_cleanup_test_automation(self, session):
        """Delete test automation"""
        automation_id = TestAutomationRealtime.automation_id
        
        res = session.delete(f"{BASE_URL}/api/automations/{automation_id}")
        assert res.status_code == 200
        print(f"✓ Cleaned up test automation: {automation_id}")
    
    def test_cleanup_test_order(self, session):
        """Delete test order permanently"""
        order_id = TestAutomationRealtime.test_order_id
        
        res = session.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        assert res.status_code == 200
        print(f"✓ Cleaned up test order: {order_id}")


class TestAssignFieldAutomation:
    """Tests for assign_field action type in automations"""
    
    def test_create_assign_field_automation(self, session):
        """Create automation: when blank_status changes to CONTADO/PICKED, set trim_status to COMPLETE TRIM"""
        automation_data = {
            "name": "TEST_AutoAssign_TrimStatus",
            "trigger_type": "status_change",
            "trigger_conditions": {
                "blank_status": "CONTADO/PICKED"
            },
            "action_type": "assign_field",
            "action_params": {
                "field": "trim_status",
                "value": "COMPLETE TRIM"
            },
            "is_active": True
        }
        
        res = session.post(f"{BASE_URL}/api/automations", json=automation_data)
        assert res.status_code in [200, 201]
        
        data = res.json()
        TestAssignFieldAutomation.automation_id = data["automation_id"]
        print(f"✓ Created assign_field automation: {data['automation_id']}")
    
    def test_assign_field_automation_triggers(self, session):
        """Test that assign_field automation works and returns in _automations_executed"""
        # Create test order
        order_res = session.post(f"{BASE_URL}/api/orders", json={
            "order_number": f"TEST_ASSIGN_{int(time.time())}",
            "client": "TEST",
            "quantity": 50,
            "blank_status": "PENDIENTE",
            "trim_status": "NEEDS TRIM"
        })
        assert order_res.status_code in [200, 201]
        order = order_res.json()
        TestAssignFieldAutomation.test_order_id = order["order_id"]
        
        # Trigger automation
        update_res = session.put(f"{BASE_URL}/api/orders/{order['order_id']}", json={
            "blank_status": "CONTADO/PICKED"
        })
        assert update_res.status_code == 200
        
        data = update_res.json()
        assert "_automations_executed" in data
        
        # Verify automation ran
        automations = data["_automations_executed"]
        assert len(automations) >= 1
        
        # Verify the field was assigned
        assert data["trim_status"] == "COMPLETE TRIM", f"Expected trim_status=COMPLETE TRIM, got {data['trim_status']}"
        print(f"✓ assign_field automation worked: trim_status={data['trim_status']}")
    
    def test_cleanup_assign_field_test_data(self, session):
        """Cleanup test data"""
        session.delete(f"{BASE_URL}/api/automations/{TestAssignFieldAutomation.automation_id}")
        session.delete(f"{BASE_URL}/api/orders/{TestAssignFieldAutomation.test_order_id}/permanent")
        print("✓ Cleaned up assign_field test data")


class TestAnalyticsData:
    """Tests for analytics/dashboard data - specifically pieces (quantity) aggregation"""
    
    def test_orders_have_quantity_field(self, session):
        """Verify orders have quantity field for pieces calculation"""
        res = session.get(f"{BASE_URL}/api/orders")
        assert res.status_code == 200
        
        orders = res.json()
        assert len(orders) > 0, "Need at least one order for test"
        
        # Check that quantity field exists
        for order in orders[:5]:
            assert "quantity" in order, f"Order {order.get('order_id')} missing quantity field"
            assert isinstance(order["quantity"], (int, float, type(None))), "quantity should be numeric or null"
        
        # Calculate total pieces
        total_pieces = sum(int(o.get("quantity") or 0) for o in orders)
        print(f"✓ Found {len(orders)} orders with total pieces: {total_pieces}")
    
    def test_orders_by_board_for_analytics(self, session):
        """Verify orders can be grouped by board for analytics"""
        res = session.get(f"{BASE_URL}/api/orders")
        assert res.status_code == 200
        
        orders = res.json()
        
        # Group by board
        by_board = {}
        for o in orders:
            board = o.get("board", "Unknown")
            qty = int(o.get("quantity") or 0)
            by_board[board] = by_board.get(board, 0) + qty
        
        print(f"✓ Pieces by board: {by_board}")
        assert len(by_board) > 0, "Should have at least one board with orders"
    
    def test_orders_by_production_status_for_analytics(self, session):
        """Verify orders can be grouped by production_status for analytics"""
        res = session.get(f"{BASE_URL}/api/orders")
        assert res.status_code == 200
        
        orders = res.json()
        
        # Group by production_status
        by_status = {}
        for o in orders:
            status = o.get("production_status") or "Sin estado"
            qty = int(o.get("quantity") or 0)
            by_status[status] = by_status.get(status, 0) + qty
        
        print(f"✓ Pieces by production status: {by_status}")
        assert len(by_status) > 0, "Should have at least one status with orders"


# ============== RUN TESTS ==============
if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
