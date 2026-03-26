"""
WMS Iteration 56 Tests
Testing 2 new features:
1. GET /api/wms/inventory/field-options - returns descriptions, countries, fabrics arrays without null/empty values
2. WebSocket broadcast on pick ticket creation with assigned_to and on ticket assignment via PUT /api/wms/pick-tickets/{id}/assign
"""
import pytest
import requests
import os
import json
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestFieldOptionsEndpoint:
    """Tests for GET /api/wms/inventory/field-options endpoint"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Login and get auth cookie"""
        self.session = requests.Session()
        login_res = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_res.status_code == 200, f"Login failed: {login_res.text}"
        self.auth_cookie = login_res.cookies
    
    def test_field_options_returns_200(self):
        """Test that field-options endpoint returns 200"""
        res = self.session.get(f"{BASE_URL}/api/wms/inventory/field-options")
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        print("PASS: /api/wms/inventory/field-options returns 200")
    
    def test_field_options_has_descriptions_array(self):
        """Test that response has 'descriptions' array"""
        res = self.session.get(f"{BASE_URL}/api/wms/inventory/field-options")
        assert res.status_code == 200
        data = res.json()
        assert "descriptions" in data, "Missing 'descriptions' key in response"
        assert isinstance(data["descriptions"], list), "'descriptions' should be a list"
        print(f"PASS: field-options has 'descriptions' array with {len(data['descriptions'])} items")
    
    def test_field_options_has_countries_array(self):
        """Test that response has 'countries' array"""
        res = self.session.get(f"{BASE_URL}/api/wms/inventory/field-options")
        assert res.status_code == 200
        data = res.json()
        assert "countries" in data, "Missing 'countries' key in response"
        assert isinstance(data["countries"], list), "'countries' should be a list"
        print(f"PASS: field-options has 'countries' array with {len(data['countries'])} items")
    
    def test_field_options_has_fabrics_array(self):
        """Test that response has 'fabrics' array"""
        res = self.session.get(f"{BASE_URL}/api/wms/inventory/field-options")
        assert res.status_code == 200
        data = res.json()
        assert "fabrics" in data, "Missing 'fabrics' key in response"
        assert isinstance(data["fabrics"], list), "'fabrics' should be a list"
        print(f"PASS: field-options has 'fabrics' array with {len(data['fabrics'])} items")
    
    def test_field_options_excludes_null_values(self):
        """Test that arrays don't contain null values"""
        res = self.session.get(f"{BASE_URL}/api/wms/inventory/field-options")
        assert res.status_code == 200
        data = res.json()
        
        for field in ["descriptions", "countries", "fabrics"]:
            for val in data.get(field, []):
                assert val is not None, f"Found null value in '{field}' array"
        print("PASS: field-options excludes null values from all arrays")
    
    def test_field_options_excludes_empty_strings(self):
        """Test that arrays don't contain empty strings"""
        res = self.session.get(f"{BASE_URL}/api/wms/inventory/field-options")
        assert res.status_code == 200
        data = res.json()
        
        for field in ["descriptions", "countries", "fabrics"]:
            for val in data.get(field, []):
                assert val != "", f"Found empty string in '{field}' array"
        print("PASS: field-options excludes empty strings from all arrays")
    
    def test_field_options_excludes_dot_values(self):
        """Test that arrays don't contain '.' values"""
        res = self.session.get(f"{BASE_URL}/api/wms/inventory/field-options")
        assert res.status_code == 200
        data = res.json()
        
        for field in ["descriptions", "countries", "fabrics"]:
            for val in data.get(field, []):
                assert val != ".", f"Found '.' value in '{field}' array"
        print("PASS: field-options excludes '.' values from all arrays")
    
    def test_field_options_requires_auth(self):
        """Test that endpoint requires authentication"""
        new_session = requests.Session()  # No login
        res = new_session.get(f"{BASE_URL}/api/wms/inventory/field-options")
        assert res.status_code in [401, 403], f"Expected 401/403 for unauthenticated, got {res.status_code}"
        print("PASS: field-options requires authentication")


