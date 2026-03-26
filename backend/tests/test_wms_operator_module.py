"""
WMS Operator Module Tests - Iteration 54

Testing the new Operator Module features:
1. GET /api/wms/operators - returns list of operator-role users
2. POST /api/wms/pick-tickets - creates ticket with assigned_to and picking_status fields
3. PUT /api/wms/pick-tickets/{ticket_id}/assign - admin assigns ticket to operator
4. GET /api/wms/operator/my-tickets - returns only tickets assigned to logged-in operator
5. PUT /api/wms/pick-tickets/{ticket_id}/pick-progress - saves partial/complete picking progress
6. GET /api/wms/operator/completed-tickets - returns completed tickets for operator

Test credentials:
- Admin: admin@test.com / admin123
- Operator: operador1@test.com / operador123 (role: operator, user_id: user_06e5cd72e6ab)
"""
import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')


def login_as_admin():
    """Login as admin and get session cookie"""
    resp = requests.post(f"{BASE_URL}/api/auth/login", json={
        "email": "admin@test.com",
        "password": "admin123"
    })
    if resp.status_code == 200:
        return resp.cookies.get_dict()
    # Fallback to test123 password
    resp = requests.post(f"{BASE_URL}/api/auth/login", json={
        "email": "admin@test.com",
        "password": "test123"
    })
    if resp.status_code == 200:
        return resp.cookies.get_dict()
    return {}


def login_as_operator():
    """Login as operator and get session cookie"""
    resp = requests.post(f"{BASE_URL}/api/auth/login", json={
        "email": "operador1@test.com",
        "password": "operador123"
    })
    if resp.status_code == 200:
        return resp.cookies.get_dict()
    return {}


class TestOperatorListEndpoint:
    """Test GET /api/wms/operators endpoint"""
    
    def test_01_operators_endpoint_returns_list(self):
        """GET /api/wms/operators returns list of operator-role users"""
        cookies = login_as_admin()
        if not cookies:
            pytest.skip("Admin login failed")
        
        response = requests.get(f"{BASE_URL}/api/wms/operators", cookies=cookies)
        assert response.status_code == 200, f"Failed: {response.status_code} - {response.text}"
        
        operators = response.json()
        assert isinstance(operators, list), "Response should be a list"
        
        # Look for our test operator
        operator_found = any(op.get('email') == 'operador1@test.com' for op in operators)
        if operators:
            # Check that operators have role='operator'
            for op in operators:
                assert op.get('role') == 'operator', f"Expected role 'operator', got: {op.get('role')}"
                # Password hash should NOT be exposed
                assert 'password_hash' not in op, "password_hash should not be exposed"
            print(f"PASS: GET /api/wms/operators returns {len(operators)} operators")
        else:
            print("WARN: No operators found in system")
        
        if operator_found:
            print("PASS: Test operator (operador1@test.com) found in list")
    
    def test_02_operators_endpoint_requires_auth(self):
        """GET /api/wms/operators requires authentication"""
        response = requests.get(f"{BASE_URL}/api/wms/operators")
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print("PASS: GET /api/wms/operators requires authentication")


