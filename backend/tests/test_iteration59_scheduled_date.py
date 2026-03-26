"""
Iteration 59: Calendar scheduled_date Independence Tests
Tests that the calendar uses 'scheduled_date' field independently from 'cancel_date'
- PUT /api/orders/{id} with scheduled_date should NOT touch cancel_date
- Orders with scheduled_date appear on calendar based on that date
- Orders without scheduled_date appear in 'sin programar' panel
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')

class TestScheduledDateIndependence:
    """Tests for scheduled_date field independence from cancel_date"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Login and setup session"""
        self.session = requests.Session()
        login_resp = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_resp.status_code == 200, f"Login failed: {login_resp.text}"
        self.user = login_resp.json()
        print(f"Logged in as: {self.user.get('email')}")
    
    def test_order_62970_has_scheduled_date_after_cancel(self):
        """Order 62970 should have scheduled_date=2026-03-24, cancel_date=2026-03-14"""
        # This order is scheduled AFTER its cancel date (warning case)
        resp = self.session.get(f"{BASE_URL}/api/orders/order_b7322ce6ce2b")
        assert resp.status_code == 200
        order = resp.json()
        assert order['scheduled_date'] == '2026-03-24', f"Expected scheduled_date=2026-03-24, got {order.get('scheduled_date')}"
        assert order['cancel_date'] == '2026-03-14', f"Expected cancel_date=2026-03-14, got {order.get('cancel_date')}"
        print(f"Order 62970: scheduled_date={order['scheduled_date']}, cancel_date={order['cancel_date']}")
        print(f"ALERT: Scheduled date is AFTER cancel date - should show warning icon")
    
    def test_update_scheduled_date_does_not_change_cancel_date(self):
        """PUT with new scheduled_date must NOT modify cancel_date"""
        # Get original order state
        get_resp = self.session.get(f"{BASE_URL}/api/orders/order_512112958ccb")
        assert get_resp.status_code == 200
        original = get_resp.json()
        original_cancel = original.get('cancel_date')
        original_scheduled = original.get('scheduled_date')
        print(f"Original order 814: scheduled_date={original_scheduled}, cancel_date={original_cancel}")
        
        # Update ONLY scheduled_date
        new_scheduled = '2026-03-26'
        put_resp = self.session.put(f"{BASE_URL}/api/orders/order_512112958ccb", json={
            "scheduled_date": new_scheduled
        })
        assert put_resp.status_code == 200, f"PUT failed: {put_resp.text}"
        
        # Verify scheduled_date changed but cancel_date stayed the same
        verify_resp = self.session.get(f"{BASE_URL}/api/orders/order_512112958ccb")
        assert verify_resp.status_code == 200
        updated = verify_resp.json()
        
        assert updated['scheduled_date'] == new_scheduled, f"scheduled_date not updated: {updated.get('scheduled_date')}"
        assert updated['cancel_date'] == original_cancel, f"cancel_date was modified! Expected {original_cancel}, got {updated.get('cancel_date')}"
        print(f"PASS: scheduled_date updated to {new_scheduled}, cancel_date unchanged at {original_cancel}")
        
        # Restore original scheduled_date
        restore_resp = self.session.put(f"{BASE_URL}/api/orders/order_512112958ccb", json={
            "scheduled_date": original_scheduled
        })
        assert restore_resp.status_code == 200
        print(f"Restored original scheduled_date: {original_scheduled}")
    
    def test_orders_with_scheduled_date_in_scheduling_board(self):
        """Orders with scheduled_date should appear in SCHEDULING board with that date"""
        resp = self.session.get(f"{BASE_URL}/api/orders?board=SCHEDULING")
        assert resp.status_code == 200
        orders = resp.json()
        
        # Count orders with and without scheduled_date
        with_scheduled = [o for o in orders if o.get('scheduled_date')]
        without_scheduled = [o for o in orders if not o.get('scheduled_date')]
        
        print(f"Total SCHEDULING orders: {len(orders)}")
        print(f"With scheduled_date: {len(with_scheduled)}")
        print(f"Without scheduled_date (sin programar): {len(without_scheduled)}")
        
        for o in with_scheduled:
            print(f"  - {o['order_number']}: scheduled={o['scheduled_date']}, cancel={o.get('cancel_date', 'N/A')}")
        
        assert len(with_scheduled) >= 3, f"Expected at least 3 orders with scheduled_date, got {len(with_scheduled)}"
        assert len(without_scheduled) >= 3, f"Expected at least 3 orders without scheduled_date, got {len(without_scheduled)}"
    
    def test_cancel_date_remains_independent_after_multiple_scheduled_updates(self):
        """Multiple scheduled_date updates should never touch cancel_date"""
        order_id = 'order_2b3b5b3ffc38'  # Order 808
        
        # Get original
        resp = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        assert resp.status_code == 200
        original = resp.json()
        original_cancel = original.get('cancel_date')
        original_scheduled = original.get('scheduled_date')
        print(f"Order 808 original: scheduled={original_scheduled}, cancel={original_cancel}")
        
        # Update scheduled_date multiple times
        test_dates = ['2026-03-27', '2026-03-28', '2026-03-29']
        for new_date in test_dates:
            put_resp = self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={
                "scheduled_date": new_date
            })
            assert put_resp.status_code == 200
            
            verify_resp = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
            updated = verify_resp.json()
            assert updated['cancel_date'] == original_cancel, f"cancel_date changed after update to {new_date}!"
            print(f"  Update to {new_date}: cancel_date still {original_cancel} - OK")
        
        # Restore original
        self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={
            "scheduled_date": original_scheduled
        })
        print(f"Restored original scheduled_date: {original_scheduled}")
    
    def test_setting_scheduled_date_on_unscheduled_order(self):
        """Setting scheduled_date on an order without one should work"""
        # Order 815 has no scheduled_date
        order_id = 'order_960991b95e80'
        
        # Get original state
        resp = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        assert resp.status_code == 200
        original = resp.json()
        original_cancel = original.get('cancel_date')
        original_scheduled = original.get('scheduled_date')
        print(f"Order 815 original: scheduled={original_scheduled}, cancel={original_cancel}")
        
        # Set scheduled_date
        new_scheduled = '2026-03-30'
        put_resp = self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={
            "scheduled_date": new_scheduled
        })
        assert put_resp.status_code == 200
        
        # Verify
        verify_resp = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        updated = verify_resp.json()
        assert updated['scheduled_date'] == new_scheduled
        assert updated['cancel_date'] == original_cancel, "cancel_date should not change when setting scheduled_date"
        print(f"PASS: Set scheduled_date={new_scheduled}, cancel_date unchanged at {original_cancel}")
        
        # Restore (remove scheduled_date)
        restore_resp = self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={
            "scheduled_date": None
        })
        assert restore_resp.status_code == 200
        print(f"Restored: removed scheduled_date")
    
    def test_put_endpoint_supports_arbitrary_fields_via_model_extra(self):
        """PUT endpoint should support arbitrary fields including scheduled_date via model_extra"""
        order_id = 'order_b7322ce6ce2b'  # Order 62970
        
        # Get original
        resp = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        original = resp.json()
        original_scheduled = original.get('scheduled_date')
        original_cancel = original.get('cancel_date')
        
        # Update with scheduled_date (should go through model_extra)
        put_resp = self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={
            "scheduled_date": "2026-03-31"
        })
        assert put_resp.status_code == 200, f"PUT failed: {put_resp.text}"
        
        # Verify update
        verify_resp = self.session.get(f"{BASE_URL}/api/orders/{order_id}")
        updated = verify_resp.json()
        assert updated['scheduled_date'] == "2026-03-31"
        assert updated['cancel_date'] == original_cancel
        print(f"PASS: model_extra handles scheduled_date correctly")
        
        # Restore
        self.session.put(f"{BASE_URL}/api/orders/{order_id}", json={
            "scheduled_date": original_scheduled
        })
        print(f"Restored original scheduled_date: {original_scheduled}")


