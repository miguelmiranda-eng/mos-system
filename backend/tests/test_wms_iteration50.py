"""
WMS (Warehouse Management System) comprehensive test suite.
Tests all 11 modules: Receiving, Labeling, Putaway, Inventory, Orders, Allocation, 
Picking, Production, Finished Goods, Shipping, Movements.
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_COOKIE = {"session_token": "test_admin_sess"}


class TestWMSLocations:
    """Test WMS Location CRUD operations"""
    
    def test_list_locations(self):
        """GET /api/wms/locations should return list of locations"""
        response = requests.get(f"{BASE_URL}/api/wms/locations", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        # Check existing test data
        location_names = [loc.get('name') for loc in data]
        assert 'A-01-01' in location_names, "Expected test location A-01-01 to exist"
        print(f"PASS: GET /api/wms/locations returned {len(data)} locations")
    
    def test_create_location(self):
        """POST /api/wms/locations should create new location"""
        new_loc = {
            "name": f"TEST_LOC_{int(time.time())}",
            "zone": "TEST_ZONE",
            "type": "rack"
        }
        response = requests.post(f"{BASE_URL}/api/wms/locations", json=new_loc, cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert data.get('name') == new_loc['name'], "Location name mismatch"
        assert data.get('zone') == new_loc['zone'], "Location zone mismatch"
        assert 'location_id' in data, "Expected location_id in response"
        print(f"PASS: Created location {data.get('name')} with ID {data.get('location_id')}")
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/wms/locations/{data['location_id']}", cookies=SESSION_COOKIE)
    
    def test_create_duplicate_location_fails(self):
        """POST /api/wms/locations should fail for duplicate name"""
        response = requests.post(f"{BASE_URL}/api/wms/locations", json={"name": "A-01-01"}, cookies=SESSION_COOKIE)
        assert response.status_code == 400, f"Expected 400 for duplicate, got {response.status_code}"
        print("PASS: Duplicate location creation correctly rejected")


class TestWMSReceiving:
    """Test WMS Receiving operations"""
    
    def test_list_receiving(self):
        """GET /api/wms/receiving should return receiving records"""
        response = requests.get(f"{BASE_URL}/api/wms/receiving", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        # Check existing test data
        po_numbers = [r.get('po') for r in data]
        assert 'PO-1001' in po_numbers, "Expected test receiving PO-1001 to exist"
        print(f"PASS: GET /api/wms/receiving returned {len(data)} records")
    
    def test_get_receiving_details(self):
        """GET /api/wms/receiving/{id} should return receiving with boxes"""
        # First get list to find an ID
        list_response = requests.get(f"{BASE_URL}/api/wms/receiving", cookies=SESSION_COOKIE)
        records = list_response.json()
        if records:
            receiving_id = records[0].get('receiving_id')
            response = requests.get(f"{BASE_URL}/api/wms/receiving/{receiving_id}", cookies=SESSION_COOKIE)
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            data = response.json()
            assert 'boxes' in data, "Expected boxes in receiving details"
            assert 'po' in data, "Expected po in receiving details"
            print(f"PASS: GET /api/wms/receiving/{receiving_id} returned receiving with {len(data.get('boxes', []))} boxes")
    
    def test_create_receiving_with_auto_boxes(self):
        """POST /api/wms/receiving should create receiving and auto-generate boxes"""
        new_receiving = {
            "po": f"TEST_PO_{int(time.time())}",
            "vendor": "TEST_VENDOR",
            "items": [{
                "sku": "TEST_SKU_001",
                "color": "Blue",
                "size": "L",
                "boxes": 2,
                "units_per_box": 25
            }]
        }
        response = requests.post(f"{BASE_URL}/api/wms/receiving", json=new_receiving, cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert data.get('po') == new_receiving['po'], "PO mismatch"
        assert data.get('total_boxes') == 2, f"Expected 2 boxes, got {data.get('total_boxes')}"
        assert data.get('total_units') == 50, f"Expected 50 units, got {data.get('total_units')}"
        assert 'boxes' in data, "Expected boxes in response"
        assert len(data.get('boxes', [])) == 2, "Expected 2 box records"
        # Verify box IDs are generated
        for box in data.get('boxes', []):
            assert box.get('box_id', '').startswith('BOX-'), f"Expected BOX- prefix, got {box.get('box_id')}"
        print(f"PASS: Created receiving {data.get('receiving_id')} with {data.get('total_boxes')} boxes")


class TestWMSBoxes:
    """Test WMS Boxes operations"""
    
    def test_list_boxes(self):
        """GET /api/wms/boxes should return list of boxes"""
        response = requests.get(f"{BASE_URL}/api/wms/boxes", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        print(f"PASS: GET /api/wms/boxes returned {len(data)} boxes")
    
    def test_list_boxes_with_filters(self):
        """GET /api/wms/boxes with filters should filter results"""
        response = requests.get(f"{BASE_URL}/api/wms/boxes?sku=SKU-100", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        # All boxes should have matching SKU
        for box in data:
            assert 'SKU-100' in box.get('sku', '').upper(), f"Filter not working: {box.get('sku')}"
        print(f"PASS: GET /api/wms/boxes with SKU filter returned {len(data)} boxes")
    
    def test_get_single_box(self):
        """GET /api/wms/boxes/{box_id} should return box details"""
        # Get any existing box
        list_response = requests.get(f"{BASE_URL}/api/wms/boxes", cookies=SESSION_COOKIE)
        boxes = list_response.json()
        if boxes:
            box_id = boxes[0].get('box_id')
            response = requests.get(f"{BASE_URL}/api/wms/boxes/{box_id}", cookies=SESSION_COOKIE)
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            data = response.json()
            assert data.get('box_id') == box_id, "Box ID mismatch"
            print(f"PASS: GET /api/wms/boxes/{box_id} returned box details")


class TestWMSPutaway:
    """Test WMS Putaway operations"""
    
    def test_putaway_box(self):
        """POST /api/wms/putaway should assign box to location"""
        # Get a box that's received but not stored
        boxes_response = requests.get(f"{BASE_URL}/api/wms/boxes?status=received", cookies=SESSION_COOKIE)
        boxes = boxes_response.json()
        
        if boxes:
            box_id = boxes[0].get('box_id')
            putaway_data = {
                "box_id": box_id,
                "location": "A-01-01"  # Use existing location
            }
            response = requests.post(f"{BASE_URL}/api/wms/putaway", json=putaway_data, cookies=SESSION_COOKIE)
            assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
            data = response.json()
            assert data.get('box_id') == box_id, "Box ID mismatch in response"
            assert data.get('location') == "A-01-01", "Location mismatch"
            print(f"PASS: Putaway box {box_id} to location A-01-01")
        else:
            print("SKIP: No received boxes available for putaway test")
    
    def test_putaway_invalid_box_fails(self):
        """POST /api/wms/putaway with invalid box should fail"""
        response = requests.post(f"{BASE_URL}/api/wms/putaway", json={
            "box_id": "INVALID_BOX_12345",
            "location": "A-01-01"
        }, cookies=SESSION_COOKIE)
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        print("PASS: Putaway with invalid box correctly rejected")
    
    def test_putaway_invalid_location_fails(self):
        """POST /api/wms/putaway with invalid location should fail"""
        # Get any existing box
        boxes_response = requests.get(f"{BASE_URL}/api/wms/boxes", cookies=SESSION_COOKIE)
        boxes = boxes_response.json()
        if boxes:
            response = requests.post(f"{BASE_URL}/api/wms/putaway", json={
                "box_id": boxes[0].get('box_id'),
                "location": "INVALID_LOCATION_999"
            }, cookies=SESSION_COOKIE)
            assert response.status_code == 404, f"Expected 404, got {response.status_code}"
            print("PASS: Putaway with invalid location correctly rejected")


class TestWMSInventory:
    """Test WMS Inventory operations"""
    
    def test_list_inventory(self):
        """GET /api/wms/inventory should return inventory with quantities"""
        response = requests.get(f"{BASE_URL}/api/wms/inventory", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        # Verify inventory has required fields
        for inv in data:
            assert 'sku' in inv, "Missing sku field"
            assert 'on_hand' in inv, "Missing on_hand field"
            assert 'allocated' in inv, "Missing allocated field"
            assert 'available' in inv, "Missing available field"
        print(f"PASS: GET /api/wms/inventory returned {len(data)} SKUs")
    
    def test_inventory_summary(self):
        """GET /api/wms/inventory/summary should return totals"""
        response = requests.get(f"{BASE_URL}/api/wms/inventory/summary", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        # Verify summary has required fields
        assert 'total_on_hand' in data, "Missing total_on_hand"
        assert 'total_allocated' in data, "Missing total_allocated"
        assert 'total_available' in data, "Missing total_available"
        assert 'total_skus' in data, "Missing total_skus"
        assert 'total_boxes' in data, "Missing total_boxes"
        assert 'total_locations' in data, "Missing total_locations"
        print(f"PASS: Inventory summary - On Hand: {data.get('total_on_hand')}, Available: {data.get('total_available')}")


class TestWMSOrders:
    """Test WMS Orders (from CRM) operations"""
    
    def test_list_wms_orders(self):
        """GET /api/wms/orders should return CRM orders"""
        response = requests.get(f"{BASE_URL}/api/wms/orders", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        print(f"PASS: GET /api/wms/orders returned {len(data)} orders from CRM")
    
    def test_get_wms_order_details(self):
        """GET /api/wms/orders/{order_id} should return order with allocations"""
        # Get list to find an order
        list_response = requests.get(f"{BASE_URL}/api/wms/orders", cookies=SESSION_COOKIE)
        orders = list_response.json()
        if orders:
            order_id = orders[0].get('order_id')
            response = requests.get(f"{BASE_URL}/api/wms/orders/{order_id}", cookies=SESSION_COOKIE)
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            data = response.json()
            assert 'allocations' in data, "Expected allocations field in order details"
            print(f"PASS: GET /api/wms/orders/{order_id} returned order details")


class TestWMSAllocations:
    """Test WMS Allocation operations"""
    
    def test_list_allocations(self):
        """GET /api/wms/allocations should return allocation records"""
        response = requests.get(f"{BASE_URL}/api/wms/allocations", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        print(f"PASS: GET /api/wms/allocations returned {len(data)} allocations")
    
    def test_create_allocation_insufficient_inventory_fails(self):
        """POST /api/wms/allocations should fail for insufficient inventory"""
        # Get an order
        orders_response = requests.get(f"{BASE_URL}/api/wms/orders", cookies=SESSION_COOKIE)
        orders = orders_response.json()
        if orders:
            order_id = orders[0].get('order_id')
            # Try to allocate more than available
            alloc_data = {
                "order_id": order_id,
                "items": [{
                    "sku": "NONEXISTENT_SKU",
                    "color": "X",
                    "size": "X",
                    "qty": 999999
                }]
            }
            response = requests.post(f"{BASE_URL}/api/wms/allocations", json=alloc_data, cookies=SESSION_COOKIE)
            assert response.status_code == 400, f"Expected 400, got {response.status_code}"
            print("PASS: Allocation with insufficient inventory correctly rejected")


class TestWMSPickTickets:
    """Test WMS Pick Ticket operations"""
    
    def test_list_pick_tickets(self):
        """GET /api/wms/pick-tickets should return pick tickets"""
        response = requests.get(f"{BASE_URL}/api/wms/pick-tickets", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        print(f"PASS: GET /api/wms/pick-tickets returned {len(data)} tickets")
    
    def test_create_pick_ticket_invalid_allocation_fails(self):
        """POST /api/wms/pick-tickets should fail for invalid allocation"""
        response = requests.post(f"{BASE_URL}/api/wms/pick-tickets", json={
            "allocation_id": "INVALID_ALLOC_12345"
        }, cookies=SESSION_COOKIE)
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        print("PASS: Pick ticket creation with invalid allocation correctly rejected")


class TestWMSProduction:
    """Test WMS Production operations"""
    
    def test_list_production(self):
        """GET /api/wms/production should return production boxes"""
        response = requests.get(f"{BASE_URL}/api/wms/production", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        print(f"PASS: GET /api/wms/production returned {len(data)} boxes in production")
    
    def test_production_move_invalid_state_fails(self):
        """POST /api/wms/production/move should fail for invalid state"""
        response = requests.post(f"{BASE_URL}/api/wms/production/move", json={
            "box_ids": ["BOX-000001"],
            "target_state": "invalid_state"
        }, cookies=SESSION_COOKIE)
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        print("PASS: Production move with invalid state correctly rejected")


class TestWMSFinishedGoods:
    """Test WMS Finished Goods operations"""
    
    def test_list_finished_goods(self):
        """GET /api/wms/finished-goods should return finished boxes"""
        response = requests.get(f"{BASE_URL}/api/wms/finished-goods", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        print(f"PASS: GET /api/wms/finished-goods returned {len(data)} finished boxes")


class TestWMSShipments:
    """Test WMS Shipment operations"""
    
    def test_list_shipments(self):
        """GET /api/wms/shipments should return shipment records"""
        response = requests.get(f"{BASE_URL}/api/wms/shipments", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        print(f"PASS: GET /api/wms/shipments returned {len(data)} shipments")
    
    def test_create_shipment_requires_box_ids(self):
        """POST /api/wms/shipments should fail without box_ids"""
        response = requests.post(f"{BASE_URL}/api/wms/shipments", json={
            "order_id": "test",
            "box_ids": []  # Empty
        }, cookies=SESSION_COOKIE)
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        print("PASS: Shipment creation without box_ids correctly rejected")


class TestWMSMovements:
    """Test WMS Movements (Audit Log) operations"""
    
    def test_list_movements(self):
        """GET /api/wms/movements should return audit log"""
        response = requests.get(f"{BASE_URL}/api/wms/movements", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Expected list response"
        # Verify movement has required fields
        for mov in data:
            assert 'movement_id' in mov, "Missing movement_id"
            assert 'type' in mov, "Missing type"
            assert 'details' in mov, "Missing details"
            assert 'created_at' in mov, "Missing created_at"
        print(f"PASS: GET /api/wms/movements returned {len(data)} movements")
    
    def test_list_movements_filtered_by_type(self):
        """GET /api/wms/movements with type filter should filter results"""
        response = requests.get(f"{BASE_URL}/api/wms/movements?movement_type=receiving", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        for mov in data:
            assert mov.get('type') == 'receiving', f"Filter not working: {mov.get('type')}"
        print(f"PASS: GET /api/wms/movements with type filter returned {len(data)} movements")


class TestWMSLabels:
    """Test WMS Label generation (PDF)"""
    
    def test_generate_box_label_pdf(self):
        """GET /api/wms/labels/box/{box_id} should return PDF"""
        # Get any existing box
        boxes_response = requests.get(f"{BASE_URL}/api/wms/boxes", cookies=SESSION_COOKIE)
        boxes = boxes_response.json()
        if boxes:
            box_id = boxes[0].get('box_id')
            response = requests.get(f"{BASE_URL}/api/wms/labels/box/{box_id}", cookies=SESSION_COOKIE)
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            assert 'application/pdf' in response.headers.get('Content-Type', ''), "Expected PDF content type"
            assert len(response.content) > 100, "Expected PDF content"
            print(f"PASS: GET /api/wms/labels/box/{box_id} returned PDF label")
    
    def test_generate_box_label_invalid_box_fails(self):
        """GET /api/wms/labels/box/{box_id} should fail for invalid box"""
        response = requests.get(f"{BASE_URL}/api/wms/labels/box/INVALID_BOX_999", cookies=SESSION_COOKIE)
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        print("PASS: Label generation for invalid box correctly rejected")


class TestWMSExport:
    """Test WMS Export operations"""
    
    def test_export_inventory_excel(self):
        """GET /api/wms/export/inventory should return Excel file"""
        response = requests.get(f"{BASE_URL}/api/wms/export/inventory", cookies=SESSION_COOKIE)
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert 'spreadsheetml' in response.headers.get('Content-Type', ''), f"Expected Excel content type, got {response.headers.get('Content-Type')}"
        assert len(response.content) > 100, "Expected Excel content"
        print("PASS: GET /api/wms/export/inventory returned Excel file")


class TestWMSAuthRequired:
    """Test that WMS endpoints require authentication"""
    
    def test_locations_without_auth_fails(self):
        """GET /api/wms/locations without auth should fail"""
        response = requests.get(f"{BASE_URL}/api/wms/locations")  # No cookies
        assert response.status_code in [401, 403], f"Expected 401/403, got {response.status_code}"
        print("PASS: WMS endpoints require authentication")


# Run pytest
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
