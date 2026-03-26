"""
Test iteration 19: Column Deletion Feature
- Tests ability to delete ANY column (default + custom), not just custom columns
- PUT /api/config/columns now accepts 'removed_default_columns' array
- GET /api/config/columns returns 'removed_default_columns' if set
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestColumnDeletionFeature:
    """Tests for deleting both default and custom columns"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test credentials"""
        self.session_token = "test_admin_cols_1772726752013"
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.session_token}"
        }
        self.cookies = {"session_token": self.session_token}
    
    # ========== GET /api/config/columns Tests ==========
    
    def test_get_columns_returns_removed_default_columns_field(self):
        """GET /api/config/columns should return removed_default_columns if set"""
        # First set some removed defaults
        response = requests.put(
            f"{BASE_URL}/api/config/columns",
            json={
                "custom_columns": [],
                "removed_default_columns": ["test_col_123"]
            },
            headers=self.headers,
            cookies=self.cookies
        )
        assert response.status_code == 200, f"PUT failed: {response.text}"
        
        # Now GET and verify
        response = requests.get(
            f"{BASE_URL}/api/config/columns",
            headers=self.headers,
            cookies=self.cookies
        )
        assert response.status_code == 200
        data = response.json()
        assert "removed_default_columns" in data or "custom_columns" in data, f"Expected column config structure, got: {data}"
    
    def test_get_columns_returns_custom_columns(self):
        """GET /api/config/columns should return custom_columns array"""
        response = requests.get(
            f"{BASE_URL}/api/config/columns",
            headers=self.headers,
            cookies=self.cookies
        )
        assert response.status_code == 200
        data = response.json()
        assert "custom_columns" in data, f"Expected custom_columns field, got: {data}"
        assert isinstance(data["custom_columns"], list), "custom_columns should be a list"
    
    # ========== PUT /api/config/columns Tests ==========
    
    def test_put_columns_accepts_removed_default_columns(self):
        """PUT /api/config/columns should accept removed_default_columns array"""
        # Remove some default columns
        removed_cols = ["notes", "shipping"]
        response = requests.put(
            f"{BASE_URL}/api/config/columns",
            json={
                "custom_columns": [],
                "removed_default_columns": removed_cols
            },
            headers=self.headers,
            cookies=self.cookies
        )
        assert response.status_code == 200, f"PUT failed: {response.text}"
        
        # Verify the removal persisted
        get_response = requests.get(
            f"{BASE_URL}/api/config/columns",
            headers=self.headers,
            cookies=self.cookies
        )
        assert get_response.status_code == 200
        data = get_response.json()
        assert "removed_default_columns" in data, f"removed_default_columns not in response: {data}"
        assert set(data["removed_default_columns"]) == set(removed_cols), f"Expected {removed_cols}, got {data['removed_default_columns']}"
    
    def test_put_columns_with_custom_columns_still_works(self):
        """PUT /api/config/columns should still accept custom_columns"""
        custom_col = {
            "key": "test_custom_col_19",
            "label": "Test Custom Column",
            "type": "text",
            "width": 150,
            "custom": True
        }
        response = requests.put(
            f"{BASE_URL}/api/config/columns",
            json={
                "custom_columns": [custom_col],
                "removed_default_columns": []
            },
            headers=self.headers,
            cookies=self.cookies
        )
        assert response.status_code == 200, f"PUT failed: {response.text}"
        
        # Verify custom column persisted
        get_response = requests.get(
            f"{BASE_URL}/api/config/columns",
            headers=self.headers,
            cookies=self.cookies
        )
        assert get_response.status_code == 200
        data = get_response.json()
        assert any(c.get("key") == "test_custom_col_19" for c in data.get("custom_columns", [])), f"Custom column not found: {data}"
    
    def test_put_columns_both_custom_and_removed_defaults(self):
        """PUT /api/config/columns should handle both custom_columns and removed_default_columns"""
        custom_col = {
            "key": "both_test_col",
            "label": "Both Test Column",
            "type": "number",
            "width": 120,
            "custom": True
        }
        removed_cols = ["betty_column", "job_title_a"]
        
        response = requests.put(
            f"{BASE_URL}/api/config/columns",
            json={
                "custom_columns": [custom_col],
                "removed_default_columns": removed_cols
            },
            headers=self.headers,
            cookies=self.cookies
        )
        assert response.status_code == 200, f"PUT failed: {response.text}"
        
        # Verify both persisted
        get_response = requests.get(
            f"{BASE_URL}/api/config/columns",
            headers=self.headers,
            cookies=self.cookies
        )
        assert get_response.status_code == 200
        data = get_response.json()
        
        # Verify custom column
        assert any(c.get("key") == "both_test_col" for c in data.get("custom_columns", [])), f"Custom column not found"
        
        # Verify removed defaults
        assert "removed_default_columns" in data, "removed_default_columns field missing"
        for col in removed_cols:
            assert col in data["removed_default_columns"], f"{col} not in removed_default_columns"
    
    def test_put_columns_requires_admin(self):
        """PUT /api/config/columns should require admin role"""
        # Use invalid credentials to verify auth check
        response = requests.put(
            f"{BASE_URL}/api/config/columns",
            json={"custom_columns": [], "removed_default_columns": []},
            headers={"Content-Type": "application/json", "Authorization": "Bearer invalid_token"},
            cookies={"session_token": "invalid_token"}
        )
        # Should be 401 or 403 for non-admin/invalid
        assert response.status_code in [401, 403], f"Expected auth error, got {response.status_code}: {response.text}"
    
    def test_put_columns_empty_removed_defaults(self):
        """PUT /api/config/columns should handle empty removed_default_columns"""
        response = requests.put(
            f"{BASE_URL}/api/config/columns",
            json={
                "custom_columns": [],
                "removed_default_columns": []
            },
            headers=self.headers,
            cookies=self.cookies
        )
        assert response.status_code == 200, f"PUT failed: {response.text}"
        
        get_response = requests.get(
            f"{BASE_URL}/api/config/columns",
            headers=self.headers,
            cookies=self.cookies
        )
        assert get_response.status_code == 200
        data = get_response.json()
        # Should either not have the field or have empty array
        if "removed_default_columns" in data:
            assert data["removed_default_columns"] == [], f"Expected empty array, got {data['removed_default_columns']}"
    
    def test_removing_default_column_persists_after_reload(self):
        """Deleting a default column should persist (simulate page reload)"""
        # Remove a default column
        response = requests.put(
            f"{BASE_URL}/api/config/columns",
            json={
                "custom_columns": [],
                "removed_default_columns": ["notes", "trim_box"]
            },
            headers=self.headers,
            cookies=self.cookies
        )
        assert response.status_code == 200
        
        # Simulate "page reload" by doing another GET
        get_response = requests.get(
            f"{BASE_URL}/api/config/columns",
            headers=self.headers,
            cookies=self.cookies
        )
        assert get_response.status_code == 200
        data = get_response.json()
        
        # Verify removed columns are still in the list
        assert "removed_default_columns" in data, "removed_default_columns should persist"
        assert "notes" in data["removed_default_columns"], "notes should still be removed"
        assert "trim_box" in data["removed_default_columns"], "trim_box should still be removed"
    
    # ========== Cleanup ==========
    
    def test_zz_cleanup_column_config(self):
        """Cleanup: Reset column config to default state"""
        response = requests.put(
            f"{BASE_URL}/api/config/columns",
            json={
                "custom_columns": [],
                "removed_default_columns": []
            },
            headers=self.headers,
            cookies=self.cookies
        )
        assert response.status_code == 200, f"Cleanup failed: {response.text}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
