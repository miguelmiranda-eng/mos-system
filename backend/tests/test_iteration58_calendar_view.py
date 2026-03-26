"""
Iteration 58: Calendar View for SCHEDULING Board
Tests for:
1. GET /api/orders?board=SCHEDULING - returns orders with cancel_date
2. PUT /api/orders/{order_id} - update cancel_date (for drag/drop)
3. POST /api/orders/bulk-move - move orders between boards
"""

import pytest
import requests
import os
from datetime import datetime, timedelta

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

@pytest.fixture(scope="module")
def auth_session():
    """Authenticate and return session with cookies"""
    session = requests.Session()
    
    # Login with admin credentials
    login_response = session.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@test.com", "password": "admin123"}
    )
    
    if login_response.status_code != 200:
        pytest.skip(f"Authentication failed: {login_response.status_code} - {login_response.text}")
    
    return session


class TestOrdersWithCancelDate:
    """Test that orders with cancel_date are returned correctly for calendar display"""
    
    def test_get_scheduling_orders(self, auth_session):
        """GET /api/orders?board=SCHEDULING returns orders"""
        response = auth_session.get(f"{BASE_URL}/api/orders?board=SCHEDULING")
        assert response.status_code == 200
        
        orders = response.json()
        assert isinstance(orders, list)
        print(f"Found {len(orders)} orders in SCHEDULING board")
        
        # Check for orders with cancel_date
        orders_with_cancel = [o for o in orders if o.get('cancel_date')]
        print(f"Orders with cancel_date: {len(orders_with_cancel)}")
        
        for order in orders_with_cancel[:5]:
            print(f"  - {order.get('order_number')}: cancel_date={order.get('cancel_date')}")
        
        # Orders without cancel_date (should show in "sin fecha" badge)
        orders_without_cancel = [o for o in orders if not o.get('cancel_date')]
        print(f"Orders without cancel_date (sin fecha): {len(orders_without_cancel)}")
    
    def test_orders_have_calendar_fields(self, auth_session):
        """Verify orders have all 8 default calendar fields"""
        response = auth_session.get(f"{BASE_URL}/api/orders?board=SCHEDULING")
        assert response.status_code == 200
        
        orders = response.json()
        if len(orders) == 0:
            pytest.skip("No orders in SCHEDULING to verify fields")
        
        # Default visible fields for calendar cards
        default_fields = ['client', 'quantity', 'blank_status', 'screens', 
                          'production_status', 'trim_status', 'artwork_status', 'cancel_date']
        
        sample_order = orders[0]
        print(f"Checking order {sample_order.get('order_number')} for calendar fields:")
        
        for field in default_fields:
            assert field in sample_order, f"Field '{field}' missing from order response"
            print(f"  - {field}: {sample_order.get(field)}")


class TestCancelDateUpdate:
    """Test updating cancel_date via PUT /api/orders/{id} (drag & drop)"""
    
    def test_update_cancel_date(self, auth_session):
        """PUT /api/orders/{id} can update cancel_date"""
        # First get an order to update
        response = auth_session.get(f"{BASE_URL}/api/orders?board=SCHEDULING")
        assert response.status_code == 200
        
        orders = response.json()
        if len(orders) == 0:
            pytest.skip("No orders in SCHEDULING to update")
        
        # Find an order to update (preferably one with an existing cancel_date)
        test_order = None
        for order in orders:
            if order.get('cancel_date'):
                test_order = order
                break
        
        if not test_order:
            test_order = orders[0]
        
        order_id = test_order.get('order_id')
        original_cancel_date = test_order.get('cancel_date')
        print(f"Testing order {test_order.get('order_number')} (id: {order_id})")
        print(f"Original cancel_date: {original_cancel_date}")
        
        # Set a new cancel_date (tomorrow)
        tomorrow = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%d')
        
        update_response = auth_session.put(
            f"{BASE_URL}/api/orders/{order_id}",
            json={"cancel_date": tomorrow}
        )
        
        assert update_response.status_code == 200, f"Update failed: {update_response.text}"
        updated_order = update_response.json()
        
        # Verify the cancel_date was updated
        assert updated_order.get('cancel_date') == tomorrow, \
            f"cancel_date not updated. Expected {tomorrow}, got {updated_order.get('cancel_date')}"
        print(f"Successfully updated cancel_date to: {tomorrow}")
        
        # Restore original value if it existed
        if original_cancel_date:
            restore_response = auth_session.put(
                f"{BASE_URL}/api/orders/{order_id}",
                json={"cancel_date": original_cancel_date}
            )
            assert restore_response.status_code == 200
            print(f"Restored cancel_date to: {original_cancel_date}")


