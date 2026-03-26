"""
Test cases for Board Layout Persistence feature (iteration 34)
Tests GET/PUT /api/config/board-layout/{board_name} endpoints
- Admin can save column_order and hidden_columns
- Non-admin cannot modify layout (403)
- Layout is stored globally (not per-user)
"""
import pytest
import requests
import os
from datetime import datetime, timedelta

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL').rstrip('/')

# Test board name for isolation
TEST_BOARD = "SCHEDULING"


class TestBoardLayoutEndpoints:
    """Board Layout API Tests - Column Order & Hidden Columns Persistence"""
    
    admin_session = None
    user_session = None
    
    @pytest.fixture(autouse=True, scope="class")
    def setup_test_sessions(self, request):
        """Create admin and regular user sessions for testing"""
        import subprocess
        import json
        
        timestamp = int(datetime.now().timestamp() * 1000)
        
        # Create admin user and session
        admin_user_id = f"test-admin-layout-{timestamp}"
        admin_session_token = f"test_session_admin_layout_{timestamp}"
        
        admin_script = f"""
        use('test_database');
        db.users.deleteMany({{ user_id: /^test-admin-layout-/ }});
        db.user_sessions.deleteMany({{ session_token: /^test_session_admin_layout_/ }});
        db.users.insertOne({{
            user_id: '{admin_user_id}',
            email: 'admin.layout.{timestamp}@example.com',
            name: 'Test Layout Admin',
            role: 'admin',
            picture: 'https://via.placeholder.com/150',
            created_at: new Date()
        }});
        db.user_sessions.insertOne({{
            user_id: '{admin_user_id}',
            session_token: '{admin_session_token}',
            expires_at: new Date(Date.now() + 24*60*60*1000),
            created_at: new Date()
        }});
        print('OK');
        """
        result = subprocess.run(['mongosh', '--quiet', '--eval', admin_script], capture_output=True, text=True)
        assert 'OK' in result.stdout, f"Failed to create admin session: {result.stderr}"
        
        # Create regular user and session
        user_user_id = f"test-user-layout-{timestamp}"
        user_session_token = f"test_session_user_layout_{timestamp}"
        
        user_script = f"""
        use('test_database');
        db.users.deleteMany({{ user_id: /^test-user-layout-/ }});
        db.user_sessions.deleteMany({{ session_token: /^test_session_user_layout_/ }});
        db.users.insertOne({{
            user_id: '{user_user_id}',
            email: 'user.layout.{timestamp}@example.com',
            name: 'Test Layout User',
            role: 'viewer',
            picture: 'https://via.placeholder.com/150',
            created_at: new Date()
        }});
        db.user_sessions.insertOne({{
            user_id: '{user_user_id}',
            session_token: '{user_session_token}',
            expires_at: new Date(Date.now() + 24*60*60*1000),
            created_at: new Date()
        }});
        print('OK');
        """
        result = subprocess.run(['mongosh', '--quiet', '--eval', user_script], capture_output=True, text=True)
        assert 'OK' in result.stdout, f"Failed to create user session: {result.stderr}"
        
        request.cls.admin_session = admin_session_token
        request.cls.user_session = user_session_token
        request.cls.timestamp = timestamp
        
        yield
        
        # Cleanup after tests
        cleanup_script = f"""
        use('test_database');
        db.users.deleteMany({{ user_id: /^test-(admin|user)-layout-/ }});
        db.user_sessions.deleteMany({{ session_token: /^test_session_(admin|user)_layout_/ }});
        db.board_layouts.deleteMany({{ board: 'TEST_LAYOUT_BOARD' }});
        print('CLEANED');
        """
        subprocess.run(['mongosh', '--quiet', '--eval', cleanup_script], capture_output=True, text=True)
    
    def get_admin_cookies(self):
        return {"session_token": self.admin_session}
    
    def get_user_cookies(self):
        return {"session_token": self.user_session}
    
    # ==================== GET BOARD LAYOUT TESTS ====================
    
    def test_get_board_layout_requires_auth(self):
        """GET /api/config/board-layout/{board} returns 401 without auth"""
        response = requests.get(f"{BASE_URL}/api/config/board-layout/{TEST_BOARD}")
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("PASS: GET board-layout requires authentication")
    
    def test_get_board_layout_with_auth(self):
        """GET /api/config/board-layout/{board} returns layout for authenticated user"""
        response = requests.get(
            f"{BASE_URL}/api/config/board-layout/{TEST_BOARD}",
            cookies=self.get_admin_cookies()
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        # Layout may be empty dict or have column_order/hidden_columns
        assert isinstance(data, dict), f"Expected dict, got {type(data)}"
        print(f"PASS: GET board-layout returns layout: {data}")
    
    def test_get_board_layout_regular_user_can_read(self):
        """Regular users can also read the board layout (visibility for all)"""
        response = requests.get(
            f"{BASE_URL}/api/config/board-layout/{TEST_BOARD}",
            cookies=self.get_user_cookies()
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        print("PASS: Regular user can read board layout")
    
    # ==================== PUT BOARD LAYOUT TESTS ====================
    
    def test_put_board_layout_requires_auth(self):
        """PUT /api/config/board-layout/{board} returns 401 without auth"""
        response = requests.put(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            json={"column_order": ["client", "priority"], "hidden_columns": []},
            headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("PASS: PUT board-layout requires authentication")
    
    def test_put_board_layout_forbidden_for_non_admin(self):
        """PUT /api/config/board-layout/{board} returns 403 for non-admin users"""
        response = requests.put(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            json={"column_order": ["client", "priority"], "hidden_columns": []},
            headers={"Content-Type": "application/json"},
            cookies=self.get_user_cookies()
        )
        assert response.status_code == 403, f"Expected 403, got {response.status_code}"
        print("PASS: PUT board-layout returns 403 for non-admin")
    
    def test_put_board_layout_admin_can_save(self):
        """Admin can save board layout via PUT"""
        test_column_order = ["order_number", "client", "priority", "quantity"]
        test_hidden_columns = ["sample", "notes"]
        
        response = requests.put(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            json={"column_order": test_column_order, "hidden_columns": test_hidden_columns},
            headers={"Content-Type": "application/json"},
            cookies=self.get_admin_cookies()
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert data.get("message") == "Board layout saved", f"Unexpected message: {data}"
        print("PASS: Admin can save board layout")
    
    def test_put_board_layout_persists_data(self):
        """Verify layout is actually persisted after PUT"""
        test_column_order = ["priority", "client", "order_number", "due_date"]
        test_hidden_columns = ["sample"]
        
        # Save layout
        put_response = requests.put(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            json={"column_order": test_column_order, "hidden_columns": test_hidden_columns},
            headers={"Content-Type": "application/json"},
            cookies=self.get_admin_cookies()
        )
        assert put_response.status_code == 200
        
        # Verify persistence via GET
        get_response = requests.get(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            cookies=self.get_admin_cookies()
        )
        assert get_response.status_code == 200
        data = get_response.json()
        
        assert data.get("board") == "TEST_LAYOUT_BOARD", f"Board name mismatch: {data}"
        assert data.get("column_order") == test_column_order, f"column_order mismatch: {data}"
        assert data.get("hidden_columns") == test_hidden_columns, f"hidden_columns mismatch: {data}"
        assert "updated_at" in data, "Missing updated_at timestamp"
        print(f"PASS: Board layout persisted correctly: {data}")
    
    def test_layout_is_global_not_per_user(self):
        """Layout saved by admin is visible to regular users (global, not per-user)"""
        unique_order = ["quantity", "branding", "client"]
        unique_hidden = ["artwork_status"]
        
        # Admin saves layout
        put_response = requests.put(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            json={"column_order": unique_order, "hidden_columns": unique_hidden},
            headers={"Content-Type": "application/json"},
            cookies=self.get_admin_cookies()
        )
        assert put_response.status_code == 200
        
        # Regular user fetches layout
        get_response = requests.get(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            cookies=self.get_user_cookies()
        )
        assert get_response.status_code == 200
        data = get_response.json()
        
        assert data.get("column_order") == unique_order, f"Regular user should see admin's column_order"
        assert data.get("hidden_columns") == unique_hidden, f"Regular user should see admin's hidden_columns"
        print("PASS: Layout is global - regular user sees admin's layout")
    
    def test_layout_update_replaces_previous(self):
        """PUT replaces previous layout completely"""
        first_order = ["client", "priority"]
        first_hidden = ["notes"]
        
        # First save
        requests.put(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            json={"column_order": first_order, "hidden_columns": first_hidden},
            headers={"Content-Type": "application/json"},
            cookies=self.get_admin_cookies()
        )
        
        second_order = ["order_number", "quantity"]
        second_hidden = ["sample", "artwork_status"]
        
        # Second save
        requests.put(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            json={"column_order": second_order, "hidden_columns": second_hidden},
            headers={"Content-Type": "application/json"},
            cookies=self.get_admin_cookies()
        )
        
        # Verify
        get_response = requests.get(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            cookies=self.get_admin_cookies()
        )
        data = get_response.json()
        
        assert data.get("column_order") == second_order, "column_order not updated"
        assert data.get("hidden_columns") == second_hidden, "hidden_columns not updated"
        print("PASS: Layout update replaces previous layout")
    
    def test_empty_layout_for_nonexistent_board(self):
        """GET returns empty dict for board with no saved layout"""
        response = requests.get(
            f"{BASE_URL}/api/config/board-layout/NONEXISTENT_BOARD_12345",
            cookies=self.get_admin_cookies()
        )
        assert response.status_code == 200
        data = response.json()
        assert data == {} or (not data.get("column_order") and not data.get("hidden_columns")), \
            f"Expected empty layout for nonexistent board, got: {data}"
        print("PASS: Empty layout returned for nonexistent board")
    
    def test_save_empty_column_order(self):
        """Can save empty column_order and hidden_columns"""
        response = requests.put(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            json={"column_order": [], "hidden_columns": []},
            headers={"Content-Type": "application/json"},
            cookies=self.get_admin_cookies()
        )
        assert response.status_code == 200
        
        get_response = requests.get(
            f"{BASE_URL}/api/config/board-layout/TEST_LAYOUT_BOARD",
            cookies=self.get_admin_cookies()
        )
        data = get_response.json()
        assert data.get("column_order") == [], "Empty column_order not saved"
        assert data.get("hidden_columns") == [], "Empty hidden_columns not saved"
        print("PASS: Can save empty column_order and hidden_columns")


class TestBoardLayoutRealBoard:
    """Test board layout on actual boards like SCHEDULING"""
    
    admin_session = None
    original_layout = None
    
    @pytest.fixture(autouse=True, scope="class")
    def setup_admin_session(self, request):
        """Create admin session for testing"""
        import subprocess
        
        timestamp = int(datetime.now().timestamp() * 1000)
        admin_user_id = f"test-admin-real-{timestamp}"
        admin_session_token = f"test_session_admin_real_{timestamp}"
        
        script = f"""
        use('test_database');
        db.users.deleteMany({{ user_id: /^test-admin-real-/ }});
        db.user_sessions.deleteMany({{ session_token: /^test_session_admin_real_/ }});
        db.users.insertOne({{
            user_id: '{admin_user_id}',
            email: 'admin.real.{timestamp}@example.com',
            name: 'Test Real Admin',
            role: 'admin',
            picture: 'https://via.placeholder.com/150',
            created_at: new Date()
        }});
        db.user_sessions.insertOne({{
            user_id: '{admin_user_id}',
            session_token: '{admin_session_token}',
            expires_at: new Date(Date.now() + 24*60*60*1000),
            created_at: new Date()
        }});
        print('OK');
        """
        result = subprocess.run(['mongosh', '--quiet', '--eval', script], capture_output=True, text=True)
        assert 'OK' in result.stdout, f"Failed to create session: {result.stderr}"
        
        request.cls.admin_session = admin_session_token
        
        # Store original layout for SCHEDULING
        response = requests.get(
            f"{BASE_URL}/api/config/board-layout/SCHEDULING",
            cookies={"session_token": admin_session_token}
        )
        if response.status_code == 200:
            request.cls.original_layout = response.json()
        
        yield
        
        # Restore original layout
        if request.cls.original_layout and request.cls.original_layout.get("board"):
            requests.put(
                f"{BASE_URL}/api/config/board-layout/SCHEDULING",
                json={
                    "column_order": request.cls.original_layout.get("column_order", []),
                    "hidden_columns": request.cls.original_layout.get("hidden_columns", [])
                },
                headers={"Content-Type": "application/json"},
                cookies={"session_token": admin_session_token}
            )
        
        # Cleanup
        cleanup_script = f"""
        use('test_database');
        db.users.deleteMany({{ user_id: /^test-admin-real-/ }});
        db.user_sessions.deleteMany({{ session_token: /^test_session_admin_real_/ }});
        print('CLEANED');
        """
        subprocess.run(['mongosh', '--quiet', '--eval', cleanup_script], capture_output=True, text=True)
    
    def get_admin_cookies(self):
        return {"session_token": self.admin_session}
    
    def test_scheduling_board_layout_crud(self):
        """Test layout CRUD on SCHEDULING board"""
        test_order = ["order_number", "client", "priority", "quantity", "due_date"]
        test_hidden = ["sample"]
        
        # Save
        put_response = requests.put(
            f"{BASE_URL}/api/config/board-layout/SCHEDULING",
            json={"column_order": test_order, "hidden_columns": test_hidden},
            headers={"Content-Type": "application/json"},
            cookies=self.get_admin_cookies()
        )
        assert put_response.status_code == 200, f"PUT failed: {put_response.status_code}"
        
        # Read back
        get_response = requests.get(
            f"{BASE_URL}/api/config/board-layout/SCHEDULING",
            cookies=self.get_admin_cookies()
        )
        assert get_response.status_code == 200
        data = get_response.json()
        
        assert data.get("board") == "SCHEDULING"
        assert data.get("column_order") == test_order
        assert data.get("hidden_columns") == test_hidden
        print("PASS: SCHEDULING board layout CRUD works correctly")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