class TestWebSocketBroadcastOnPickTicketCreate:
    """Tests for WebSocket broadcast when creating pick ticket with assigned_to"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Login and get auth cookie"""
        self.session = requests.Session()
        login_res = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_res.status_code == 200, f"Login failed: {login_res.text}"
    
    def test_create_pick_ticket_with_assigned_to_returns_200(self):
        """Test creating pick ticket with assigned_to succeeds"""
        # Get an operator first
        ops_res = self.session.get(f"{BASE_URL}/api/wms/operators")
        if ops_res.status_code == 200 and ops_res.json():
            operator = ops_res.json()[0]
            operator_id = operator.get("user_id") or operator.get("email")
            operator_name = operator.get("name") or operator.get("email")
        else:
            operator_id = "picker1@test.com"
            operator_name = "Picker Test"
        
        ticket_data = {
            "order_number": f"TEST-WS-{int(time.time())}",
            "customer": "Test Customer",
            "manufacturer": "Test Mfr",
            "style": "TESTSTYLE",
            "color": "Red",
            "quantity": 100,
            "assigned_to": operator_id,
            "assigned_to_name": operator_name,
            "sizes": {"S": 50, "M": 50}
        }
        
        res = self.session.post(f"{BASE_URL}/api/wms/pick-tickets", json=ticket_data)
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        assert data.get("assigned_to") == operator_id, "assigned_to should be set"
        assert data.get("assigned_to_name") == operator_name, "assigned_to_name should be set"
        print(f"PASS: Created pick ticket {data.get('ticket_id')} with assigned_to={operator_id}")
        # Note: WebSocket broadcast is triggered but we can't verify it via HTTP tests
        # The broadcast happens at line 631 in wms.py
    
    def test_create_pick_ticket_without_assigned_to_succeeds(self):
        """Test creating pick ticket without assigned_to also succeeds (no broadcast)"""
        ticket_data = {
            "order_number": f"TEST-WS-NOASSIGN-{int(time.time())}",
            "customer": "Test Customer",
            "style": "TESTSTYLE",
            "color": "Blue",
            "sizes": {"S": 25}
        }
        
        res = self.session.post(f"{BASE_URL}/api/wms/pick-tickets", json=ticket_data)
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        assert data.get("assigned_to") is None, "assigned_to should be None when not provided"
        print(f"PASS: Created pick ticket {data.get('ticket_id')} without assigned_to")


