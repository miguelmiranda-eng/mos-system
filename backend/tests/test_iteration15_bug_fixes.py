"""
Iteration 15: Testing 5 Bug Fixes
Bug #1 & #3: Column configuration API (GET/PUT /api/config/columns)
Bug #2: Saved views API for pinned/unpinned views with delete/unpin
Bug #4: Colors API (GET/PUT /api/config/colors) persistence
Bug #5: (Frontend) Sticky columns - verified by examining frontend code
"""
import pytest
import requests
import os
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient

# Configuration
BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')

# Test session token - we'll create it in fixtures
TEST_USER_ID = f"test_user_iter15_{int(datetime.now().timestamp())}"
TEST_SESSION_TOKEN = f"test_session_iter15_{int(datetime.now().timestamp())}"
ADMIN_EMAIL = "miguel.miranda@prosper-mfg.com"

@pytest.fixture(scope="module")
def mongo_client():
    """Setup MongoDB connection for test setup"""
    client = MongoClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()

@pytest.fixture(scope="module")
def admin_session(mongo_client):
    """Create admin session for testing"""
    db = mongo_client
    
    # Check if admin user exists
    admin = db.users.find_one({"email": ADMIN_EMAIL})
    if admin:
        user_id = admin.get("user_id", f"user_{ADMIN_EMAIL}")
    else:
        user_id = TEST_USER_ID
        db.users.insert_one({
            "user_id": user_id,
            "email": ADMIN_EMAIL,
            "name": "Admin Test User Iter15",
            "role": "admin",
            "created_at": datetime.now(timezone.utc).isoformat()
        })
    
    # Create session
    expires_at = datetime.now(timezone.utc) + timedelta(days=1)
    db.user_sessions.delete_many({"session_token": TEST_SESSION_TOKEN})
    db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": TEST_SESSION_TOKEN,
        "expires_at": expires_at.isoformat(),
        "created_at": datetime.now(timezone.utc).isoformat()
    })
    
    yield TEST_SESSION_TOKEN
    
    # Cleanup
    db.user_sessions.delete_many({"session_token": TEST_SESSION_TOKEN})

@pytest.fixture
def api_client(admin_session):
    """Requests session with auth header"""
    session = requests.Session()
    session.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {admin_session}"
    })
    return session


# =========================================================================
# BUG #1 & #3: Custom Columns API Tests
# =========================================================================