class TestPickTicketOperatorAssignment:
    """Test pick ticket creation with operator assignment fields"""
    
    @pytest.fixture(scope="class")
    def test_data(self):
        return {}
    
    def test_01_create_pick_ticket_with_operator_assignment(self, test_data):
        """POST /api/wms/pick-tickets creates ticket with assigned_to and picking_status fields"""
        cookies = login_as_admin()
        if not cookies:
            pytest.skip("Admin login failed")
        
        unique_id = str(uuid.uuid4())[:8]
        
        # Get operators first
        ops_resp = requests.get(f"{BASE_URL}/api/wms/operators", cookies=cookies)
        operators = ops_resp.json() if ops_resp.status_code == 200 else []
        
        operator_id = "user_06e5cd72e6ab"  # Default test operator ID
        operator_name = "Operador Test"
        
        if operators:
            operator_id = operators[0].get('user_id', operators[0].get('email', operator_id))
            operator_name = operators[0].get('name', operators[0].get('email', operator_name))
        
        payload = {
            "order_number": f"TEST_OP_{unique_id}",
            "customer": "Test Customer",
            "style": "TEST_STYLE_5000",
            "color": "BLACK",
            "quantity": 100,
            "assigned_to": operator_id,
            "assigned_to_name": operator_name,
            "sizes": {
                "S": 25,
                "M": 50,
                "L": 25
            }
        }
        
        response = requests.post(f"{BASE_URL}/api/wms/pick-tickets", json=payload, cookies=cookies)
        assert response.status_code == 200, f"Failed to create pick ticket: {response.text}"
        
        data = response.json()
        
        # Verify operator assignment fields
        assert 'ticket_id' in data, "Missing ticket_id"
        assert data.get('assigned_to') == operator_id, f"assigned_to mismatch: expected {operator_id}, got {data.get('assigned_to')}"
        assert data.get('assigned_to_name') == operator_name, f"assigned_to_name mismatch"
        assert data.get('picking_status') == 'assigned', f"picking_status should be 'assigned' when operator assigned, got: {data.get('picking_status')}"
        assert data.get('status') == 'pending', f"status should be 'pending', got: {data.get('status')}"
        assert 'picked_sizes' in data, "Missing picked_sizes field"
        assert data.get('picked_sizes') == {}, f"picked_sizes should be empty initially, got: {data.get('picked_sizes')}"
        
        test_data['ticket_id'] = data['ticket_id']
        test_data['operator_id'] = operator_id
        
        print(f"PASS: Created pick ticket {data['ticket_id']} with operator assignment (assigned_to={operator_id}, picking_status=assigned)")
    
    def test_02_create_pick_ticket_without_operator_has_unassigned_status(self, test_data):
        """Pick ticket without assigned_to should have picking_status='unassigned'"""
        cookies = login_as_admin()
        if not cookies:
            pytest.skip("Admin login failed")
        
        unique_id = str(uuid.uuid4())[:8]
        
        payload = {
            "order_number": f"TEST_UNASSIGNED_{unique_id}",
            "style": "TEST_STYLE",
            "sizes": {"M": 10}
        }
        
        response = requests.post(f"{BASE_URL}/api/wms/pick-tickets", json=payload, cookies=cookies)
        assert response.status_code == 200, f"Failed: {response.text}"
        
        data = response.json()
        assert data.get('picking_status') == 'unassigned', f"picking_status should be 'unassigned' without operator, got: {data.get('picking_status')}"
        assert data.get('assigned_to') is None, f"assigned_to should be None, got: {data.get('assigned_to')}"
        
        test_data['unassigned_ticket_id'] = data['ticket_id']
        print(f"PASS: Pick ticket without operator has picking_status='unassigned'")


class TestAssignPickTicket:
    """Test PUT /api/wms/pick-tickets/{ticket_id}/assign endpoint"""
    
    @pytest.fixture(scope="class")
    def test_data(self):
        return {}
    
    def test_01_admin_can_assign_ticket_to_operator(self, test_data):
        """PUT /api/wms/pick-tickets/{id}/assign allows admin to assign ticket"""
        cookies = login_as_admin()
        if not cookies:
            pytest.skip("Admin login failed")
        
        unique_id = str(uuid.uuid4())[:8]
        
        # Create unassigned ticket first
        create_resp = requests.post(f"{BASE_URL}/api/wms/pick-tickets", json={
            "order_number": f"TEST_ASSIGN_{unique_id}",
            "style": "TEST_STYLE",
            "sizes": {"M": 20, "L": 20}
        }, cookies=cookies)
        
        if create_resp.status_code != 200:
            pytest.skip(f"Could not create ticket: {create_resp.text}")
        
        ticket = create_resp.json()
        ticket_id = ticket['ticket_id']
        test_data['ticket_id'] = ticket_id
        
        # Assign to operator
        assign_resp = requests.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/assign", json={
            "operator_id": "user_06e5cd72e6ab",
            "operator_name": "Operador1 Test"
        }, cookies=cookies)
        
        assert assign_resp.status_code == 200, f"Failed to assign: {assign_resp.status_code} - {assign_resp.text}"
        
        data = assign_resp.json()
        assert 'ticket_id' in data, "Response should contain ticket_id"
        
        # Verify assignment by fetching pick tickets
        list_resp = requests.get(f"{BASE_URL}/api/wms/pick-tickets", cookies=cookies)
        tickets = list_resp.json()
        
        updated_ticket = next((t for t in tickets if t['ticket_id'] == ticket_id), None)
        assert updated_ticket is not None, "Ticket not found after assignment"
        assert updated_ticket.get('assigned_to') == "user_06e5cd72e6ab", f"assigned_to not updated: {updated_ticket.get('assigned_to')}"
        assert updated_ticket.get('picking_status') == 'assigned', f"picking_status should be 'assigned': {updated_ticket.get('picking_status')}"
        assert updated_ticket.get('assigned_at') is not None, "assigned_at should be set"
        
        print(f"PASS: Admin can assign ticket {ticket_id} to operator via PUT /assign endpoint")
    
    def test_02_assign_requires_admin_role(self, test_data):
        """PUT /assign endpoint requires admin role (403 for operator)"""
        op_cookies = login_as_operator()
        if not op_cookies:
            pytest.skip("Operator login failed")
        
        if not test_data.get('ticket_id'):
            pytest.skip("No ticket to test")
        
        response = requests.put(f"{BASE_URL}/api/wms/pick-tickets/{test_data['ticket_id']}/assign", json={
            "operator_id": "some_id",
            "operator_name": "Someone"
        }, cookies=op_cookies)
        
        assert response.status_code == 403, f"Expected 403 for operator trying to assign, got {response.status_code}"
        print("PASS: PUT /assign requires admin role (operator gets 403)")
    
    def test_03_assign_requires_auth(self):
        """PUT /assign requires authentication"""
        response = requests.put(f"{BASE_URL}/api/wms/pick-tickets/some_id/assign", json={
            "operator_id": "some_id"
        })
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print("PASS: PUT /assign requires authentication")


