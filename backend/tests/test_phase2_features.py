"""
Phase 2 Tests: Saved Views + Calendar View Features
Tests the saved views CRUD operations and order due_date updates for calendar drag & drop
"""
import pytest
import requests
import os
from datetime import datetime

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = "test_session_phase2_1772563383584"

class TestSavedViewsCRUD:
    """Test saved views CRUD endpoints"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SESSION_TOKEN}"
        }
        self.created_view_ids = []
        yield
        # Cleanup created views
        for view_id in self.created_view_ids:
            try:
                requests.delete(f"{BASE_URL}/api/saved-views/{view_id}", headers=self.headers)
            except:
                pass
    
    def test_get_saved_views_returns_list(self):
        """GET /api/saved-views returns list for authenticated user"""
        response = requests.get(f"{BASE_URL}/api/saved-views", headers=self.headers)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        print(f"PASS: GET /api/saved-views returns list ({len(data)} views)")
    
    def test_create_saved_view_basic(self):
        """POST /api/saved-views creates new saved view"""
        payload = {
            "name": "TEST_Phase2_View_Basic",
            "board": "SCHEDULING",
            "filters": {"priority": "RUSH"},
            "pinned": False
        }
        response = requests.post(f"{BASE_URL}/api/saved-views", headers=self.headers, json=payload)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        
        # Verify response fields
        assert "view_id" in data, "Response should contain view_id"
        assert data["name"] == "TEST_Phase2_View_Basic"
        assert data["board"] == "SCHEDULING"
        assert data["filters"]["priority"] == "RUSH"
        assert data["pinned"] == False
        
        self.created_view_ids.append(data["view_id"])
        print(f"PASS: Created saved view with view_id={data['view_id']}")
        return data["view_id"]
    
    def test_create_saved_view_pinned(self):
        """POST /api/saved-views creates pinned view"""
        payload = {
            "name": "TEST_Phase2_Pinned_View",
            "board": "MASTER",
            "filters": {"client": "LOVE IN FAITH", "blank_status": "PENDIENTE"},
            "pinned": True
        }
        response = requests.post(f"{BASE_URL}/api/saved-views", headers=self.headers, json=payload)
        assert response.status_code == 200
        data = response.json()
        assert data["pinned"] == True, "View should be pinned"
        self.created_view_ids.append(data["view_id"])
        print(f"PASS: Created pinned view with view_id={data['view_id']}")
    
    def test_update_saved_view_pinned_status(self):
        """PUT /api/saved-views/{view_id} updates pinned status"""
        # First create a view
        create_payload = {
            "name": "TEST_Phase2_ToPin",
            "board": "SCHEDULING",
            "filters": {},
            "pinned": False
        }
        create_res = requests.post(f"{BASE_URL}/api/saved-views", headers=self.headers, json=create_payload)
        assert create_res.status_code == 200
        view_id = create_res.json()["view_id"]
        self.created_view_ids.append(view_id)
        
        # Update pinned status to True
        update_payload = {"pinned": True}
        update_res = requests.put(f"{BASE_URL}/api/saved-views/{view_id}", headers=self.headers, json=update_payload)
        assert update_res.status_code == 200, f"Expected 200, got {update_res.status_code}"
        
        # Verify pinned status changed by fetching all views
        get_res = requests.get(f"{BASE_URL}/api/saved-views", headers=self.headers)
        views = get_res.json()
        updated_view = next((v for v in views if v["view_id"] == view_id), None)
        assert updated_view is not None, "View should exist after update"
        assert updated_view["pinned"] == True, "View should be pinned after update"
        print(f"PASS: Updated view {view_id} pinned status to True")
    
    def test_update_saved_view_name(self):
        """PUT /api/saved-views/{view_id} can update name"""
        # Create view
        create_payload = {
            "name": "TEST_Phase2_OriginalName",
            "board": "BLANKS",
            "filters": {"blank_source": "GLO STOCK"},
            "pinned": False
        }
        create_res = requests.post(f"{BASE_URL}/api/saved-views", headers=self.headers, json=create_payload)
        view_id = create_res.json()["view_id"]
        self.created_view_ids.append(view_id)
        
        # Update name
        update_payload = {"name": "TEST_Phase2_RenamedView"}
        update_res = requests.put(f"{BASE_URL}/api/saved-views/{view_id}", headers=self.headers, json=update_payload)
        assert update_res.status_code == 200
        
        # Verify
        get_res = requests.get(f"{BASE_URL}/api/saved-views", headers=self.headers)
        views = get_res.json()
        updated_view = next((v for v in views if v["view_id"] == view_id), None)
        assert updated_view["name"] == "TEST_Phase2_RenamedView"
        print(f"PASS: Renamed view {view_id}")
    
    def test_delete_saved_view(self):
        """DELETE /api/saved-views/{view_id} removes the view"""
        # Create a view to delete
        create_payload = {
            "name": "TEST_Phase2_ToDelete",
            "board": "SCREENS",
            "filters": {},
            "pinned": False
        }
        create_res = requests.post(f"{BASE_URL}/api/saved-views", headers=self.headers, json=create_payload)
        view_id = create_res.json()["view_id"]
        
        # Delete the view
        delete_res = requests.delete(f"{BASE_URL}/api/saved-views/{view_id}", headers=self.headers)
        assert delete_res.status_code == 200, f"Expected 200, got {delete_res.status_code}"
        
        # Verify view is gone
        get_res = requests.get(f"{BASE_URL}/api/saved-views", headers=self.headers)
        views = get_res.json()
        deleted_view = next((v for v in views if v["view_id"] == view_id), None)
        assert deleted_view is None, "View should be deleted"
        print(f"PASS: Deleted view {view_id}")
    
    def test_saved_views_unauthenticated(self):
        """Saved views endpoints require authentication"""
        no_auth_headers = {"Content-Type": "application/json"}
        
        get_res = requests.get(f"{BASE_URL}/api/saved-views", headers=no_auth_headers)
        assert get_res.status_code == 401, f"GET should require auth, got {get_res.status_code}"
        
        post_res = requests.post(f"{BASE_URL}/api/saved-views", headers=no_auth_headers, json={"name": "Test"})
        assert post_res.status_code == 401, f"POST should require auth, got {post_res.status_code}"
        
        print("PASS: Saved views endpoints require authentication")


class TestCalendarDragDropUpdate:
    """Test order due_date update for calendar drag & drop"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SESSION_TOKEN}"
        }
        self.created_order_ids = []
        yield
        # Cleanup created orders
        for order_id in self.created_order_ids:
            try:
                requests.delete(f"{BASE_URL}/api/orders/{order_id}/permanent", headers=self.headers)
            except:
                pass
    
    def test_create_order_with_due_date(self):
        """POST /api/orders creates order with due_date field"""
        payload = {
            "order_number": "TEST_CAL_001",
            "client": "LOVE IN FAITH",
            "priority": "RUSH",
            "quantity": 100,
            "due_date": "2026-01-20"
        }
        response = requests.post(f"{BASE_URL}/api/orders", headers=self.headers, json=payload)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        
        assert data["due_date"] == "2026-01-20", f"Expected due_date='2026-01-20', got {data.get('due_date')}"
        self.created_order_ids.append(data["order_id"])
        print(f"PASS: Created order with due_date={data['due_date']}")
        return data["order_id"]
    
    def test_update_order_due_date(self):
        """PUT /api/orders/{order_id} can update due_date (calendar drag & drop)"""
        # Create order first
        create_payload = {
            "order_number": "TEST_CAL_002",
            "client": "GOODIE TWO SLEEVES",
            "due_date": "2026-01-15"
        }
        create_res = requests.post(f"{BASE_URL}/api/orders", headers=self.headers, json=create_payload)
        order_id = create_res.json()["order_id"]
        self.created_order_ids.append(order_id)
        
        # Update due_date (simulating calendar drag & drop)
        new_date = "2026-01-25"
        update_payload = {"due_date": new_date}
        update_res = requests.put(f"{BASE_URL}/api/orders/{order_id}", headers=self.headers, json=update_payload)
        assert update_res.status_code == 200, f"Expected 200, got {update_res.status_code}"
        
        updated_order = update_res.json()
        assert updated_order["due_date"] == new_date, f"Expected due_date='{new_date}', got {updated_order.get('due_date')}"
        
        # Verify via GET
        get_res = requests.get(f"{BASE_URL}/api/orders/{order_id}", headers=self.headers)
        fetched_order = get_res.json()
        assert fetched_order["due_date"] == new_date
        print(f"PASS: Updated order {order_id} due_date from 2026-01-15 to {new_date}")
    
    def test_update_order_due_date_clear(self):
        """PUT /api/orders/{order_id} can clear due_date"""
        # Create order with due_date
        create_payload = {
            "order_number": "TEST_CAL_003",
            "due_date": "2026-02-01"
        }
        create_res = requests.post(f"{BASE_URL}/api/orders", headers=self.headers, json=create_payload)
        order_id = create_res.json()["order_id"]
        self.created_order_ids.append(order_id)
        
        # Clear due_date
        update_payload = {"due_date": None}
        update_res = requests.put(f"{BASE_URL}/api/orders/{order_id}", headers=self.headers, json=update_payload)
        assert update_res.status_code == 200
        
        # Verify
        get_res = requests.get(f"{BASE_URL}/api/orders/{order_id}", headers=self.headers)
        fetched_order = get_res.json()
        assert fetched_order["due_date"] is None, f"Expected due_date=None, got {fetched_order.get('due_date')}"
        print(f"PASS: Cleared due_date for order {order_id}")
    
    def test_get_orders_with_due_dates(self):
        """GET /api/orders returns orders with due_date field (for calendar rendering)"""
        # Create orders with different due dates
        dates = ["2026-01-10", "2026-01-15", "2026-01-20"]
        for i, date in enumerate(dates):
            payload = {
                "order_number": f"TEST_CAL_MULTI_{i}",
                "due_date": date
            }
            res = requests.post(f"{BASE_URL}/api/orders", headers=self.headers, json=payload)
            self.created_order_ids.append(res.json()["order_id"])
        
        # Fetch orders
        get_res = requests.get(f"{BASE_URL}/api/orders?board=SCHEDULING", headers=self.headers)
        assert get_res.status_code == 200
        orders = get_res.json()
        
        # Verify due_date field exists in response
        test_orders = [o for o in orders if o["order_number"].startswith("TEST_CAL_MULTI_")]
        assert len(test_orders) == 3, f"Expected 3 test orders, got {len(test_orders)}"
        for order in test_orders:
            assert "due_date" in order, f"Order {order['order_number']} missing due_date field"
        print(f"PASS: GET /api/orders returns {len(test_orders)} orders with due_date field")


class TestBoardFiltering:
    """Test that orders can be filtered by board for calendar view"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SESSION_TOKEN}"
        }
    
    def test_get_orders_by_scheduling_board(self):
        """GET /api/orders?board=SCHEDULING returns only SCHEDULING orders"""
        response = requests.get(f"{BASE_URL}/api/orders?board=SCHEDULING", headers=self.headers)
        assert response.status_code == 200
        orders = response.json()
        
        # All returned orders should be in SCHEDULING board
        for order in orders:
            assert order.get("board") == "SCHEDULING", f"Expected board=SCHEDULING, got {order.get('board')}"
        
        print(f"PASS: GET /api/orders?board=SCHEDULING returns {len(orders)} orders, all in SCHEDULING board")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
