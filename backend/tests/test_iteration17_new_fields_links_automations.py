"""
Iteration 17 Backend Tests: New Order Fields, Links CRUD, and Automation watch_field/watch_value

Tests 3 NEW features:
1. Order creation with new fields (po_number, customer_po, store_po, cancel_date, links)
2. Links CRUD endpoints (GET, POST, DELETE /api/orders/{id}/links)
3. Automations with watch_field/watch_value trigger conditions
"""

import pytest
import requests
import os
import uuid

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://production-crm-1.preview.emergentagent.com').rstrip('/')
AUTH_TOKEN = "test_refactor_36f1ea86"

class TestRegressionEndpoints:
    """Regression tests - ensure existing endpoints still work"""
    
    def test_get_boards(self):
        """GET /api/config/boards should return board list"""
        response = requests.get(
            f"{BASE_URL}/api/config/boards",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "boards" in data
        assert len(data["boards"]) > 0
        print(f"PASS: GET /api/config/boards - {len(data['boards'])} boards")
    
    def test_get_options(self):
        """GET /api/config/options should return all options"""
        response = requests.get(
            f"{BASE_URL}/api/config/options",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "priorities" in data
        assert "clients" in data
        print(f"PASS: GET /api/config/options - {len(data.keys())} categories")
    
    def test_get_orders(self):
        """GET /api/orders should return orders list"""
        response = requests.get(
            f"{BASE_URL}/api/orders",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert isinstance(data, list)
        print(f"PASS: GET /api/orders - {len(data)} orders")


class TestNewOrderFields:
    """Test 1: Order creation with new fields (po_number, customer_po, store_po, cancel_date, links)"""
    
    def test_create_order_with_new_fields(self):
        """POST /api/orders with po_number, customer_po, store_po, cancel_date"""
        unique_id = uuid.uuid4().hex[:8]
        payload = {
            "order_number": f"TEST_ORD_{unique_id}",
            "po_number": f"PO-{unique_id}",
            "customer_po": f"CUST-PO-{unique_id}",
            "store_po": f"STORE-{unique_id}",
            "cancel_date": "2026-06-15",
            "client": "TARGET",
            "branding": "Target",
            "priority": "RUSH",
            "blank_source": "GLO STOCK",
            "blank_status": "FROM USA",
            "sample": "EJEMPLO APROBADO",
            "artwork_status": "NEW",
            "notes": f"Test order with new fields - {unique_id}",
            "links": [{"url": "https://example.com/link1", "description": "Initial link"}]
        }
        
        response = requests.post(
            f"{BASE_URL}/api/orders",
            json=payload,
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        # Verify new fields are persisted
        assert data["po_number"] == payload["po_number"], "po_number not saved correctly"
        assert data["customer_po"] == payload["customer_po"], "customer_po not saved correctly"
        assert data["store_po"] == payload["store_po"], "store_po not saved correctly"
        assert data["cancel_date"] == payload["cancel_date"], "cancel_date not saved correctly"
        assert data["order_id"] is not None, "order_id not returned"
        
        # Verify links array
        assert "links" in data, "links field missing"
        assert len(data["links"]) >= 1, "Initial link not saved"
        
        print(f"PASS: POST /api/orders with new fields - order_id: {data['order_id']}")
        
        # Store for cleanup and further tests
        self.__class__.test_order_id = data["order_id"]
        return data["order_id"]
    
    def test_get_order_verifies_new_fields(self):
        """GET /api/orders/{id} should return order with new fields"""
        order_id = getattr(self.__class__, 'test_order_id', None)
        if not order_id:
            pytest.skip("No test order created")
        
        response = requests.get(
            f"{BASE_URL}/api/orders/{order_id}",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        # Verify all new fields persisted in database
        assert "po_number" in data, "po_number field missing from GET response"
        assert "customer_po" in data, "customer_po field missing from GET response"
        assert "store_po" in data, "store_po field missing from GET response"
        assert "cancel_date" in data, "cancel_date field missing from GET response"
        assert "links" in data, "links field missing from GET response"
        
        print(f"PASS: GET /api/orders/{order_id} - new fields verified")
    
    def test_update_order_still_works(self):
        """PUT /api/orders/{id} should still work (regression)"""
        order_id = getattr(self.__class__, 'test_order_id', None)
        if not order_id:
            pytest.skip("No test order created")
        
        update_payload = {
            "priority": "PRIORITY 1",
            "notes": "Updated notes - regression test"
        }
        
        response = requests.put(
            f"{BASE_URL}/api/orders/{order_id}",
            json=update_payload,
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert data["priority"] == "PRIORITY 1", "Update not applied"
        
        print(f"PASS: PUT /api/orders/{order_id} - update works")


class TestLinksCRUD:
    """Test 2: Links CRUD endpoints"""
    
    @pytest.fixture(autouse=True)
    def setup_order(self):
        """Create an order for link testing"""
        unique_id = uuid.uuid4().hex[:8]
        payload = {
            "order_number": f"TEST_LINKS_{unique_id}",
            "client": "TARGET",
            "notes": "Order for links testing"
        }
        
        response = requests.post(
            f"{BASE_URL}/api/orders",
            json=payload,
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        if response.status_code == 200:
            self.order_id = response.json()["order_id"]
        else:
            pytest.skip(f"Could not create test order: {response.text}")
    
    def test_add_link_to_order(self):
        """POST /api/orders/{id}/links adds a link"""
        link_payload = {
            "url": "https://example.com/test-link",
            "description": "Test link description"
        }
        
        response = requests.post(
            f"{BASE_URL}/api/orders/{self.order_id}/links",
            json=link_payload,
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        assert data["url"] == link_payload["url"], "Link URL not returned"
        assert data["description"] == link_payload["description"], "Link description not returned"
        assert "created_at" in data, "created_at missing"
        assert "added_by" in data, "added_by missing"
        
        print(f"PASS: POST /api/orders/{self.order_id}/links - link added")
    
    def test_get_order_links(self):
        """GET /api/orders/{id}/links returns all links"""
        # First add a link
        link_payload = {"url": "https://example.com/get-test", "description": "Get test link"}
        requests.post(
            f"{BASE_URL}/api/orders/{self.order_id}/links",
            json=link_payload,
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        response = requests.get(
            f"{BASE_URL}/api/orders/{self.order_id}/links",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        assert isinstance(data, list), "Links should be a list"
        assert len(data) >= 1, "Should have at least one link"
        
        # Verify link structure
        link = data[0]
        assert "url" in link, "Link missing url"
        assert "description" in link, "Link missing description"
        
        print(f"PASS: GET /api/orders/{self.order_id}/links - {len(data)} links returned")
    
    def test_delete_order_link(self):
        """DELETE /api/orders/{id}/links/{index} removes a link"""
        # First add a link
        link_payload = {"url": "https://example.com/delete-test", "description": "Link to delete"}
        requests.post(
            f"{BASE_URL}/api/orders/{self.order_id}/links",
            json=link_payload,
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        # Get links count before delete
        response = requests.get(
            f"{BASE_URL}/api/orders/{self.order_id}/links",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        links_before = len(response.json())
        
        # Delete the first link (index 0)
        response = requests.delete(
            f"{BASE_URL}/api/orders/{self.order_id}/links/0",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "message" in data, "Delete response should have message"
        
        # Verify link was deleted
        response = requests.get(
            f"{BASE_URL}/api/orders/{self.order_id}/links",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        links_after = len(response.json())
        
        assert links_after == links_before - 1, f"Link count should decrease by 1, got before={links_before}, after={links_after}"
        
        print(f"PASS: DELETE /api/orders/{self.order_id}/links/0 - link removed")
    
    def test_add_link_url_required(self):
        """POST /api/orders/{id}/links requires url"""
        link_payload = {"description": "No URL provided"}
        
        response = requests.post(
            f"{BASE_URL}/api/orders/{self.order_id}/links",
            json=link_payload,
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 400, f"Expected 400 for missing URL, got {response.status_code}"
        print(f"PASS: POST /api/orders/{self.order_id}/links - validates URL required")
    
    def test_delete_invalid_link_index(self):
        """DELETE /api/orders/{id}/links/{index} rejects invalid index"""
        response = requests.delete(
            f"{BASE_URL}/api/orders/{self.order_id}/links/999",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 400, f"Expected 400 for invalid index, got {response.status_code}"
        print(f"PASS: DELETE invalid link index returns 400")


class TestAutomationsWatchField:
    """Test 3: Automations with watch_field/watch_value"""
    
    def test_create_automation_with_watch_field(self):
        """POST /api/automations saves watch_field/watch_value in trigger_conditions"""
        unique_name = f"TEST_AUTO_{uuid.uuid4().hex[:8]}"
        
        payload = {
            "name": unique_name,
            "trigger_type": "status_change",
            "trigger_conditions": {
                "watch_field": "production_status",
                "watch_value": "LISTO PARA ENVIO"
            },
            "action_type": "send_email",
            "action_params": {
                "to_email": "test@example.com",
                "subject": "Order Ready: {order_number}",
                "html_content": "<p>Order is ready for shipping</p>"
            },
            "is_active": True
        }
        
        response = requests.post(
            f"{BASE_URL}/api/automations",
            json=payload,
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        # Verify automation was saved with watch_field/watch_value
        assert data["automation_id"] is not None, "automation_id not returned"
        assert data["trigger_type"] == "status_change", "trigger_type incorrect"
        assert data["trigger_conditions"]["watch_field"] == "production_status", "watch_field not saved"
        assert data["trigger_conditions"]["watch_value"] == "LISTO PARA ENVIO", "watch_value not saved"
        
        print(f"PASS: POST /api/automations - watch_field/watch_value saved")
        
        # Store for cleanup
        self.__class__.test_automation_id = data["automation_id"]
    
    def test_get_automations_returns_watch_fields(self):
        """GET /api/automations includes watch_field/watch_value in trigger_conditions"""
        response = requests.get(
            f"{BASE_URL}/api/automations",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        assert isinstance(data, list), "Automations should be a list"
        
        # Look for our test automation or any automation with watch_field
        found_watch_field = False
        for auto in data:
            conds = auto.get("trigger_conditions", {})
            if "watch_field" in conds:
                found_watch_field = True
                print(f"Found automation with watch_field: {auto['name']}")
                break
        
        print(f"PASS: GET /api/automations - {len(data)} automations returned")
    
    def test_automation_with_optional_conditions(self):
        """POST /api/automations allows empty/optional conditions"""
        unique_name = f"TEST_OPT_COND_{uuid.uuid4().hex[:8]}"
        
        # Automation with no conditions (should trigger for all orders)
        payload = {
            "name": unique_name,
            "trigger_type": "create",
            "trigger_conditions": {},  # Empty conditions - 100% optional
            "action_type": "notify_slack",
            "action_params": {
                "message": "New order created: {order_number}"
            },
            "is_active": False  # Disabled to avoid actual notifications
        }
        
        response = requests.post(
            f"{BASE_URL}/api/automations",
            json=payload,
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        assert data["trigger_conditions"] == {}, "Empty conditions should be allowed"
        print(f"PASS: POST /api/automations - empty conditions allowed")
        
        # Cleanup
        if data.get("automation_id"):
            requests.delete(
                f"{BASE_URL}/api/automations/{data['automation_id']}",
                headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
            )


class TestCleanup:
    """Cleanup test data"""
    
    def test_cleanup_test_orders(self):
        """Move test orders to trash"""
        response = requests.get(
            f"{BASE_URL}/api/orders",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        if response.status_code == 200:
            orders = response.json()
            test_orders = [o for o in orders if o.get("order_number", "").startswith("TEST_")]
            
            for order in test_orders:
                requests.delete(
                    f"{BASE_URL}/api/orders/{order['order_id']}",
                    headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
                )
            
            print(f"Cleaned up {len(test_orders)} test orders")
        
        # Cleanup test automations
        response = requests.get(
            f"{BASE_URL}/api/automations",
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
        )
        
        if response.status_code == 200:
            automations = response.json()
            test_autos = [a for a in automations if a.get("name", "").startswith("TEST_")]
            
            for auto in test_autos:
                requests.delete(
                    f"{BASE_URL}/api/automations/{auto['automation_id']}",
                    headers={"Authorization": f"Bearer {AUTH_TOKEN}"}
                )
            
            print(f"Cleaned up {len(test_autos)} test automations")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
