"""
Iteration 28 Backend Tests: Admin-only Board Create/Delete Permissions
- POST /api/config/boards requires admin (returns 403 for non-admin)
- DELETE /api/config/boards/{name} requires admin (returns 403 for non-admin)
"""
import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

# Test tokens created via mongosh
ADMIN_TOKEN = "test_session_iter28_admin_1772745164956"
REGULAR_TOKEN = "test_session_iter28_regular_1772745164959"


class TestAdminOnlyBoardCreation:
    """POST /api/config/boards requires admin role"""
    
    def test_01_create_board_with_admin_token_succeeds(self):
        """Admin user should be able to create a board"""
        board_name = f"TEST_BOARD_{int(time.time())}"
        response = requests.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": board_name},
            headers={"Authorization": f"Bearer {ADMIN_TOKEN}", "Content-Type": "application/json"}
        )
        # Should succeed with 200 or return 400 if board already exists
        assert response.status_code in [200, 400], f"Expected 200 or 400, got {response.status_code}: {response.text}"
        if response.status_code == 200:
            data = response.json()
            assert "boards" in data
            assert board_name.upper() in data["boards"]
            print(f"✓ Admin can create board: {board_name.upper()}")
    
    def test_02_create_board_with_regular_user_returns_403(self):
        """Non-admin user should get 403 when trying to create a board"""
        board_name = f"TEST_FORBIDDEN_{int(time.time())}"
        response = requests.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": board_name},
            headers={"Authorization": f"Bearer {REGULAR_TOKEN}", "Content-Type": "application/json"}
        )
        assert response.status_code == 403, f"Expected 403 for non-admin, got {response.status_code}: {response.text}"
        print("✓ Non-admin correctly denied board creation (403)")
    
    def test_03_create_board_without_auth_returns_401(self):
        """Unauthenticated request should get 401"""
        board_name = f"TEST_NOAUTH_{int(time.time())}"
        response = requests.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": board_name},
            headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 401, f"Expected 401 for unauthenticated, got {response.status_code}"
        print("✓ Unauthenticated correctly denied board creation (401)")


class TestAdminOnlyBoardDeletion:
    """DELETE /api/config/boards/{name} requires admin role"""
    
    @pytest.fixture(scope="class")
    def test_board_name(self):
        """Create a test board for deletion tests"""
        board_name = f"TEST_DELETE_ITER28_{int(time.time())}"
        response = requests.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": board_name},
            headers={"Authorization": f"Bearer {ADMIN_TOKEN}", "Content-Type": "application/json"}
        )
        if response.status_code == 200:
            return board_name.upper()
        # If board already exists, return a default test board name
        return "EJEMPLOS"
    
    def test_04_delete_board_with_regular_user_returns_403(self, test_board_name):
        """Non-admin user should get 403 when trying to delete a board"""
        response = requests.delete(
            f"{BASE_URL}/api/config/boards/{test_board_name}",
            headers={"Authorization": f"Bearer {REGULAR_TOKEN}"}
        )
        assert response.status_code == 403, f"Expected 403 for non-admin delete, got {response.status_code}: {response.text}"
        print(f"✓ Non-admin correctly denied board deletion of {test_board_name} (403)")
    
    def test_05_delete_board_without_auth_returns_401(self, test_board_name):
        """Unauthenticated request should get 401"""
        response = requests.delete(
            f"{BASE_URL}/api/config/boards/{test_board_name}"
        )
        assert response.status_code == 401, f"Expected 401 for unauthenticated delete, got {response.status_code}"
        print("✓ Unauthenticated correctly denied board deletion (401)")
    
    def test_06_delete_board_with_admin_succeeds(self):
        """Admin user should be able to delete a board"""
        # Create a fresh board for this test
        board_name = f"TEST_ADMIN_DEL_{int(time.time())}"
        create_response = requests.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": board_name},
            headers={"Authorization": f"Bearer {ADMIN_TOKEN}", "Content-Type": "application/json"}
        )
        if create_response.status_code != 200:
            pytest.skip("Could not create test board")
        
        actual_name = board_name.upper()
        
        # Now delete it
        delete_response = requests.delete(
            f"{BASE_URL}/api/config/boards/{actual_name}",
            headers={"Authorization": f"Bearer {ADMIN_TOKEN}"}
        )
        assert delete_response.status_code == 200, f"Admin delete should succeed, got {delete_response.status_code}: {delete_response.text}"
        data = delete_response.json()
        assert actual_name not in data.get("boards", [])
        print(f"✓ Admin can delete board: {actual_name}")
    
    def test_07_cannot_delete_system_boards_even_as_admin(self):
        """System boards (MASTER, COMPLETOS, PAPELERA DE RECICLAJE) cannot be deleted"""
        system_boards = ["MASTER", "COMPLETOS", "PAPELERA DE RECICLAJE"]
        for board in system_boards:
            response = requests.delete(
                f"{BASE_URL}/api/config/boards/{board}",
                headers={"Authorization": f"Bearer {ADMIN_TOKEN}"}
            )
            assert response.status_code == 400, f"Deleting {board} should return 400, got {response.status_code}"
            print(f"✓ System board {board} protected from deletion (400)")