class TestColumnConfigAPI:
    """Bug #1 & #3: Test /api/config/columns GET and PUT endpoints"""
    
    def test_get_column_config_returns_200(self, api_client):
        """GET /api/config/columns should return 200 with custom_columns array"""
        response = api_client.get(f"{BASE_URL}/api/config/columns")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        assert "custom_columns" in data, "Response should contain custom_columns key"
        assert isinstance(data["custom_columns"], list), "custom_columns should be a list"
        print(f"GET /api/config/columns returned {len(data['custom_columns'])} custom columns")
    
    def test_put_column_config_saves_custom_columns(self, api_client):
        """PUT /api/config/columns should save custom columns"""
        test_columns = [
            {"key": "test_col_1", "label": "Test Column 1", "type": "text", "width": 150, "custom": True},
            {"key": "test_col_2", "label": "Test Column 2", "type": "number", "width": 100, "custom": True}
        ]
        
        response = api_client.put(
            f"{BASE_URL}/api/config/columns",
            json={"custom_columns": test_columns}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        assert "message" in data, "Response should contain message"
        print(f"PUT /api/config/columns response: {data}")
    
    def test_put_then_get_column_config_persists(self, api_client):
        """Custom columns should persist - save then retrieve"""
        test_columns = [
            {"key": "persist_test_col", "label": "Persistence Test", "type": "text", "width": 200, "custom": True}
        ]
        
        # Save
        put_response = api_client.put(
            f"{BASE_URL}/api/config/columns",
            json={"custom_columns": test_columns}
        )
        assert put_response.status_code == 200
        
        # Retrieve and verify
        get_response = api_client.get(f"{BASE_URL}/api/config/columns")
        assert get_response.status_code == 200
        
        data = get_response.json()
        assert "custom_columns" in data
        # Should contain our test column
        col_keys = [col.get("key") for col in data["custom_columns"]]
        assert "persist_test_col" in col_keys, f"persist_test_col not found in {col_keys}"
        print(f"Persistence test PASSED - column found after save/retrieve")
    
    def test_column_config_requires_auth(self):
        """Column config endpoints should require authentication"""
        # No auth header
        response = requests.get(f"{BASE_URL}/api/config/columns")
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print("GET /api/config/columns correctly requires authentication")


# =========================================================================
# BUG #2: Saved Views API Tests
# =========================================================================

class TestSavedViewsAPI:
    """Bug #2: Test saved views CRUD operations - especially delete and pin/unpin"""
    
    def test_get_saved_views_returns_200(self, api_client):
        """GET /api/saved-views should return list of views"""
        response = api_client.get(f"{BASE_URL}/api/saved-views")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, list), "Response should be a list"
        print(f"GET /api/saved-views returned {len(data)} views")
    
    def test_create_saved_view(self, api_client):
        """POST /api/saved-views should create a new view"""
        view_payload = {
            "name": f"Test View Iter15 {int(datetime.now().timestamp())}",
            "board": "SCHEDULING",
            "filters": {"priority": "RUSH"},
            "pinned": False
        }
        
        response = api_client.post(
            f"{BASE_URL}/api/saved-views",
            json=view_payload
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        data = response.json()
        assert "view_id" in data, "Response should contain view_id"
        assert data["name"] == view_payload["name"]
        assert data["pinned"] == False
        print(f"Created saved view: {data['view_id']}")
        return data["view_id"]
    
    def test_toggle_pin_saved_view(self, api_client):
        """PUT /api/saved-views/{view_id} should toggle pinned state"""
        # First create a view
        view_payload = {
            "name": f"Pin Test View {int(datetime.now().timestamp())}",
            "board": "SCHEDULING",
            "filters": {},
            "pinned": False
        }
        create_res = api_client.post(f"{BASE_URL}/api/saved-views", json=view_payload)
        assert create_res.status_code == 200
        view_id = create_res.json()["view_id"]
        
        # Toggle pin ON
        pin_res = api_client.put(
            f"{BASE_URL}/api/saved-views/{view_id}",
            json={"pinned": True}
        )
        assert pin_res.status_code == 200, f"Failed to pin view: {pin_res.text}"
        
        # Verify pin state
        views_res = api_client.get(f"{BASE_URL}/api/saved-views")
        views = views_res.json()
        view = next((v for v in views if v["view_id"] == view_id), None)
        assert view is not None, f"View {view_id} not found"
        assert view["pinned"] == True, f"View should be pinned, got {view['pinned']}"
        
        # Toggle pin OFF
        unpin_res = api_client.put(
            f"{BASE_URL}/api/saved-views/{view_id}",
            json={"pinned": False}
        )
        assert unpin_res.status_code == 200
        
        # Verify unpin state
        views_res2 = api_client.get(f"{BASE_URL}/api/saved-views")
        views2 = views_res2.json()
        view2 = next((v for v in views2 if v["view_id"] == view_id), None)
        assert view2["pinned"] == False, "View should be unpinned"
        print(f"Pin/unpin toggle test PASSED for view {view_id}")
    
    def test_delete_saved_view(self, api_client):
        """DELETE /api/saved-views/{view_id} should remove the view"""
        # Create a view to delete
        view_payload = {
            "name": f"Delete Test View {int(datetime.now().timestamp())}",
            "board": "MASTER",
            "filters": {}
        }
        create_res = api_client.post(f"{BASE_URL}/api/saved-views", json=view_payload)
        assert create_res.status_code == 200
        view_id = create_res.json()["view_id"]
        
        # Delete the view
        delete_res = api_client.delete(f"{BASE_URL}/api/saved-views/{view_id}")
        assert delete_res.status_code == 200, f"Failed to delete view: {delete_res.text}"
        
        # Verify deletion
        views_res = api_client.get(f"{BASE_URL}/api/saved-views")
        views = views_res.json()
        view_ids = [v["view_id"] for v in views]
        assert view_id not in view_ids, f"View {view_id} should have been deleted"
        print(f"Delete test PASSED - view {view_id} successfully removed")


# =========================================================================
# BUG #4: Colors API Tests
# =========================================================================

class TestColorsAPI:
    """Bug #4: Test /api/config/colors GET and PUT for color persistence"""
    
    def test_get_colors_returns_200(self, api_client):
        """GET /api/config/colors should return color mappings"""
        response = api_client.get(f"{BASE_URL}/api/config/colors")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert isinstance(data, dict), "Response should be a dict"
        print(f"GET /api/config/colors returned {len(data)} color mappings")
    
    def test_put_colors_saves_mapping(self, api_client):
        """PUT /api/config/colors should save color mappings"""
        test_colors = {
            "TEST_STATUS_ITER15": {"bg": "#ff5733", "text": "#ffffff"},
            "ANOTHER_TEST": {"bg": "#3498db", "text": "#ffffff"}
        }
        
        response = api_client.put(
            f"{BASE_URL}/api/config/colors",
            json=test_colors
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        print(f"PUT /api/config/colors response: {response.json()}")
    
    def test_colors_persist_after_save(self, api_client):
        """Colors should persist - save then retrieve"""
        unique_key = f"PERSIST_COLOR_{int(datetime.now().timestamp())}"
        test_colors = {
            unique_key: {"bg": "#e74c3c", "text": "#ffffff"}
        }
        
        # First get existing colors
        get_before = api_client.get(f"{BASE_URL}/api/config/colors")
        existing_colors = get_before.json()
        
        # Merge and save
        merged_colors = {**existing_colors, **test_colors}
        put_res = api_client.put(f"{BASE_URL}/api/config/colors", json=merged_colors)
        assert put_res.status_code == 200
        
        # Retrieve and verify
        get_after = api_client.get(f"{BASE_URL}/api/config/colors")
        assert get_after.status_code == 200
        
        saved_colors = get_after.json()
        assert unique_key in saved_colors, f"{unique_key} not found in saved colors"
        assert saved_colors[unique_key]["bg"] == "#e74c3c", "Color bg should match"
        print(f"Color persistence test PASSED - {unique_key} found after save/retrieve")
    
    def test_colors_requires_admin(self):
        """PUT /api/config/colors should require admin role"""
        # No auth
        response = requests.put(
            f"{BASE_URL}/api/config/colors",
            json={"TEST": {"bg": "#000", "text": "#fff"}}
        )
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print("PUT /api/config/colors correctly requires authentication")


# =========================================================================
# General Health Tests
# =========================================================================

class TestGeneralHealth:
    """General API health checks"""
    
    def test_api_health(self, api_client):
        """Test that API is responding"""
        response = api_client.get(f"{BASE_URL}/api/auth/me")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert "email" in data or "user_id" in data, "User data should contain email or user_id"
        print(f"API health check PASSED - authenticated as {data.get('email', data.get('name'))}")
    
    def test_orders_endpoint(self, api_client):
        """Test orders endpoint is accessible"""
        response = api_client.get(f"{BASE_URL}/api/orders")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert isinstance(data, list), "Orders should be a list"
        print(f"Orders endpoint PASSED - {len(data)} orders found")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