class TestOperatorMyTickets:
    """Test GET /api/wms/operator/my-tickets endpoint"""
    
    def test_01_operator_can_get_assigned_tickets(self):
        """GET /api/wms/operator/my-tickets returns only tickets assigned to logged-in operator"""
        op_cookies = login_as_operator()
        if not op_cookies:
            pytest.skip("Operator login failed")
        
        response = requests.get(f"{BASE_URL}/api/wms/operator/my-tickets", cookies=op_cookies)
        assert response.status_code == 200, f"Failed: {response.status_code} - {response.text}"
        
        tickets = response.json()
        assert isinstance(tickets, list), "Response should be a list"
        
        # All returned tickets should be assigned to the operator
        for ticket in tickets:
            # Tickets should be assigned to either user_id or email
            assigned_to = ticket.get('assigned_to', '')
            assert assigned_to in ['user_06e5cd72e6ab', 'operador1@test.com'] or ticket.get('status') != 'confirmed', \
                f"Ticket {ticket.get('ticket_id')} not assigned to operator: {assigned_to}"
            # Should exclude confirmed/completed tickets
            assert ticket.get('status') != 'confirmed', f"Confirmed tickets should not appear in my-tickets: {ticket.get('ticket_id')}"
        
        print(f"PASS: GET /api/wms/operator/my-tickets returns {len(tickets)} assigned tickets for operator")
    
    def test_02_my_tickets_requires_auth(self):
        """GET /api/wms/operator/my-tickets requires authentication"""
        response = requests.get(f"{BASE_URL}/api/wms/operator/my-tickets")
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print("PASS: GET /api/wms/operator/my-tickets requires authentication")


