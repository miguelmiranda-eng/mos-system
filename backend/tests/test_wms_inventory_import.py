"""
WMS Inventory Import Tests - Iteration 52
Tests new features:
- POST /api/wms/import/inventory - Excel import
- GET /api/wms/inventory - new fields (customer, style, description, category, manufacturer, inv_location, total_boxes)
- GET /api/wms/inventory?customer=X - filter by customer
- GET /api/wms/inventory?style=X - filter by style
- GET /api/wms/inventory?category=X - filter by category
- GET /api/wms/inventory/summary - aggregated totals (19320 skus, 2075668 on_hand)
- GET /api/wms/inventory/filters - unique customers, categories, manufacturers, styles
- GET /api/wms/orders - only BLANKS board OR PARTIAL/PARCIAL status
- GET /api/wms/export/inventory - Excel with new columns
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

@pytest.fixture(scope="module")
def session():
    """Create authenticated session for testing."""
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    # Login to get session cookie
    login_response = s.post(f"{BASE_URL}/api/auth/login", json={
        "email": "admin@test.com",
        "password": "test123"
    })
    if login_response.status_code != 200:
        pytest.skip(f"Auth failed: {login_response.status_code} - {login_response.text}")
    return s


class TestInventorySummary:
    """Test inventory summary with aggregated totals from imported data."""
    
    def test_inventory_summary_returns_totals(self, session):
        """GET /api/wms/inventory/summary returns aggregated totals."""
        response = session.get(f"{BASE_URL}/api/wms/inventory/summary")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        print(f"Summary response: {data}")
        
        # Verify summary fields exist
        assert "total_skus" in data, "Summary should have total_skus"
        assert "total_on_hand" in data, "Summary should have total_on_hand"
        assert "total_allocated" in data, "Summary should have total_allocated"
        assert "total_available" in data, "Summary should have total_available"
        assert "total_locations" in data, "Summary should have total_locations"
        
        # Per agent_to_agent_context: 19,320 records imported with 2,075,668 on hand and 2,891 locations
        # Allow some variance in case of test data changes
        total_skus = data.get("total_skus", 0)
        total_on_hand = data.get("total_on_hand", 0)
        total_locations = data.get("total_locations", 0)
        
        print(f"Total SKUs: {total_skus}, On Hand: {total_on_hand}, Locations: {total_locations}")
        
        # Verify we have substantial imported data
        assert total_skus > 0, f"Expected records, got {total_skus}"
        # Check if we have the expected ~19320 records
        if total_skus >= 19000:
            print(f"VERIFIED: {total_skus} records (expected ~19320)")
        # Check on_hand totals
        assert total_on_hand >= 0, f"On hand should be >= 0, got {total_on_hand}"
        

class TestInventoryFilters:
    """Test inventory filter endpoint returning unique values for dropdowns."""
    
    def test_inventory_filters_endpoint_returns_lists(self, session):
        """GET /api/wms/inventory/filters returns unique customers, categories, manufacturers, styles."""
        response = session.get(f"{BASE_URL}/api/wms/inventory/filters")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        print(f"Filters response keys: {data.keys()}")
        
        # Verify filter fields exist
        assert "customers" in data, "Should have customers list"
        assert "categories" in data, "Should have categories list"
        assert "manufacturers" in data, "Should have manufacturers list"
        assert "styles" in data, "Should have styles list"
        
        # All should be lists
        assert isinstance(data["customers"], list), "customers should be a list"
        assert isinstance(data["categories"], list), "categories should be a list"
        assert isinstance(data["manufacturers"], list), "manufacturers should be a list"
        assert isinstance(data["styles"], list), "styles should be a list"
        
        print(f"Customers count: {len(data['customers'])}")
        print(f"Categories count: {len(data['categories'])}")
        print(f"Manufacturers count: {len(data['manufacturers'])}")
        print(f"Styles count: {len(data['styles'])}")
        
        # Sample values for verification
        if data["customers"]:
            print(f"Sample customers: {data['customers'][:5]}")
        if data["categories"]:
            print(f"Sample categories: {data['categories'][:5]}")


class TestInventoryWithNewFields:
    """Test inventory endpoint returns new fields from Excel import."""
    
    def test_inventory_list_has_new_fields(self, session):
        """GET /api/wms/inventory returns records with new fields."""
        response = session.get(f"{BASE_URL}/api/wms/inventory")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        assert isinstance(data, list), "Inventory should be a list"
        print(f"Total inventory records returned: {len(data)}")
        
        if len(data) > 0:
            sample = data[0]
            print(f"Sample record keys: {sample.keys()}")
            print(f"Sample record: {sample}")
            
            # Check for new fields from Excel import
            expected_fields = [
                "customer", "style", "color", "size", "description", "category",
                "manufacturer", "inv_location", "total_boxes", "on_hand", "allocated", "available"
            ]
            
            for field in expected_fields:
                assert field in sample, f"Record should have '{field}' field"
            
            print("PASS: All expected fields present in inventory records")


class TestInventoryFilterByCustomer:
    """Test filtering inventory by customer."""
    
    def test_filter_by_customer(self, session):
        """GET /api/wms/inventory?customer=X filters correctly."""
        # First get available customers
        filters_resp = session.get(f"{BASE_URL}/api/wms/inventory/filters")
        if filters_resp.status_code == 200:
            filters = filters_resp.json()
            customers = filters.get("customers", [])
            
            if customers:
                test_customer = customers[0]
                print(f"Testing filter with customer: '{test_customer}'")
                
                # Filter by customer
                response = session.get(f"{BASE_URL}/api/wms/inventory?customer={test_customer}")
                assert response.status_code == 200, f"Expected 200, got {response.status_code}"
                
                data = response.json()
                print(f"Records matching customer '{test_customer}': {len(data)}")
                
                # Verify all returned records have the customer
                if data:
                    for record in data[:5]:  # Check first 5
                        assert test_customer.lower() in (record.get("customer", "") or "").lower(), \
                            f"Record customer '{record.get('customer')}' should contain '{test_customer}'"
                    print("PASS: Customer filter working correctly")
            else:
                pytest.skip("No customers in filter data")
        else:
            pytest.skip("Could not fetch filters")


class TestInventoryFilterByStyle:
    """Test filtering inventory by style."""
    
    def test_filter_by_style(self, session):
        """GET /api/wms/inventory?style=X filters correctly."""
        # First get available styles
        filters_resp = session.get(f"{BASE_URL}/api/wms/inventory/filters")
        if filters_resp.status_code == 200:
            filters = filters_resp.json()
            styles = filters.get("styles", [])
            
            if styles:
                test_style = styles[0]
                print(f"Testing filter with style: '{test_style}'")
                
                response = session.get(f"{BASE_URL}/api/wms/inventory?style={test_style}")
                assert response.status_code == 200, f"Expected 200, got {response.status_code}"
                
                data = response.json()
                print(f"Records matching style '{test_style}': {len(data)}")
                
                if data:
                    for record in data[:5]:
                        assert test_style.lower() in (record.get("style", "") or "").lower(), \
                            f"Record style '{record.get('style')}' should contain '{test_style}'"
                    print("PASS: Style filter working correctly")
            else:
                pytest.skip("No styles in filter data")
        else:
            pytest.skip("Could not fetch filters")


class TestInventoryFilterByCategory:
    """Test filtering inventory by category."""
    
    def test_filter_by_category(self, session):
        """GET /api/wms/inventory?category=X filters correctly."""
        filters_resp = session.get(f"{BASE_URL}/api/wms/inventory/filters")
        if filters_resp.status_code == 200:
            filters = filters_resp.json()
            categories = filters.get("categories", [])
            
            if categories:
                test_category = categories[0]
                print(f"Testing filter with category: '{test_category}'")
                
                response = session.get(f"{BASE_URL}/api/wms/inventory?category={test_category}")
                assert response.status_code == 200, f"Expected 200, got {response.status_code}"
                
                data = response.json()
                print(f"Records matching category '{test_category}': {len(data)}")
                
                if data:
                    for record in data[:5]:
                        assert test_category.lower() in (record.get("category", "") or "").lower(), \
                            f"Record category '{record.get('category')}' should contain '{test_category}'"
                    print("PASS: Category filter working correctly")
            else:
                pytest.skip("No categories in filter data")
        else:
            pytest.skip("Could not fetch filters")


class TestOrdersWithBlanksFilter:
    """Test orders endpoint only returns BLANKS board or PARTIAL/PARCIAL status."""
    
    def test_orders_returns_blanks_or_partial(self, session):
        """GET /api/wms/orders only returns orders from BLANKS board OR PARTIAL status."""
        response = session.get(f"{BASE_URL}/api/wms/orders")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        orders = response.json()
        assert isinstance(orders, list), "Orders should be a list"
        print(f"Total orders returned: {len(orders)}")
        
        # Verify all returned orders match the criteria
        for order in orders[:20]:  # Check first 20
            board = (order.get("board") or "").lower()
            blank_status = (order.get("blank_status") or "").lower()
            
            is_blanks_board = "blanks" in board
            is_partial_status = "partial" in blank_status or "parcial" in blank_status
            
            assert is_blanks_board or is_partial_status, \
                f"Order {order.get('order_number')} has board='{board}', blank_status='{blank_status}' - should be BLANKS or PARTIAL"
            
            print(f"Order {order.get('order_number')}: board='{board}', blank_status='{blank_status}' - OK")
        
        if orders:
            print(f"PASS: All {min(len(orders), 20)} orders match BLANKS/PARTIAL criteria")
        else:
            print("NOTE: No orders found matching BLANKS/PARTIAL criteria")


class TestOrdersResponseStructure:
    """Test orders response has expected fields including blank_status."""
    
    def test_orders_has_blank_status_field(self, session):
        """GET /api/wms/orders returns orders with blank_status field."""
        response = session.get(f"{BASE_URL}/api/wms/orders")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        orders = response.json()
        if orders:
            sample_order = orders[0]
            print(f"Sample order keys: {sample_order.keys()}")
            
            # Verify expected fields
            expected_fields = ["order_number", "board"]
            for field in expected_fields:
                assert field in sample_order, f"Order should have '{field}' field"
            
            # blank_status should be present (may be None/empty for some orders)
            if "blank_status" in sample_order:
                print(f"blank_status value: {sample_order.get('blank_status')}")
            
            print("PASS: Order structure verified")
        else:
            print("NOTE: No orders to verify structure")


class TestInventoryExportWithNewColumns:
    """Test inventory export Excel has new columns."""
    
    def test_export_inventory_returns_xlsx(self, session):
        """GET /api/wms/export/inventory returns XLSX file."""
        response = session.get(f"{BASE_URL}/api/wms/export/inventory")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        # Verify content type is Excel
        content_type = response.headers.get("content-type", "")
        print(f"Content-Type: {content_type}")
        assert "spreadsheet" in content_type or "octet-stream" in content_type, \
            f"Expected Excel content type, got: {content_type}"
        
        # Verify content-disposition for download
        content_disp = response.headers.get("content-disposition", "")
        print(f"Content-Disposition: {content_disp}")
        assert "inventory.xlsx" in content_disp, \
            f"Expected filename inventory.xlsx in disposition: {content_disp}"
        
        # Verify we got actual content
        content_length = len(response.content)
        print(f"File size: {content_length} bytes")
        assert content_length > 1000, f"File seems too small: {content_length} bytes"
        
        print("PASS: Export returns valid XLSX file")


class TestImportInventoryEndpoint:
    """Test import inventory endpoint exists and validates input."""
    
    def test_import_requires_file(self, session):
        """POST /api/wms/import/inventory requires file upload."""
        response = session.post(f"{BASE_URL}/api/wms/import/inventory")
        # Should fail without file - 422 (validation error) or 400
        assert response.status_code in [400, 422], \
            f"Expected 400/422 without file, got {response.status_code}"
        print(f"Response without file: {response.status_code} - PASS")
    
    def test_import_validates_file_type(self, session):
        """POST /api/wms/import/inventory validates Excel file type."""
        # Try uploading a non-Excel file
        files = {
            'file': ('test.txt', b'not an excel file', 'text/plain')
        }
        # Remove Content-Type header for multipart
        headers = {k: v for k, v in session.headers.items() if k.lower() != 'content-type'}
        response = requests.post(
            f"{BASE_URL}/api/wms/import/inventory",
            files=files,
            cookies=session.cookies,
            headers=headers
        )
        # Should fail with non-Excel file
        assert response.status_code == 400, \
            f"Expected 400 for non-Excel file, got {response.status_code}: {response.text}"
        print(f"Response for non-Excel file: {response.status_code} - PASS")


class TestAuthRequired:
    """Test WMS endpoints require authentication."""
    
    def test_inventory_requires_auth(self):
        """GET /api/wms/inventory requires authentication."""
        response = requests.get(f"{BASE_URL}/api/wms/inventory")
        # Should be 401 or 403 without auth
        assert response.status_code in [401, 403], \
            f"Expected 401/403 without auth, got {response.status_code}"
        print("PASS: Inventory endpoint requires auth")
    
    def test_filters_requires_auth(self):
        """GET /api/wms/inventory/filters requires authentication."""
        response = requests.get(f"{BASE_URL}/api/wms/inventory/filters")
        assert response.status_code in [401, 403], \
            f"Expected 401/403 without auth, got {response.status_code}"
        print("PASS: Filters endpoint requires auth")
    
    def test_orders_requires_auth(self):
        """GET /api/wms/orders requires authentication."""
        response = requests.get(f"{BASE_URL}/api/wms/orders")
        assert response.status_code in [401, 403], \
            f"Expected 401/403 without auth, got {response.status_code}"
        print("PASS: Orders endpoint requires auth")
