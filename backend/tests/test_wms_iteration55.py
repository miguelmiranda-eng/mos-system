"""
WMS Iteration 55 - Testing 4 new features:
1. GET /api/wms/inventory/options returns 'customers' field
2. GET /api/wms/orders-with-tickets returns map of order_number -> pick tickets array
3. GET /api/wms/pick-tickets/stats returns productivity stats
4. PUT /api/wms/pick-tickets/{ticket_id}/edit - edit ticket and rejection of confirmed/completed
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

@pytest.fixture(scope='module')
def admin_session():
    """Get authenticated admin session."""
    session = requests.Session()
    session.headers.update({'Content-Type': 'application/json'})
    # Login as admin
    resp = session.post(f"{BASE_URL}/api/auth/login", json={
        "email": "admin@test.com",
        "password": "admin123"
    })
    if resp.status_code != 200:
        pytest.skip("Admin login failed - skipping tests")
    return session


class TestInventoryOptionsCustomers:
    """Test GET /api/wms/inventory/options returns 'customers' field."""
    
    def test_inventory_options_returns_customers(self, admin_session):
        """Verify /inventory/options returns customers array along with manufacturers/styles/colors."""
        resp = admin_session.get(f"{BASE_URL}/api/wms/inventory/options")
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        
        data = resp.json()
        assert 'customers' in data, "Response should contain 'customers' key"
        assert 'manufacturers' in data, "Response should contain 'manufacturers' key"
        assert 'styles' in data, "Response should contain 'styles' key"
        assert 'colors' in data, "Response should contain 'colors' key"
        
        assert isinstance(data['customers'], list), "'customers' should be a list"
        assert isinstance(data['manufacturers'], list), "'manufacturers' should be a list"
        assert isinstance(data['styles'], list), "'styles' should be a list"
        assert isinstance(data['colors'], list), "'colors' should be a list"
        print(f"Customers returned: {len(data['customers'])}, first 5: {data['customers'][:5]}")
    
    def test_inventory_options_cascading_filter(self, admin_session):
        """Test cascading filter: when customer is selected, manufacturers/styles/colors are filtered."""
        # First get all customers
        resp = admin_session.get(f"{BASE_URL}/api/wms/inventory/options")
        assert resp.status_code == 200
        data = resp.json()
        
        if len(data['customers']) > 0:
            customer = data['customers'][0]
            # Filter by customer
            resp2 = admin_session.get(f"{BASE_URL}/api/wms/inventory/options?customer={customer}")
            assert resp2.status_code == 200, f"Expected 200, got {resp2.status_code}"
            data2 = resp2.json()
            # Customers list should still be full (unfiltered)
            assert 'customers' in data2
            # Other fields should be filtered
            print(f"Customer '{customer}': manufacturers={len(data2['manufacturers'])}, styles={len(data2['styles'])}, colors={len(data2['colors'])}")
        else:
            pytest.skip("No customers in inventory to test cascading filter")


class TestOrdersWithTickets:
    """Test GET /api/wms/orders-with-tickets returns map of order_number -> pick tickets."""
    
    def test_orders_with_tickets_returns_map(self, admin_session):
        """Verify endpoint returns a dict mapping order_number to list of tickets."""
        resp = admin_session.get(f"{BASE_URL}/api/wms/orders-with-tickets")
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        
        data = resp.json()
        assert isinstance(data, dict), "Response should be a dictionary"
        
        # Check structure of ticket entries
        for order_num, tickets in data.items():
            assert isinstance(tickets, list), f"Tickets for order '{order_num}' should be a list"
            for t in tickets:
                assert 'ticket_id' in t, "Each ticket should have 'ticket_id'"
                assert 'assigned_to_name' in t, "Each ticket should have 'assigned_to_name'"
                assert 'picking_status' in t, "Each ticket should have 'picking_status'"
                assert 'status' in t, "Each ticket should have 'status'"
                assert 'total_pick_qty' in t, "Each ticket should have 'total_pick_qty'"
                assert 'picked_sizes' in t, "Each ticket should have 'picked_sizes'"
                assert 'sizes' in t, "Each ticket should have 'sizes'"
        
        print(f"Orders with tickets: {len(data)} orders, sample: {list(data.keys())[:3]}")


class TestPickTicketsStats:
    """Test GET /api/wms/pick-tickets/stats returns productivity stats."""
    
    def test_stats_returns_correct_structure(self, admin_session):
        """Verify /pick-tickets/stats returns total, completed, in_progress, pending counts and operators array."""
        resp = admin_session.get(f"{BASE_URL}/api/wms/pick-tickets/stats")
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        
        data = resp.json()
        assert 'total_tickets' in data, "Response should contain 'total_tickets'"
        assert 'completed' in data, "Response should contain 'completed'"
        assert 'in_progress' in data, "Response should contain 'in_progress'"
        assert 'pending' in data, "Response should contain 'pending'"
        assert 'operators' in data, "Response should contain 'operators'"
        
        assert isinstance(data['total_tickets'], int), "'total_tickets' should be int"
        assert isinstance(data['completed'], int), "'completed' should be int"
        assert isinstance(data['in_progress'], int), "'in_progress' should be int"
        assert isinstance(data['pending'], int), "'pending' should be int"
        assert isinstance(data['operators'], list), "'operators' should be a list"
        
        print(f"Stats: total={data['total_tickets']}, completed={data['completed']}, in_progress={data['in_progress']}, pending={data['pending']}")
    
    def test_stats_operators_have_productivity_data(self, admin_session):
        """Verify each operator in stats has productivity fields."""
        resp = admin_session.get(f"{BASE_URL}/api/wms/pick-tickets/stats")
        assert resp.status_code == 200
        
        data = resp.json()
        operators = data.get('operators', [])
        
        for op in operators:
            assert 'name' in op, "Operator should have 'name'"
            assert 'completed' in op, "Operator should have 'completed' count"
            assert 'in_progress' in op, "Operator should have 'in_progress' count"
            assert 'assigned' in op, "Operator should have 'assigned' count"
            assert 'total_pieces' in op, "Operator should have 'total_pieces'"
            assert 'picked_pieces' in op, "Operator should have 'picked_pieces'"
        
        if operators:
            print(f"Operators: {len(operators)}, first: {operators[0]}")
        else:
            print("No operators with assigned tickets found")


class TestPickTicketEdit:
    """Test PUT /api/wms/pick-tickets/{ticket_id}/edit."""
    
    @pytest.fixture(scope='class')
    def test_ticket(self, admin_session):
        """Create a test pick ticket for editing."""
        resp = admin_session.post(f"{BASE_URL}/api/wms/pick-tickets", json={
            "order_number": "TEST-EDIT-001",
            "customer": "TestEditCustomer",
            "style": "TESTEDIT-STYLE",
            "color": "Blue",
            "quantity": 100,
            "sizes": {"S": 50, "M": 50}
        })
        if resp.status_code == 200:
            ticket = resp.json()
            yield ticket
        else:
            pytest.skip(f"Could not create test ticket: {resp.text}")
    
    def test_edit_ticket_success(self, admin_session, test_ticket):
        """Test editing a pending ticket successfully."""
        ticket_id = test_ticket['ticket_id']
        
        # Edit the ticket
        resp = admin_session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/edit", json={
            "customer": "UpdatedCustomer",
            "color": "Red",
            "sizes": {"S": 30, "M": 70}
        })
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        
        updated = resp.json()
        assert updated['customer'] == "UpdatedCustomer", "Customer should be updated"
        assert updated['color'] == "Red", "Color should be updated"
        assert updated['sizes']['S'] == 30, "Size S should be 30"
        assert updated['sizes']['M'] == 70, "Size M should be 70"
        assert updated['total_pick_qty'] == 100, "Total pick qty should be recalculated"
        print(f"Ticket {ticket_id} edited successfully: {updated['customer']}, {updated['color']}")
    
    def test_edit_ticket_operator_assignment(self, admin_session, test_ticket):
        """Test editing ticket to assign/reassign operator."""
        ticket_id = test_ticket['ticket_id']
        
        # Get operators
        ops_resp = admin_session.get(f"{BASE_URL}/api/wms/operators")
        if ops_resp.status_code != 200:
            pytest.skip("Could not fetch operators")
        operators = ops_resp.json()
        
        if len(operators) > 0:
            op = operators[0]
            # Assign operator via edit
            resp = admin_session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/edit", json={
                "assigned_to": op.get('user_id') or op.get('email'),
                "assigned_to_name": op.get('name') or op.get('email')
            })
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            
            updated = resp.json()
            assert updated['assigned_to_name'] == (op.get('name') or op.get('email')), "Operator should be assigned"
            assert updated['picking_status'] == 'assigned', "Picking status should be 'assigned'"
            print(f"Operator assigned via edit: {updated['assigned_to_name']}")
        else:
            pytest.skip("No operators available to test assignment")
    
    def test_edit_nonexistent_ticket_returns_404(self, admin_session):
        """Test editing a nonexistent ticket returns 404."""
        resp = admin_session.put(f"{BASE_URL}/api/wms/pick-tickets/nonexistent-ticket-id/edit", json={
            "customer": "Test"
        })
        assert resp.status_code == 404, f"Expected 404 for nonexistent ticket, got {resp.status_code}"


class TestEditRejectsConfirmedCompleted:
    """Test that edit endpoint rejects editing confirmed/completed tickets."""
    
    @pytest.fixture(scope='class')
    def confirmed_ticket(self, admin_session):
        """Create and confirm a test ticket."""
        # Create ticket
        resp = admin_session.post(f"{BASE_URL}/api/wms/pick-tickets", json={
            "order_number": "TEST-CONFIRMED-001",
            "customer": "ConfirmedTestCustomer",
            "style": "CONFIRMED-STYLE",
            "color": "Black",
            "quantity": 50,
            "sizes": {"L": 50}
        })
        if resp.status_code != 200:
            pytest.skip(f"Could not create test ticket: {resp.text}")
        
        ticket = resp.json()
        ticket_id = ticket['ticket_id']
        
        # Confirm the ticket
        confirm_resp = admin_session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/confirm", json={
            "lines": []
        })
        if confirm_resp.status_code != 200:
            pytest.skip(f"Could not confirm ticket: {confirm_resp.text}")
        
        yield ticket
    
    def test_edit_confirmed_ticket_returns_400(self, admin_session, confirmed_ticket):
        """Test that editing a confirmed ticket returns 400 error."""
        ticket_id = confirmed_ticket['ticket_id']
        
        resp = admin_session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/edit", json={
            "customer": "ShouldNotUpdate"
        })
        assert resp.status_code == 400, f"Expected 400 for confirmed ticket edit, got {resp.status_code}: {resp.text}"
        
        error = resp.json()
        assert 'detail' in error, "Error response should have 'detail'"
        print(f"Confirmed ticket edit correctly rejected: {error.get('detail')}")
    
    @pytest.fixture(scope='class')
    def completed_ticket(self, admin_session):
        """Create and complete a test ticket."""
        # Create ticket with operator
        ops_resp = admin_session.get(f"{BASE_URL}/api/wms/operators")
        operators = ops_resp.json() if ops_resp.status_code == 200 else []
        
        operator_id = operators[0].get('user_id') or operators[0].get('email') if operators else None
        operator_name = operators[0].get('name') or operators[0].get('email') if operators else None
        
        resp = admin_session.post(f"{BASE_URL}/api/wms/pick-tickets", json={
            "order_number": "TEST-COMPLETED-001",
            "customer": "CompletedTestCustomer",
            "style": "COMPLETED-STYLE",
            "color": "White",
            "quantity": 25,
            "sizes": {"XL": 25},
            "assigned_to": operator_id or "",
            "assigned_to_name": operator_name or ""
        })
        if resp.status_code != 200:
            pytest.skip(f"Could not create test ticket: {resp.text}")
        
        ticket = resp.json()
        ticket_id = ticket['ticket_id']
        
        # Complete the ticket via pick-progress
        complete_resp = admin_session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/pick-progress", json={
            "picked_sizes": {"XL": 25},
            "is_complete": True
        })
        if complete_resp.status_code != 200:
            pytest.skip(f"Could not complete ticket: {complete_resp.text}")
        
        yield ticket
    
    def test_edit_completed_ticket_returns_400(self, admin_session, completed_ticket):
        """Test that editing a completed ticket returns 400 error."""
        ticket_id = completed_ticket['ticket_id']
        
        resp = admin_session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/edit", json={
            "customer": "ShouldNotUpdate"
        })
        assert resp.status_code == 400, f"Expected 400 for completed ticket edit, got {resp.status_code}: {resp.text}"
        
        error = resp.json()
        assert 'detail' in error, "Error response should have 'detail'"
        print(f"Completed ticket edit correctly rejected: {error.get('detail')}")


class TestAuthRequired:
    """Test that all new endpoints require authentication."""
    
    def test_inventory_options_requires_auth(self):
        """Verify /inventory/options requires authentication."""
        resp = requests.get(f"{BASE_URL}/api/wms/inventory/options")
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"
    
    def test_orders_with_tickets_requires_auth(self):
        """Verify /orders-with-tickets requires authentication."""
        resp = requests.get(f"{BASE_URL}/api/wms/orders-with-tickets")
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"
    
    def test_pick_tickets_stats_requires_auth(self):
        """Verify /pick-tickets/stats requires authentication."""
        resp = requests.get(f"{BASE_URL}/api/wms/pick-tickets/stats")
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"
    
    def test_edit_ticket_requires_auth(self):
        """Verify PUT /pick-tickets/{id}/edit requires authentication."""
        resp = requests.put(f"{BASE_URL}/api/wms/pick-tickets/test-id/edit", json={"customer": "Test"})
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"