class TestScheduledDateCalendarLogic:
    """Tests verifying calendar positioning logic uses scheduled_date"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        self.session = requests.Session()
        login_resp = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_resp.status_code == 200
    
    def test_scheduled_date_format_is_valid(self):
        """scheduled_date should be in YYYY-MM-DD format for date-fns parseISO"""
        resp = self.session.get(f"{BASE_URL}/api/orders?board=SCHEDULING")
        assert resp.status_code == 200
        orders = resp.json()
        
        import re
        date_pattern = re.compile(r'^\d{4}-\d{2}-\d{2}$')
        
        for o in orders:
            sched = o.get('scheduled_date')
            if sched:
                assert date_pattern.match(sched), f"Invalid date format for {o['order_number']}: {sched}"
                print(f"Order {o['order_number']}: scheduled_date={sched} - format OK")
    
    def test_orders_grouped_by_scheduled_date_not_cancel_date(self):
        """Verify orders should be grouped by scheduled_date for calendar display"""
        resp = self.session.get(f"{BASE_URL}/api/orders?board=SCHEDULING")
        assert resp.status_code == 200
        orders = resp.json()
        
        # Build groupings
        by_scheduled = {}
        by_cancel = {}
        
        for o in orders:
            sched = o.get('scheduled_date')
            cancel = o.get('cancel_date')
            
            if sched:
                by_scheduled.setdefault(sched, []).append(o['order_number'])
            if cancel:
                by_cancel.setdefault(cancel, []).append(o['order_number'])
        
        print("Grouping by scheduled_date (CORRECT for calendar):")
        for date, orders_list in sorted(by_scheduled.items()):
            print(f"  {date}: {orders_list}")
        
        print("\nGrouping by cancel_date (OLD behavior, should NOT be used):")
        for date, orders_list in sorted(by_cancel.items()):
            print(f"  {date}: {orders_list}")
        
        # Verify Order 62970 would appear on 2026-03-24 (scheduled), not 2026-03-14 (cancel)
        assert '2026-03-24' in by_scheduled, "Order 62970's scheduled_date 2026-03-24 should be in scheduled grouping"
        assert '62970' in by_scheduled.get('2026-03-24', [])


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
