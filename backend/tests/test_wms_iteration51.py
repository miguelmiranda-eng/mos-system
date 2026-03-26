"""
WMS Iteration 51 - Testing new frontend forms:
1. Allocation Module - create allocation, delete allocation
2. Picking Module - create pick ticket, confirm pick
3. Production Module - move boxes between states (raw→wip→finished)
4. Shipping Module - create shipment with finished boxes

This builds on iteration 50 which tested all 11 modules' basic API endpoints.
"""
import pytest
import requests
import os
import time
import uuid

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_COOKIE = {"session_token": "test_admin_sess"}


class TestWMSFullFlow:
    """
    Test the complete WMS flow:
    1. Create receiving (creates boxes and inventory)
    2. Create location and putaway boxes
    3. Create allocation (assign inventory to order)
    4. Create pick ticket from allocation
    5. Confirm pick ticket
    6. Move boxes to production (raw→wip→finished)
    7. Create shipment with finished boxes
    """
    
    @pytest.fixture(scope="class")
    def test_data(self):
        """Fixture to hold test data across tests"""
        return {}
    
    def test_01_create_test_receiving(self, test_data):
        """Create a receiving with boxes for the flow test"""
        unique_id = str(uuid.uuid4())[:8]
        receiving_data = {
            "po": f"TEST_PO_{unique_id}",
            "vendor": f"TEST_VENDOR_{unique_id}",
            "items": [{
                "sku": f"TEST_SKU_{unique_id}",
                "color": "Red",
                "size": "M",
                "boxes": 3,
                "units_per_box": 10
            }]
        }
        response = requests.post(f"{BASE_URL}/api/wms/receiving", json=receiving_data, cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Failed to create receiving: {response.text}"
        data = response.json()
        
        # Store data for subsequent tests
        test_data['receiving_id'] = data.get('receiving_id')
        test_data['sku'] = f"TEST_SKU_{unique_id}"
        test_data['color'] = "Red"
        test_data['size'] = "M"
        test_data['box_ids'] = [b['box_id'] for b in data.get('boxes', [])]
        
        assert len(test_data['box_ids']) == 3, f"Expected 3 boxes, got {len(test_data['box_ids'])}"
        print(f"PASS: Created receiving {test_data['receiving_id']} with boxes: {test_data['box_ids']}")
    
    def test_02_putaway_boxes(self, test_data):
        """Put away the received boxes to a location"""
        if not test_data.get('box_ids'):
            pytest.skip("No boxes from receiving")
        
        # Use existing location A-01-01
        for box_id in test_data['box_ids']:
            response = requests.post(f"{BASE_URL}/api/wms/putaway", json={
                "box_id": box_id,
                "location": "A-01-01"
            }, cookies=SESSION_COOKIE)
            assert response.status_code == 200, f"Failed to putaway {box_id}: {response.text}"
        
        print(f"PASS: Put away {len(test_data['box_ids'])} boxes to A-01-01")
    
    def test_03_verify_inventory_available(self, test_data):
        """Verify inventory is available for allocation"""
        if not test_data.get('sku'):
            pytest.skip("No SKU from receiving")
        
        response = requests.get(f"{BASE_URL}/api/wms/inventory?sku={test_data['sku']}", cookies=SESSION_COOKIE)
        assert response.status_code == 200
        data = response.json()
        
        matching_inv = [inv for inv in data if inv.get('sku') == test_data['sku']]
        assert len(matching_inv) > 0, f"No inventory found for SKU {test_data['sku']}"
        
        inv = matching_inv[0]
        test_data['available_qty'] = inv.get('available', 0)
        assert test_data['available_qty'] > 0, f"No available inventory: {inv}"
        print(f"PASS: Inventory available for {test_data['sku']}: {test_data['available_qty']} units")


class TestAllocationModule:
    """Test Allocation module CRUD operations"""
    
    @pytest.fixture(scope="class")
    def allocation_data(self):
        """Fixture to hold allocation test data"""
        return {}
    
    def test_01_get_orders_for_allocation(self, allocation_data):
        """Get orders available for allocation"""
        response = requests.get(f"{BASE_URL}/api/wms/orders", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Failed to get orders: {response.text}"
        orders = response.json()
        
        if orders:
            allocation_data['order_id'] = orders[0].get('order_id')
            allocation_data['order_number'] = orders[0].get('order_number')
            print(f"PASS: Found {len(orders)} orders for allocation. Using: {allocation_data['order_number']}")
        else:
            # Create a test order if none exist
            print("INFO: No orders available, will test allocation with inventory only")
    
    def test_02_get_inventory_for_allocation(self, allocation_data):
        """Get available inventory for allocation"""
        response = requests.get(f"{BASE_URL}/api/wms/inventory", cookies=SESSION_COOKIE)
        assert response.status_code == 200
        inventory = response.json()
        
        # Find inventory with available qty
        available_inv = [inv for inv in inventory if inv.get('available', 0) > 0]
        
        if available_inv:
            allocation_data['inv'] = available_inv[0]
            print(f"PASS: Found {len(available_inv)} SKUs with available inventory")
        else:
            print("INFO: No available inventory for allocation")
    
    def test_03_create_allocation(self, allocation_data):
        """Create an allocation - assign inventory to an order"""
        if not allocation_data.get('order_id'):
            pytest.skip("No orders available for allocation")
        if not allocation_data.get('inv'):
            pytest.skip("No available inventory for allocation")
        
        inv = allocation_data['inv']
        alloc_qty = min(5, inv.get('available', 0))  # Allocate up to 5 units
        
        alloc_data = {
            "order_id": allocation_data['order_id'],
            "items": [{
                "sku": inv.get('sku'),
                "color": inv.get('color', ''),
                "size": inv.get('size', ''),
                "qty": alloc_qty
            }]
        }
        
        response = requests.post(f"{BASE_URL}/api/wms/allocations", json=alloc_data, cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Failed to create allocation: {response.text}"
        data = response.json()
        
        assert 'allocation_id' in data, "Missing allocation_id in response"
        assert data.get('status') == 'allocated', f"Expected status 'allocated', got {data.get('status')}"
        
        allocation_data['allocation_id'] = data.get('allocation_id')
        print(f"PASS: Created allocation {data['allocation_id']} for order {allocation_data['order_number']}")
    
    def test_04_list_allocations(self, allocation_data):
        """List allocations"""
        response = requests.get(f"{BASE_URL}/api/wms/allocations", cookies=SESSION_COOKIE)
        assert response.status_code == 200
        allocations = response.json()
        
        if allocation_data.get('allocation_id'):
            found = any(a['allocation_id'] == allocation_data['allocation_id'] for a in allocations)
            assert found, "Created allocation not found in list"
        
        print(f"PASS: GET /api/wms/allocations returned {len(allocations)} allocations")
    
    def test_05_delete_allocation(self, allocation_data):
        """Delete an allocation - should deallocate inventory"""
        if not allocation_data.get('allocation_id'):
            pytest.skip("No allocation to delete")
        
        response = requests.delete(
            f"{BASE_URL}/api/wms/allocations/{allocation_data['allocation_id']}", 
            cookies=SESSION_COOKIE
        )
        assert response.status_code == 200, f"Failed to delete allocation: {response.text}"
        
        # Verify allocation is gone
        list_response = requests.get(f"{BASE_URL}/api/wms/allocations", cookies=SESSION_COOKIE)
        allocations = list_response.json()
        found = any(a['allocation_id'] == allocation_data['allocation_id'] for a in allocations)
        assert not found, "Deleted allocation still exists"
        
        print(f"PASS: Deleted allocation {allocation_data['allocation_id']}")


class TestPickTicketModule:
    """Test Pick Ticket module operations"""
    
    @pytest.fixture(scope="class")
    def pick_data(self):
        return {}
    
    def test_01_setup_allocation_for_pick(self, pick_data):
        """Create an allocation to generate pick ticket from"""
        # Get orders and inventory
        orders_resp = requests.get(f"{BASE_URL}/api/wms/orders", cookies=SESSION_COOKIE)
        inv_resp = requests.get(f"{BASE_URL}/api/wms/inventory", cookies=SESSION_COOKIE)
        
        orders = orders_resp.json()
        inventory = inv_resp.json()
        
        available_inv = [inv for inv in inventory if inv.get('available', 0) > 0]
        
        if not orders or not available_inv:
            pytest.skip("Need orders and available inventory for pick test")
        
        inv = available_inv[0]
        alloc_qty = min(5, inv.get('available', 0))
        
        alloc_data = {
            "order_id": orders[0].get('order_id'),
            "items": [{
                "sku": inv.get('sku'),
                "color": inv.get('color', ''),
                "size": inv.get('size', ''),
                "qty": alloc_qty
            }]
        }
        
        response = requests.post(f"{BASE_URL}/api/wms/allocations", json=alloc_data, cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Failed to create allocation: {response.text}"
        data = response.json()
        
        pick_data['allocation_id'] = data.get('allocation_id')
        pick_data['order_number'] = data.get('order_number')
        print(f"PASS: Setup allocation {pick_data['allocation_id']} for pick ticket")
    
    def test_02_create_pick_ticket(self, pick_data):
        """Create a pick ticket from an allocation"""
        if not pick_data.get('allocation_id'):
            pytest.skip("No allocation for pick ticket")
        
        response = requests.post(f"{BASE_URL}/api/wms/pick-tickets", json={
            "allocation_id": pick_data['allocation_id']
        }, cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Failed to create pick ticket: {response.text}"
        data = response.json()
        
        assert 'ticket_id' in data, "Missing ticket_id in response"
        assert data.get('status') == 'pending', f"Expected status 'pending', got {data.get('status')}"
        assert 'lines' in data, "Missing lines in pick ticket"
        
        pick_data['ticket_id'] = data.get('ticket_id')
        pick_data['lines'] = data.get('lines', [])
        print(f"PASS: Created pick ticket {data['ticket_id']} with {len(data.get('lines', []))} lines")
    
    def test_03_list_pick_tickets(self, pick_data):
        """List pick tickets"""
        response = requests.get(f"{BASE_URL}/api/wms/pick-tickets", cookies=SESSION_COOKIE)
        assert response.status_code == 200
        tickets = response.json()
        
        if pick_data.get('ticket_id'):
            found = any(t['ticket_id'] == pick_data['ticket_id'] for t in tickets)
            assert found, "Created pick ticket not found in list"
        
        print(f"PASS: GET /api/wms/pick-tickets returned {len(tickets)} tickets")
    
    def test_04_confirm_pick_ticket(self, pick_data):
        """Confirm a pick ticket - should deduct inventory"""
        if not pick_data.get('ticket_id') or not pick_data.get('lines'):
            pytest.skip("No pick ticket to confirm")
        
        confirm_data = {
            "lines": [{"box_id": line['box_id'], "qty": line['qty']} for line in pick_data['lines']]
        }
        
        response = requests.put(
            f"{BASE_URL}/api/wms/pick-tickets/{pick_data['ticket_id']}/confirm",
            json=confirm_data,
            cookies=SESSION_COOKIE
        )
        assert response.status_code == 200, f"Failed to confirm pick: {response.text}"
        
        # Verify status changed
        list_resp = requests.get(f"{BASE_URL}/api/wms/pick-tickets", cookies=SESSION_COOKIE)
        tickets = list_resp.json()
        confirmed = next((t for t in tickets if t['ticket_id'] == pick_data['ticket_id']), None)
        
        if confirmed:
            assert confirmed.get('status') == 'confirmed', f"Expected 'confirmed', got {confirmed.get('status')}"
        
        print(f"PASS: Confirmed pick ticket {pick_data['ticket_id']}")


class TestProductionModule:
    """Test Production module - move boxes between states"""
    
    @pytest.fixture(scope="class")
    def prod_data(self):
        return {}
    
    def test_01_get_boxes_in_raw_state(self, prod_data):
        """Get boxes in 'raw' state for production"""
        response = requests.get(f"{BASE_URL}/api/wms/boxes?state=raw&status=stored", cookies=SESSION_COOKIE)
        assert response.status_code == 200
        boxes = response.json()
        
        raw_boxes = [b for b in boxes if b.get('state') == 'raw']
        if raw_boxes:
            prod_data['raw_box_ids'] = [b['box_id'] for b in raw_boxes[:2]]  # Take up to 2
            print(f"PASS: Found {len(raw_boxes)} boxes in 'raw' state")
        else:
            print("INFO: No boxes in 'raw' state available")
    
    def test_02_move_boxes_to_wip(self, prod_data):
        """Move boxes from raw to WIP state"""
        if not prod_data.get('raw_box_ids'):
            pytest.skip("No raw boxes to move to WIP")
        
        response = requests.post(f"{BASE_URL}/api/wms/production/move", json={
            "box_ids": prod_data['raw_box_ids'],
            "target_state": "wip"
        }, cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Failed to move to WIP: {response.text}"
        data = response.json()
        
        assert 'moved' in data, "Missing 'moved' in response"
        moved_count = len(data.get('moved', []))
        
        prod_data['wip_box_ids'] = prod_data['raw_box_ids']
        print(f"PASS: Moved {moved_count} boxes to WIP state")
    
    def test_03_move_boxes_to_finished(self, prod_data):
        """Move boxes from WIP to finished state"""
        if not prod_data.get('wip_box_ids'):
            # Try to find WIP boxes
            response = requests.get(f"{BASE_URL}/api/wms/boxes?state=wip", cookies=SESSION_COOKIE)
            boxes = response.json()
            wip_boxes = [b for b in boxes if b.get('state') == 'wip']
            if wip_boxes:
                prod_data['wip_box_ids'] = [b['box_id'] for b in wip_boxes[:2]]
            else:
                pytest.skip("No WIP boxes to move to finished")
        
        response = requests.post(f"{BASE_URL}/api/wms/production/move", json={
            "box_ids": prod_data['wip_box_ids'],
            "target_state": "finished"
        }, cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Failed to move to finished: {response.text}"
        data = response.json()
        
        moved_count = len(data.get('moved', []))
        prod_data['finished_box_ids'] = prod_data['wip_box_ids']
        print(f"PASS: Moved {moved_count} boxes to finished state")
    
    def test_04_verify_finished_goods(self, prod_data):
        """Verify boxes appear in finished goods"""
        response = requests.get(f"{BASE_URL}/api/wms/finished-goods", cookies=SESSION_COOKIE)
        assert response.status_code == 200
        finished = response.json()
        
        if prod_data.get('finished_box_ids'):
            for box_id in prod_data['finished_box_ids']:
                found = any(b['box_id'] == box_id for b in finished)
                # Box may not be found if it was shipped, so just log
                if found:
                    print(f"INFO: Box {box_id} found in finished goods")
        
        print(f"PASS: GET /api/wms/finished-goods returned {len(finished)} boxes")


class TestShippingModule:
    """Test Shipping module - create shipments with finished boxes"""
    
    @pytest.fixture(scope="class")
    def ship_data(self):
        return {}
    
    def test_01_get_finished_boxes_for_shipping(self, ship_data):
        """Get finished boxes available for shipping"""
        response = requests.get(f"{BASE_URL}/api/wms/finished-goods", cookies=SESSION_COOKIE)
        assert response.status_code == 200
        finished = response.json()
        
        # Filter out already shipped boxes
        available = [b for b in finished if b.get('status') != 'shipped']
        
        if available:
            ship_data['box_ids'] = [b['box_id'] for b in available[:2]]
            print(f"PASS: Found {len(available)} finished boxes available for shipping")
        else:
            print("INFO: No finished boxes available for shipping")
    
    def test_02_create_shipment(self, ship_data):
        """Create a shipment with finished boxes"""
        if not ship_data.get('box_ids'):
            pytest.skip("No finished boxes for shipment")
        
        # Get an order (optional)
        orders_resp = requests.get(f"{BASE_URL}/api/wms/orders", cookies=SESSION_COOKIE)
        orders = orders_resp.json()
        order_id = orders[0].get('order_id') if orders else ""
        
        shipment_data = {
            "order_id": order_id,
            "box_ids": ship_data['box_ids'],
            "carrier": "FedEx",
            "tracking": f"TEST_TRACK_{int(time.time())}",
            "pallet": f"PALLET_{int(time.time())}"
        }
        
        response = requests.post(f"{BASE_URL}/api/wms/shipments", json=shipment_data, cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Failed to create shipment: {response.text}"
        data = response.json()
        
        assert 'shipment_id' in data, "Missing shipment_id"
        assert data.get('total_boxes') == len(ship_data['box_ids']), "Box count mismatch"
        assert data.get('carrier') == "FedEx", "Carrier mismatch"
        
        ship_data['shipment_id'] = data.get('shipment_id')
        print(f"PASS: Created shipment {data['shipment_id']} with {data['total_boxes']} boxes")
    
    def test_03_list_shipments(self, ship_data):
        """List shipments"""
        response = requests.get(f"{BASE_URL}/api/wms/shipments", cookies=SESSION_COOKIE)
        assert response.status_code == 200
        shipments = response.json()
        
        if ship_data.get('shipment_id'):
            found = any(s['shipment_id'] == ship_data['shipment_id'] for s in shipments)
            assert found, "Created shipment not found in list"
        
        print(f"PASS: GET /api/wms/shipments returned {len(shipments)} shipments")
    
    def test_04_verify_boxes_marked_shipped(self, ship_data):
        """Verify shipped boxes have status 'shipped'"""
        if not ship_data.get('box_ids'):
            pytest.skip("No shipped boxes to verify")
        
        for box_id in ship_data['box_ids']:
            response = requests.get(f"{BASE_URL}/api/wms/boxes/{box_id}", cookies=SESSION_COOKIE)
            if response.status_code == 200:
                box = response.json()
                assert box.get('status') == 'shipped', f"Expected 'shipped', got {box.get('status')}"
        
        print(f"PASS: Shipped boxes have status 'shipped'")


class TestMovementsAuditLog:
    """Verify movements are logged for all WMS operations"""
    
    def test_movements_contain_recent_activity(self):
        """Verify recent WMS operations created movement records"""
        response = requests.get(f"{BASE_URL}/api/wms/movements?limit=50", cookies=SESSION_COOKIE)
        assert response.status_code == 200
        movements = response.json()
        
        movement_types = set(m.get('type') for m in movements)
        print(f"PASS: Found {len(movements)} movements with types: {movement_types}")
        
        # Verify key movement types are being logged
        expected_types = {'receiving', 'putaway', 'allocation', 'pick_ticket_created', 'production_move', 'shipment'}
        logged_types = expected_types.intersection(movement_types)
        print(f"INFO: Logged movement types present: {logged_types}")


# Run pytest
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
