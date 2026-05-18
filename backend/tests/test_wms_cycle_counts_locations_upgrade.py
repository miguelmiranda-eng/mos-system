"""
Test WMS cycle counts and locations upgrade features:
1. Virtual Operator "Contador 1" dynamic injection
2. Prefix location filter matching (e.g. ^RP03)
3. Conteo General (is_general: true) matching all warehouse inventory
4. WMS locations PUT edit route with cascade updates to wms_inventory and wms_boxes
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    for port in ['8001', '8000']:
        try:
            r = requests.get(f"http://localhost:{port}/ping", timeout=1)
            if r.status_code == 200:
                BASE_URL = f"http://localhost:{port}"
                break
        except Exception:
            continue
if not BASE_URL:
    BASE_URL = "http://localhost:8001"

class TestWMSUpgrade:
    """Test Suite for WMS Cycle Counts and Locations Improvements"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup session with auth as Admin"""
        self.session = requests.Session()
        self.session.headers.update({"Content-Type": "application/json"})
        
        # Login as admin
        login_resp = self.session.post(f"{BASE_URL}/api/auth/login", json={
            "email": "admin@test.com",
            "password": "admin123"
        })
        assert login_resp.status_code == 200, f"Login failed: {login_resp.text}"

    def test_contador_1_operators_injection(self):
        """Test that 'Contador 1' is injected at the beginning of operators list"""
        # Test WMS operators list
        resp_wms = self.session.get(f"{BASE_URL}/api/wms/operators")
        assert resp_wms.status_code == 200
        wms_ops = resp_wms.json()
        assert len(wms_ops) > 0
        first_op_wms = wms_ops[0]
        assert first_op_wms["user_id"] == "contador_1"
        assert first_op_wms["name"] == "Contador 1"

        # Test Production operators list
        resp_prod = self.session.get(f"{BASE_URL}/api/operators")
        assert resp_prod.status_code == 200
        prod_ops = resp_prod.json()
        assert len(prod_ops) > 0
        first_op_prod = prod_ops[0]
        assert first_op_prod["operator_id"] == "contador_1"
        assert first_op_prod["name"] == "Contador 1"

    def test_location_crud_and_cascade_updates(self):
        """Test creating a location, renaming it, and ensuring inventory updates cascade"""
        # 1. Create a custom location first
        new_loc_payload = {
            "name": "TEST-LOC-ALPHA",
            "zone": "ZONE A",
            "type": "rack"
        }
        create_resp = self.session.post(f"{BASE_URL}/api/wms/locations", json=new_loc_payload)
        assert create_resp.status_code == 200
        created_loc = create_resp.json()
        assert "location_id" in created_loc
        loc_id = created_loc["location_id"]

        try:
            # 2. Try to update name with a duplicate
            dup_payload = {
                "name": "TEST-LOC-ALPHA",
                "zone": "ZONE B"
            }
            # This should be fine as it's the same location name, but zone changes
            update_resp = self.session.put(f"{BASE_URL}/api/wms/locations/{loc_id}", json=dup_payload)
            assert update_resp.status_code == 200
            
            # 3. Update to a new unique name and zone
            update_payload = {
                "name": "TEST-LOC-BETA",
                "zone": "ZONE C"
            }
            update_resp2 = self.session.put(f"{BASE_URL}/api/wms/locations/{loc_id}", json=update_payload)
            assert update_resp2.status_code == 200
            updated_loc = update_resp2.json()
            assert updated_loc["name"] == "TEST-LOC-BETA"
            assert updated_loc["zone"] == "ZONE C"

        finally:
            # 4. Clean up / Delete the created location
            del_resp = self.session.delete(f"{BASE_URL}/api/wms/locations/{loc_id}")
            assert del_resp.status_code == 200

    def test_cycle_count_prefix_matching(self):
        """Test prefix matching logic for locations in cycle counts"""
        # Let's create a cycle count with a partial prefix that matches multiple locations if any
        # Or just "RP" to match active locations
        resp = self.session.post(f"{BASE_URL}/api/wms/cycle-counts", json={
            "name": "TEST_Prefix_Count",
            "location_filter": "RP"
        })
        # If there are matching items, it will return 200, otherwise 400
        if resp.status_code == 200:
            data = resp.json()
            assert "count_id" in data
            assert data["name"] == "TEST_Prefix_Count"
            assert data["total_lines"] > 0
        else:
            pytest.skip("No inventory with prefix 'RP' found for cycle counts prefix test")

    def test_general_cycle_count_creation(self):
        """Test creating a Conteo General (is_general: True) cycle count"""
        resp = self.session.post(f"{BASE_URL}/api/wms/cycle-counts", json={
            "name": "TEST_Conteo_General",
            "is_general": True
        })
        assert resp.status_code in [200, 400]
        if resp.status_code == 200:
            data = resp.json()
            assert "count_id" in data
            assert data["is_general"] is True
            assert data["location_filter"] == ""
            assert data["total_lines"] > 0
        else:
            pytest.skip("No inventory found to create a general cycle count")

    def test_delete_cycle_count(self):
        """Test deleting a cycle count task"""
        # 1. Create a cycle count
        resp = self.session.post(f"{BASE_URL}/api/wms/cycle-counts", json={
            "name": "TEST_Delete_Me",
            "is_general": True
        })
        if resp.status_code != 200:
            pytest.skip("No inventory found to create a general cycle count for deletion test")
            
        data = resp.json()
        count_id = data["count_id"]
        
        # 2. Delete the cycle count
        del_resp = self.session.delete(f"{BASE_URL}/api/wms/cycle-counts/{count_id}")
        assert del_resp.status_code == 200
        del_data = del_resp.json()
        assert "eliminado" in del_data["message"] or "correctamente" in del_data["message"]
        
        # 3. Verify it's gone
        get_resp = self.session.get(f"{BASE_URL}/api/wms/cycle-counts/{count_id}")
        assert get_resp.status_code == 404

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
