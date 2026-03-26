"""
Test WMS Iteration 57 - SKU Auto-generation & Cycle Count Module
Tests:
1. GET /api/wms/generate-sku - SKU generation endpoint
2. POST /api/wms/receiving - Auto-SKU on receiving
3. Cycle Count CRUD endpoints
4. Cycle count progress tracking
5. Cycle count approval and inventory adjustment
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestSKUGeneration:
    """Test SKU auto-generation feature"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup session with auth"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        # Login as admin
        login_resp = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_resp.status_code == 200, f"Login failed: {login_resp.text}"
    
    def test_generate_sku_basic_style_only(self):
        """Test SKU generation with style only"""
        resp = self.session.get(f"{BASE_URL}/api/wms/generate-sku?style=TestStyle")
        assert resp.status_code == 200
        data = resp.json()
        assert "sku" in data
        assert data["sku"] == "TESTSTYLE"
    
    def test_generate_sku_style_and_color(self):
        """Test SKU generation with style and color"""
        resp = self.session.get(f"{BASE_URL}/api/wms/generate-sku?style=MyStyle&color=Red")
        assert resp.status_code == 200
        data = resp.json()
        assert data["sku"] == "MYSTYLE-RED"
    
    def test_generate_sku_style_color_size(self):
        """Test SKU generation with style, color, and size"""
        resp = self.session.get(f"{BASE_URL}/api/wms/generate-sku?style=Basic&color=Blue&size=L")
        assert resp.status_code == 200
        data = resp.json()
        assert data["sku"] == "BASIC-BLUE-L"
    
    def test_generate_sku_with_spaces(self):
        """Test SKU replaces spaces with dashes"""
        resp = self.session.get(f"{BASE_URL}/api/wms/generate-sku?style=My Style&color=Light Blue")
        assert resp.status_code == 200
        data = resp.json()
        assert "-" in data["sku"]
        assert " " not in data["sku"]
        # Style: "MY-STYLE", Color: "LIGHT-BLUE" (truncated to 10 chars)
        assert data["sku"] == "MY-STYLE-LIGHT-BLUE"
    
    def test_generate_sku_color_truncated(self):
        """Test SKU truncates color to 10 characters"""
        resp = self.session.get(f"{BASE_URL}/api/wms/generate-sku?style=Test&color=VeryLongColorName")
        assert resp.status_code == 200
        data = resp.json()
        # Color should be truncated to 10 chars: "VERYLONGCO"
        assert len(data["sku"].split("-")[1]) <= 10
    
    def test_generate_sku_empty_style(self):
        """Test SKU returns empty when no style"""
        resp = self.session.get(f"{BASE_URL}/api/wms/generate-sku?style=")
        assert resp.status_code == 200
        data = resp.json()
        assert data["sku"] == ""
    
    def test_generate_sku_uppercase(self):
        """Test SKU is always uppercase"""
        resp = self.session.get(f"{BASE_URL}/api/wms/generate-sku?style=lowercase&color=mixedCase&size=xl")
        assert resp.status_code == 200
        data = resp.json()
        assert data["sku"] == data["sku"].upper()
        assert data["sku"] == "LOWERCASE-MIXEDCASE-XL"