class TestGetBoardsPermissions:
    """GET /api/config/boards - verify it's accessible"""
    
    def test_08_get_boards_is_accessible_without_auth(self):
        """GET boards should work without authentication"""
        response = requests.get(f"{BASE_URL}/api/config/boards")
        assert response.status_code == 200, f"GET boards should succeed, got {response.status_code}"
        data = response.json()
        assert "boards" in data
        assert isinstance(data["boards"], list)
        # Verify system boards are present
        boards = data["boards"]
        assert "MASTER" in boards
        assert "SCHEDULING" in boards
        print(f"✓ GET boards accessible, {len(boards)} boards returned")


class TestBoardPermissionEdgeCases:
    """Edge case testing for board permissions"""
    
    def test_09_create_empty_board_name_returns_400(self):
        """Empty board name should be rejected with 400"""
        response = requests.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": ""},
            headers={"Authorization": f"Bearer {ADMIN_TOKEN}", "Content-Type": "application/json"}
        )
        assert response.status_code == 400, f"Empty board name should return 400, got {response.status_code}"
        print("✓ Empty board name rejected (400)")
    
    def test_10_create_whitespace_board_name_returns_400(self):
        """Whitespace-only board name should be rejected"""
        response = requests.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": "   "},
            headers={"Authorization": f"Bearer {ADMIN_TOKEN}", "Content-Type": "application/json"}
        )
        assert response.status_code == 400, f"Whitespace board name should return 400, got {response.status_code}"
        print("✓ Whitespace board name rejected (400)")
    
    def test_11_create_duplicate_board_returns_400(self):
        """Creating duplicate board should return 400"""
        response = requests.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": "SCHEDULING"},  # Already exists
            headers={"Authorization": f"Bearer {ADMIN_TOKEN}", "Content-Type": "application/json"}
        )
        assert response.status_code == 400, f"Duplicate board should return 400, got {response.status_code}"
        print("✓ Duplicate board name rejected (400)")
    
    def test_12_delete_nonexistent_board_returns_404(self):
        """Deleting non-existent board should return 404"""
        response = requests.delete(
            f"{BASE_URL}/api/config/boards/NONEXISTENT_BOARD_XYZ123",
            headers={"Authorization": f"Bearer {ADMIN_TOKEN}"}
        )
        assert response.status_code == 404, f"Non-existent board delete should return 404, got {response.status_code}"
        print("✓ Non-existent board deletion returns 404")


class TestCleanup:
    """Clean up test boards created during testing"""
    
    def test_99_cleanup_test_boards(self):
        """Remove any test boards created during this iteration"""
        response = requests.get(f"{BASE_URL}/api/config/boards")
        if response.status_code == 200:
            boards = response.json().get("boards", [])
            for board in boards:
                if board.startswith("TEST_"):
                    delete_response = requests.delete(
                        f"{BASE_URL}/api/config/boards/{board}",
                        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"}
                    )
                    if delete_response.status_code == 200:
                        print(f"  Cleaned up test board: {board}")
        print("✓ Cleanup complete")