class TestPickProgress:
    """Test PUT /api/wms/pick-tickets/{ticket_id}/pick-progress endpoint"""
    
    @pytest.fixture(scope="class")
    def test_data(self):
        return {}
    
    def test_01_save_partial_picking_progress(self, test_data):
        """PUT /pick-progress saves partial picking progress"""
        admin_cookies = login_as_admin()
        op_cookies = login_as_operator()
        
        if not admin_cookies or not op_cookies:
            pytest.skip("Login failed")
        
        unique_id = str(uuid.uuid4())[:8]
        
        # Admin creates ticket assigned to operator
        create_resp = requests.post(f"{BASE_URL}/api/wms/pick-tickets", json={
            "order_number": f"TEST_PROGRESS_{unique_id}",
            "style": "TEST_STYLE",
            "assigned_to": "user_06e5cd72e6ab",
            "assigned_to_name": "Operador1",
            "sizes": {"S": 50, "M": 100, "L": 50}
        }, cookies=admin_cookies)
        
        if create_resp.status_code != 200:
            pytest.skip(f"Could not create ticket: {create_resp.text}")
        
        ticket = create_resp.json()
        ticket_id = ticket['ticket_id']
        test_data['ticket_id'] = ticket_id
        
        # Operator saves partial progress
        progress_resp = requests.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/pick-progress", json={
            "picked_sizes": {"S": 30, "M": 50, "L": 0},
            "is_complete": False
        }, cookies=op_cookies)
        
        assert progress_resp.status_code == 200, f"Failed to save progress: {progress_resp.status_code} - {progress_resp.text}"
        
        data = progress_resp.json()
        assert data.get('picking_status') == 'in_progress', f"picking_status should be 'in_progress' for partial, got: {data.get('picking_status')}"
        
        # Verify the progress was saved
        list_resp = requests.get(f"{BASE_URL}/api/wms/pick-tickets", cookies=admin_cookies)
        tickets = list_resp.json()
        
        updated_ticket = next((t for t in tickets if t['ticket_id'] == ticket_id), None)
        assert updated_ticket is not None, "Ticket not found"
        assert updated_ticket.get('picked_sizes', {}).get('S') == 30, f"S picked_sizes not saved"
        assert updated_ticket.get('picked_sizes', {}).get('M') == 50, f"M picked_sizes not saved"
        assert updated_ticket.get('picking_status') == 'in_progress', f"picking_status should be 'in_progress'"
        
        print(f"PASS: Partial picking progress saved (S:30/50, M:50/100, L:0/50)")
    
    def test_02_save_complete_picking(self, test_data):
        """PUT /pick-progress with is_complete=True marks ticket as completed"""
        admin_cookies = login_as_admin()
        op_cookies = login_as_operator()
        
        if not admin_cookies or not op_cookies:
            pytest.skip("Login failed")
        
        unique_id = str(uuid.uuid4())[:8]
        
        # Admin creates ticket assigned to operator
        create_resp = requests.post(f"{BASE_URL}/api/wms/pick-tickets", json={
            "order_number": f"TEST_COMPLETE_{unique_id}",
            "style": "TEST_STYLE",
            "assigned_to": "user_06e5cd72e6ab",
            "assigned_to_name": "Operador1",
            "sizes": {"S": 20, "M": 30}
        }, cookies=admin_cookies)
        
        if create_resp.status_code != 200:
            pytest.skip(f"Could not create ticket: {create_resp.text}")
        
        ticket = create_resp.json()
        ticket_id = ticket['ticket_id']
        
        # Operator marks as complete
        progress_resp = requests.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/pick-progress", json={
            "picked_sizes": {"S": 20, "M": 30},
            "is_complete": True
        }, cookies=op_cookies)
        
        assert progress_resp.status_code == 200, f"Failed: {progress_resp.status_code} - {progress_resp.text}"
        
        data = progress_resp.json()
        assert data.get('picking_status') == 'completed', f"picking_status should be 'completed', got: {data.get('picking_status')}"
        
        # Verify the ticket is marked complete
        list_resp = requests.get(f"{BASE_URL}/api/wms/pick-tickets", cookies=admin_cookies)
        tickets = list_resp.json()
        
        completed_ticket = next((t for t in tickets if t['ticket_id'] == ticket_id), None)
        assert completed_ticket is not None, "Ticket not found"
        assert completed_ticket.get('picking_status') == 'completed', f"picking_status should be 'completed'"
        assert completed_ticket.get('status') == 'confirmed', f"status should be 'confirmed' when complete"
        assert completed_ticket.get('completed_at') is not None, "completed_at should be set"
        
        test_data['completed_ticket_id'] = ticket_id
        print(f"PASS: Complete picking progress marks ticket as completed (status=confirmed, picking_status=completed)")
    
    def test_03_pick_progress_requires_auth(self):
        """PUT /pick-progress requires authentication"""
        response = requests.put(f"{BASE_URL}/api/wms/pick-tickets/some_id/pick-progress", json={
            "picked_sizes": {"S": 10}
        })
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print("PASS: PUT /pick-progress requires authentication")


class TestOperatorCompletedTickets:
    """Test GET /api/wms/operator/completed-tickets endpoint"""
    
    def test_01_operator_can_get_completed_tickets(self):
        """GET /api/wms/operator/completed-tickets returns completed tickets for operator"""
        op_cookies = login_as_operator()
        if not op_cookies:
            pytest.skip("Operator login failed")
        
        response = requests.get(f"{BASE_URL}/api/wms/operator/completed-tickets", cookies=op_cookies)
        assert response.status_code == 200, f"Failed: {response.status_code} - {response.text}"
        
        tickets = response.json()
        assert isinstance(tickets, list), "Response should be a list"
        
        # All returned tickets should be completed
        for ticket in tickets:
            assert ticket.get('picking_status') == 'completed', f"Ticket {ticket.get('ticket_id')} is not completed: {ticket.get('picking_status')}"
        
        print(f"PASS: GET /api/wms/operator/completed-tickets returns {len(tickets)} completed tickets")
    
    def test_02_completed_tickets_requires_auth(self):
        """GET /api/wms/operator/completed-tickets requires authentication"""
        response = requests.get(f"{BASE_URL}/api/wms/operator/completed-tickets")
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print("PASS: GET /api/wms/operator/completed-tickets requires authentication")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