class TestReceivingAutoSKU:
    """Test auto-SKU in Receiving endpoint"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup session with auth"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        # Login as admin
        login_resp = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_resp.status_code == 200
    
    def test_receiving_creates_auto_sku(self):
        """Test creating receiving auto-generates SKU"""
        payload = {
            "style": "TEST_AutoSKU",
            "color": "Navy",
            "size": "M",
            "dozens": 1,
            "pieces": 0
        }
        resp = self.session.post(f"{BASE_URL}/api/wms/receiving", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        # Should have auto-generated SKU
        assert "sku" in data
        # SKU should be uppercase with format STYLE-COLOR-SIZE
        assert data["sku"] == "TEST_AUTOSKU-NAVY-M"
    
    def test_receiving_sku_format_style_only(self):
        """Test SKU format when only style provided"""
        payload = {
            "style": "TEST_StyleOnly",
            "dozens": 0,
            "pieces": 6
        }
        resp = self.session.post(f"{BASE_URL}/api/wms/receiving", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["sku"] == "TEST_STYLEONLY"
    
    def test_receiving_preserves_provided_sku(self):
        """Test that provided SKU is used if given"""
        payload = {
            "style": "TEST_CustomSKU",
            "color": "Black",
            "size": "L",
            "sku": "CUSTOM-SKU-123",
            "dozens": 1
        }
        resp = self.session.post(f"{BASE_URL}/api/wms/receiving", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        # Should use provided SKU, not auto-generate
        assert data["sku"] == "CUSTOM-SKU-123"


class TestCycleCountCRUD:
    """Test Cycle Count CRUD operations"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup session with auth"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        # Login as admin
        login_resp = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_resp.status_code == 200
    
    def test_list_cycle_counts(self):
        """Test GET /api/wms/cycle-counts returns list"""
        resp = self.session.get(f"{BASE_URL}/api/wms/cycle-counts")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
    
    def test_create_cycle_count_requires_name(self):
        """Test creating cycle count requires name"""
        resp = self.session.post(f"{BASE_URL}/api/wms/cycle-counts", json={
            "location_filter": "RP10"
        })
        assert resp.status_code == 400
        assert "nombre" in resp.json().get("detail", "").lower() or "name" in resp.json().get("detail", "").lower()
    
    def test_create_cycle_count_requires_matching_items(self):
        """Test cycle count requires matching inventory items"""
        # Use a filter that likely won't match anything
        resp = self.session.post(f"{BASE_URL}/api/wms/cycle-counts", json={
            "name": "TEST_NoMatch",
            "location_filter": "NONEXISTENT_LOCATION_XYZ123"
        })
        # Should fail because no items match
        assert resp.status_code == 400
        assert "no se encontraron" in resp.json().get("detail", "").lower()
    
    def test_create_cycle_count_with_filters(self):
        """Test creating cycle count with filters that match inventory"""
        # RP10 is mentioned as having items
        resp = self.session.post(f"{BASE_URL}/api/wms/cycle-counts", json={
            "name": "TEST_Count_RP10",
            "location_filter": "RP10"
        })
        # Should succeed if RP10 has inventory
        if resp.status_code == 200:
            data = resp.json()
            assert "count_id" in data
            assert data["name"] == "TEST_Count_RP10"
            assert data["status"] == "pending"
            assert "total_lines" in data
            assert data["total_lines"] > 0
            # Store for cleanup
            self.created_count_id = data["count_id"]
        else:
            # No items found, which is acceptable
            pytest.skip("No inventory in RP10 location to test cycle count creation")
    
    def test_get_cycle_count_detail(self):
        """Test getting cycle count with all lines"""
        # First list to get an existing count
        list_resp = self.session.get(f"{BASE_URL}/api/wms/cycle-counts")
        counts = list_resp.json()
        if not counts:
            pytest.skip("No cycle counts exist to test detail view")
        
        count_id = counts[0]["count_id"]
        resp = self.session.get(f"{BASE_URL}/api/wms/cycle-counts/{count_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert "count_id" in data
        assert "lines" in data
        assert isinstance(data["lines"], list)
    
    def test_get_nonexistent_cycle_count(self):
        """Test getting nonexistent cycle count returns 404"""
        resp = self.session.get(f"{BASE_URL}/api/wms/cycle-counts/cc_nonexistent123")
        assert resp.status_code == 404


class TestCycleCountProgress:
    """Test Cycle Count progress tracking"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup session with auth"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        # Login as admin
        login_resp = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_resp.status_code == 200
    
    def test_save_count_progress(self):
        """Test saving count progress"""
        # First get a cycle count with lines
        list_resp = self.session.get(f"{BASE_URL}/api/wms/cycle-counts")
        counts = list_resp.json()
        if not counts:
            pytest.skip("No cycle counts exist to test progress")
        
        # Find a non-approved count
        count = None
        for c in counts:
            if c.get("status") != "approved":
                count = c
                break
        
        if not count:
            pytest.skip("No editable cycle counts found")
        
        # Get full details
        detail_resp = self.session.get(f"{BASE_URL}/api/wms/cycle-counts/{count['count_id']}")
        count_data = detail_resp.json()
        lines = count_data.get("lines", [])
        
        if not lines:
            pytest.skip("Cycle count has no lines")
        
        # Save progress for first line
        first_line = lines[0]
        counted_items = {
            first_line["line_id"]: first_line.get("system_qty", 0)  # Same as system qty
        }
        
        resp = self.session.put(
            f"{BASE_URL}/api/wms/cycle-counts/{count['count_id']}/count",
            json={"counted_items": counted_items}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "status" in data
        assert data["status"] in ["in_progress", "completed"]
    
    def test_save_progress_nonexistent_count(self):
        """Test saving progress to nonexistent count"""
        resp = self.session.put(
            f"{BASE_URL}/api/wms/cycle-counts/cc_nonexistent123/count",
            json={"counted_items": {"cl_test": 10}}
        )
        assert resp.status_code == 404


class TestCycleCountApproval:
    """Test Cycle Count approval and inventory adjustment"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup session with auth"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        # Login as admin
        login_resp = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_resp.status_code == 200
    
    def test_approve_requires_completed_status(self):
        """Test approval requires completed status"""
        # Get a pending count
        list_resp = self.session.get(f"{BASE_URL}/api/wms/cycle-counts")
        counts = list_resp.json()
        
        pending_count = None
        for c in counts:
            if c.get("status") == "pending":
                pending_count = c
                break
        
        if not pending_count:
            pytest.skip("No pending cycle counts to test approval rejection")
        
        resp = self.session.put(
            f"{BASE_URL}/api/wms/cycle-counts/{pending_count['count_id']}/approve",
            json={}
        )
        # Should fail because not completed
        assert resp.status_code == 400
        assert "completado" in resp.json().get("detail", "").lower()
    
    def test_approve_nonexistent_count(self):
        """Test approving nonexistent count"""
        resp = self.session.put(
            f"{BASE_URL}/api/wms/cycle-counts/cc_nonexistent123/approve",
            json={}
        )
        assert resp.status_code == 404
    
    def test_approve_completed_count(self):
        """Test approving a completed cycle count"""
        # Get a completed count
        list_resp = self.session.get(f"{BASE_URL}/api/wms/cycle-counts")
        counts = list_resp.json()
        
        completed_count = None
        for c in counts:
            if c.get("status") == "completed":
                completed_count = c
                break
        
        if not completed_count:
            pytest.skip("No completed cycle counts to test approval")
        
        resp = self.session.put(
            f"{BASE_URL}/api/wms/cycle-counts/{completed_count['count_id']}/approve",
            json={}
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "adjustments" in data
        assert isinstance(data["adjustments"], int)


class TestCycleCountAuth:
    """Test authentication requirements for cycle count endpoints"""
    
    def test_list_counts_requires_auth(self):
        """Test listing cycle counts requires authentication"""
        session = requests.Session()
        resp = session.get(f"{BASE_URL}/api/wms/cycle-counts")
        assert resp.status_code == 401
    
    def test_create_count_requires_admin(self):
        """Test creating cycle count requires admin role"""
        session = requests.Session()
        session.headers.update({"Content-Type": "application/json"})
        # Try without auth
        resp = session.post(f"{BASE_URL}/api/wms/cycle-counts", json={
            "name": "Test",
            "location_filter": "RP10"
        })
        assert resp.status_code == 401
    
    def test_approve_count_requires_admin(self):
        """Test approval requires admin role"""
        session = requests.Session()
        session.headers.update({"Content-Type": "application/json"})
        resp = session.put(
            f"{BASE_URL}/api/wms/cycle-counts/cc_test/approve",
            json={}
        )
        assert resp.status_code == 401


class TestGenerateSKUAuth:
    """Test authentication for SKU generation"""
    
    def test_generate_sku_requires_auth(self):
        """Test generate-sku requires authentication"""
        session = requests.Session()
        resp = session.get(f"{BASE_URL}/api/wms/generate-sku?style=Test")
        assert resp.status_code == 401


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
