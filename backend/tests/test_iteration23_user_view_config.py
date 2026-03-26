"""
Test iteration 23: Per-user frozen views on MASTER board

Tests:
1. GET /api/user-view-config/MASTER returns empty object for new user
2. PUT /api/user-view-config/MASTER saves filters, hidden_columns, column_order, group_by_date
3. Config is stored per user_id (different users get different configs)
4. Non-MASTER boards return empty config (not affected by auto-save behavior)
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestUserViewConfig:
    """Test per-user view config for MASTER board"""
    
    @pytest.fixture(scope="class")
    def user1_session(self):
        """Create test user 1 with session"""
        import subprocess
        result = subprocess.run([
            'mongosh', '--quiet', '--eval', f"""
            use('test_database');
            var ts = Date.now();
            var userId = 'test-iter23-user1-' + ts;
            var sessionToken = 'test_iter23_session1_' + ts;
            db.users.insertOne({{
                user_id: userId,
                email: 'test.iter23.user1.' + ts + '@example.com',
                name: 'Test Iter23 User1',
                role: 'admin',
                created_at: new Date()
            }});
            db.user_sessions.insertOne({{
                user_id: userId,
                session_token: sessionToken,
                expires_at: new Date(Date.now() + 7*24*60*60*1000),
                created_at: new Date()
            }});
            print(sessionToken + '|' + userId);
            """
        ], capture_output=True, text=True)
        parts = result.stdout.strip().split('|')
        return {"token": parts[0], "user_id": parts[1]}

    @pytest.fixture(scope="class")
    def user2_session(self):
        """Create test user 2 with session"""
        import subprocess
        result = subprocess.run([
            'mongosh', '--quiet', '--eval', f"""
            use('test_database');
            var ts = Date.now();
            var userId = 'test-iter23-user2-' + ts;
            var sessionToken = 'test_iter23_session2_' + ts;
            db.users.insertOne({{
                user_id: userId,
                email: 'test.iter23.user2.' + ts + '@example.com',
                name: 'Test Iter23 User2',
                role: 'user',
                created_at: new Date()
            }});
            db.user_sessions.insertOne({{
                user_id: userId,
                session_token: sessionToken,
                expires_at: new Date(Date.now() + 7*24*60*60*1000),
                created_at: new Date()
            }});
            print(sessionToken + '|' + userId);
            """
        ], capture_output=True, text=True)
        parts = result.stdout.strip().split('|')
        return {"token": parts[0], "user_id": parts[1]}

    def test_01_get_empty_config_for_new_user(self, user1_session):
        """GET /api/user-view-config/MASTER returns empty object for new user"""
        response = requests.get(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={"Authorization": f"Bearer {user1_session['token']}"}
        )
        assert response.status_code == 200
        data = response.json()
        # Should return empty object (no user_id means no saved config)
        assert data == {} or data.get("user_id") is None

    def test_02_save_master_config(self, user1_session):
        """PUT /api/user-view-config/MASTER saves config successfully"""
        config_payload = {
            "filters": {"client": ["LOVE IN FAITH"], "priority": ["RUSH"]},
            "hidden_columns": ["notes", "due_date"],
            "column_order": ["order_number", "client", "priority", "quantity"],
            "group_by_date": "due_date"
        }
        response = requests.put(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={
                "Authorization": f"Bearer {user1_session['token']}",
                "Content-Type": "application/json"
            },
            json=config_payload
        )
        assert response.status_code == 200
        assert response.json().get("message") == "View config saved"

    def test_03_get_saved_config(self, user1_session):
        """GET /api/user-view-config/MASTER returns saved config after save"""
        response = requests.get(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={"Authorization": f"Bearer {user1_session['token']}"}
        )
        assert response.status_code == 200
        data = response.json()
        # Verify saved data
        assert data.get("user_id") == user1_session["user_id"]
        assert data.get("board") == "MASTER"
        assert data.get("filters") == {"client": ["LOVE IN FAITH"], "priority": ["RUSH"]}
        assert data.get("hidden_columns") == ["notes", "due_date"]
        assert data.get("column_order") == ["order_number", "client", "priority", "quantity"]
        assert data.get("group_by_date") == "due_date"
        assert "updated_at" in data

    def test_04_user2_gets_empty_config(self, user2_session):
        """Different user gets empty config (per-user isolation)"""
        response = requests.get(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={"Authorization": f"Bearer {user2_session['token']}"}
        )
        assert response.status_code == 200
        data = response.json()
        # User 2 should have empty config
        assert data == {} or data.get("user_id") is None

    def test_05_user2_saves_different_config(self, user2_session):
        """User 2 can save different config"""
        config_payload = {
            "filters": {"blank_status": ["En produccion"]},
            "hidden_columns": ["artwork_status"],
            "column_order": ["client", "order_number"],
            "group_by_date": "created_at"
        }
        response = requests.put(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={
                "Authorization": f"Bearer {user2_session['token']}",
                "Content-Type": "application/json"
            },
            json=config_payload
        )
        assert response.status_code == 200
        
        # Verify saved
        get_response = requests.get(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={"Authorization": f"Bearer {user2_session['token']}"}
        )
        data = get_response.json()
        assert data.get("user_id") == user2_session["user_id"]
        assert data.get("filters") == {"blank_status": ["En produccion"]}
        assert data.get("group_by_date") == "created_at"

    def test_06_user1_config_unchanged_after_user2_save(self, user1_session, user2_session):
        """User 1's config is unchanged after User 2 saves (isolation)"""
        response = requests.get(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={"Authorization": f"Bearer {user1_session['token']}"}
        )
        data = response.json()
        # User 1 should still have original config
        assert data.get("filters") == {"client": ["LOVE IN FAITH"], "priority": ["RUSH"]}
        assert data.get("group_by_date") == "due_date"

    def test_07_non_master_board_empty(self, user1_session):
        """Non-MASTER boards return empty config"""
        for board in ["SCHEDULING", "BLANK", "TRIM"]:
            response = requests.get(
                f"{BASE_URL}/api/user-view-config/{board}",
                headers={"Authorization": f"Bearer {user1_session['token']}"}
            )
            assert response.status_code == 200
            data = response.json()
            # Non-MASTER boards should have no auto-saved config
            assert data == {} or data.get("user_id") is None, f"Board {board} should have empty config"

    def test_08_update_existing_config(self, user1_session):
        """Updating existing config overwrites previous values"""
        # Update with new values
        updated_config = {
            "filters": {"client": ["VANS"]},
            "hidden_columns": [],
            "column_order": ["quantity", "client"],
            "group_by_date": None
        }
        response = requests.put(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={
                "Authorization": f"Bearer {user1_session['token']}",
                "Content-Type": "application/json"
            },
            json=updated_config
        )
        assert response.status_code == 200
        
        # Verify update
        get_response = requests.get(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={"Authorization": f"Bearer {user1_session['token']}"}
        )
        data = get_response.json()
        assert data.get("filters") == {"client": ["VANS"]}
        assert data.get("hidden_columns") == []
        assert data.get("column_order") == ["quantity", "client"]
        assert data.get("group_by_date") is None

    def test_09_empty_filters_clears_previous(self, user1_session):
        """Saving empty filters clears previous filters"""
        config = {
            "filters": {},
            "hidden_columns": [],
            "column_order": [],
            "group_by_date": None
        }
        response = requests.put(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={
                "Authorization": f"Bearer {user1_session['token']}",
                "Content-Type": "application/json"
            },
            json=config
        )
        assert response.status_code == 200
        
        get_response = requests.get(
            f"{BASE_URL}/api/user-view-config/MASTER",
            headers={"Authorization": f"Bearer {user1_session['token']}"}
        )
        data = get_response.json()
        assert data.get("filters") == {}

    def test_10_unauthorized_request_fails(self):
        """Unauthorized request returns 401"""
        response = requests.get(f"{BASE_URL}/api/user-view-config/MASTER")
        assert response.status_code == 401


class TestUserViewConfigCleanup:
    """Cleanup test data after tests"""
    
    def test_cleanup(self):
        """Remove test data from database"""
        import subprocess
        subprocess.run([
            'mongosh', '--quiet', '--eval', """
            use('test_database');
            db.users.deleteMany({user_id: {$regex: /^test-iter23-/}});
            db.user_sessions.deleteMany({session_token: {$regex: /^test_iter23_/}});
            db.user_view_config.deleteMany({user_id: {$regex: /^test-iter23-/}});
            print('Cleanup complete');
            """
        ], capture_output=True, text=True)
        assert True