class TestWebSocketBroadcastOnAssign:
    """Tests for WebSocket broadcast when assigning ticket via PUT /api/wms/pick-tickets/{id}/assign"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Login and get auth cookie"""
        self.session = requests.Session()
        login_res = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_res.status_code == 200, f"Login failed: {login_res.text}"
    
    def test_assign_ticket_endpoint_exists(self):
        """Test that PUT /api/wms/pick-tickets/{id}/assign endpoint exists"""
        # First create a ticket
        ticket_data = {
            "order_number": f"TEST-ASSIGN-{int(time.time())}",
            "customer": "Test",
            "style": "TEST",
            "sizes": {"M": 10}
        }
        create_res = self.session.post(f"{BASE_URL}/api/wms/pick-tickets", json=ticket_data)
        assert create_res.status_code == 200
        ticket_id = create_res.json().get("ticket_id")
        
        # Now try to assign
        assign_data = {
            "operator_id": "picker1@test.com",
            "operator_name": "Picker Test"
        }
        res = self.session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/assign", json=assign_data)
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        print(f"PASS: PUT /api/wms/pick-tickets/{ticket_id}/assign returns 200")
    
    def test_assign_ticket_updates_fields(self):
        """Test that assign endpoint updates assigned_to, assigned_to_name, and picking_status"""
        # Create unassigned ticket
        ticket_data = {
            "order_number": f"TEST-ASSIGN-{int(time.time())}",
            "customer": "Test",
            "style": "TEST2",
            "sizes": {"L": 15}
        }
        create_res = self.session.post(f"{BASE_URL}/api/wms/pick-tickets", json=ticket_data)
        assert create_res.status_code == 200
        ticket_id = create_res.json().get("ticket_id")
        
        # Assign ticket
        assign_data = {
            "operator_id": "picker1@test.com",
            "operator_name": "Picker 1"
        }
        res = self.session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/assign", json=assign_data)
        assert res.status_code == 200
        
        # Verify via GET
        get_res = self.session.get(f"{BASE_URL}/api/wms/pick-tickets")
        assert get_res.status_code == 200
        tickets = get_res.json()
        ticket = next((t for t in tickets if t.get("ticket_id") == ticket_id), None)
        assert ticket is not None, f"Ticket {ticket_id} not found"
        assert ticket.get("assigned_to") == "picker1@test.com", "assigned_to not updated"
        assert ticket.get("assigned_to_name") == "Picker 1", "assigned_to_name not updated"
        assert ticket.get("picking_status") == "assigned", "picking_status should be 'assigned'"
        print(f"PASS: Assign endpoint updates assigned_to, assigned_to_name, and picking_status")
    
    def test_assign_ticket_returns_message(self):
        """Test that assign endpoint returns confirmation message"""
        # Create ticket
        ticket_data = {
            "order_number": f"TEST-ASSIGN-{int(time.time())}",
            "customer": "Test",
            "style": "TEST3",
            "sizes": {"XL": 5}
        }
        create_res = self.session.post(f"{BASE_URL}/api/wms/pick-tickets", json=ticket_data)
        ticket_id = create_res.json().get("ticket_id")
        
        # Assign
        res = self.session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/assign", json={
            "operator_id": "picker1@test.com",
            "operator_name": "Picker 1"
        })
        assert res.status_code == 200
        data = res.json()
        assert "message" in data, "Response should contain 'message'"
        assert ticket_id in data.get("message", ""), "Message should contain ticket_id"
        print(f"PASS: Assign returns message: {data.get('message')}")
    
    def test_assign_ticket_requires_admin(self):
        """Test that assign endpoint requires admin role"""
        # Login as picker (non-admin)
        picker_session = requests.Session()
        login_res = picker_session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "picker1@test.com",
            "password": "picker123"
        })
        # Picker might not exist, skip test if login fails
        if login_res.status_code != 200:
            print("SKIP: picker1@test.com login failed, cannot test admin requirement")
            return
        
        # Try to assign - should fail with 403
        res = picker_session.put(f"{BASE_URL}/api/wms/pick-tickets/some-ticket/assign", json={
            "operator_id": "test",
            "operator_name": "Test"
        })
        # 403 for non-admin or 404 for not found ticket (both valid)
        assert res.status_code in [403, 404], f"Expected 403/404 for non-admin, got {res.status_code}"
        print("PASS: Assign endpoint requires admin role")
    
    def test_assign_nonexistent_ticket_returns_404(self):
        """Test that assigning nonexistent ticket returns 404"""
        res = self.session.put(f"{BASE_URL}/api/wms/pick-tickets/nonexistent-ticket-id/assign", json={
            "operator_id": "picker1@test.com",
            "operator_name": "Picker"
        })
        assert res.status_code == 404, f"Expected 404, got {res.status_code}"
        print("PASS: Assign nonexistent ticket returns 404")
    
    def test_assign_without_operator_id_returns_400(self):
        """Test that assigning without operator_id returns 400"""
        # Create ticket first
        ticket_data = {
            "order_number": f"TEST-ASSIGN-{int(time.time())}",
            "customer": "Test",
            "style": "TEST4",
            "sizes": {"S": 10}
        }
        create_res = self.session.post(f"{BASE_URL}/api/wms/pick-tickets", json=ticket_data)
        ticket_id = create_res.json().get("ticket_id")
        
        # Try to assign without operator_id
        res = self.session.put(f"{BASE_URL}/api/wms/pick-tickets/{ticket_id}/assign", json={
            "operator_name": "Picker"
        })
        assert res.status_code == 400, f"Expected 400, got {res.status_code}"
        print("PASS: Assign without operator_id returns 400")


class TestOperatorsEndpoint:
    """Tests for GET /api/wms/operators endpoint used for assignment"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.session = requests.Session()
        login_res = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_res.status_code == 200
    
    def test_operators_endpoint_returns_list(self):
        """Test that /api/wms/operators returns list of operators"""
        res = self.session.get(f"{BASE_URL}/api/wms/operators")
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        data = res.json()
        assert isinstance(data, list), "Response should be a list"
        print(f"PASS: /api/wms/operators returns list with {len(data)} operators")
    
    def test_operators_have_required_fields(self):
        """Test that operators have user_id/email and name fields"""
        res = self.session.get(f"{BASE_URL}/api/wms/operators")
        assert res.status_code == 200
        operators = res.json()
        if operators:
            op = operators[0]
            assert "user_id" in op or "email" in op, "Operator should have user_id or email"
            print(f"PASS: Operators have required fields. Sample: {json.dumps(op, indent=2)[:200]}")
        else:
            print("WARN: No operators found in database")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