class TestBulkMove:
    """Test moving orders between boards via POST /api/orders/bulk-move"""
    
    def test_bulk_move_to_board(self, auth_session):
        """POST /api/orders/bulk-move moves orders to another board"""
        # Get orders from SCHEDULING
        response = auth_session.get(f"{BASE_URL}/api/orders?board=SCHEDULING")
        assert response.status_code == 200
        
        orders = response.json()
        if len(orders) == 0:
            pytest.skip("No orders in SCHEDULING to move")
        
        test_order = orders[0]
        order_id = test_order.get('order_id')
        original_board = test_order.get('board')
        
        print(f"Testing bulk-move for order {test_order.get('order_number')}")
        print(f"Original board: {original_board}")
        
        # Move to BLANKS board
        target_board = "BLANKS"
        move_response = auth_session.post(
            f"{BASE_URL}/api/orders/bulk-move",
            json={"order_ids": [order_id], "board": target_board}
        )
        
        assert move_response.status_code == 200, f"Bulk move failed: {move_response.text}"
        print(f"Successfully moved to {target_board}")
        
        # Verify order is now in BLANKS
        verify_response = auth_session.get(f"{BASE_URL}/api/orders/{order_id}")
        if verify_response.status_code == 200:
            moved_order = verify_response.json()
            assert moved_order.get('board') == target_board, \
                f"Order not in {target_board}. Found in {moved_order.get('board')}"
        
        # Move back to original board
        restore_response = auth_session.post(
            f"{BASE_URL}/api/orders/bulk-move",
            json={"order_ids": [order_id], "board": original_board}
        )
        assert restore_response.status_code == 200
        print(f"Restored order to {original_board}")
    
    def test_bulk_move_requires_auth(self):
        """POST /api/orders/bulk-move requires authentication"""
        session = requests.Session()  # No auth
        response = session.post(
            f"{BASE_URL}/api/orders/bulk-move",
            json={"order_ids": ["fake_id"], "board": "BLANKS"}
        )
        assert response.status_code in [401, 403], \
            f"Expected 401/403 for unauthenticated request, got {response.status_code}"
        print("Bulk move correctly requires authentication")


class TestCalendarAPIIntegration:
    """Integration tests for calendar-specific scenarios"""
    
    def test_order_data_structure_for_calendar(self, auth_session):
        """Verify order data has all fields needed for CalendarView component"""
        response = auth_session.get(f"{BASE_URL}/api/orders?board=SCHEDULING")
        assert response.status_code == 200
        
        orders = response.json()
        if len(orders) == 0:
            pytest.skip("No orders to verify")
        
        sample = orders[0]
        
        # Required fields for OrderCard component
        required_fields = [
            'order_id',      # For card key and API calls
            'order_number',  # Display in card header
            'board',         # For move-to-board filtering
            'client',        # Default visible field
            'quantity',      # Default visible field
            'blank_status',  # Default visible field
            'screens',       # Default visible field
            'production_status',  # Default visible field
            'trim_status',   # Default visible field
            'artwork_status', # Default visible field
            'cancel_date',   # Date for calendar positioning
            'priority',      # For border color
        ]
        
        print("Verifying order structure for calendar display:")
        for field in required_fields:
            assert field in sample, f"Missing required field: {field}"
            print(f"  ✓ {field}: {sample.get(field)}")
        
        print("\nAll required calendar fields present!")
    
    def test_date_format_compatible(self, auth_session):
        """Verify cancel_date format is compatible with parseISO"""
        response = auth_session.get(f"{BASE_URL}/api/orders?board=SCHEDULING")
        assert response.status_code == 200
        
        orders = response.json()
        orders_with_dates = [o for o in orders if o.get('cancel_date')]
        
        if len(orders_with_dates) == 0:
            pytest.skip("No orders with cancel_date to verify format")
        
        print("Checking date formats:")
        for order in orders_with_dates[:5]:
            cancel_date = order.get('cancel_date')
            print(f"  {order.get('order_number')}: {cancel_date}")
            
            # Verify format is YYYY-MM-DD or ISO datetime
            assert cancel_date, "cancel_date is null"
            if 'T' in cancel_date:
                # ISO datetime format
                assert len(cancel_date) >= 10, f"Invalid ISO date: {cancel_date}"
            else:
                # Simple date format YYYY-MM-DD
                assert len(cancel_date) == 10, f"Invalid date format: {cancel_date}"
                parts = cancel_date.split('-')
                assert len(parts) == 3, f"Date should have 3 parts: {cancel_date}"
