"""
Test iteration 39: Hidden Boards Feature + PAPELERA DE RECICLAJE name revert
- GET /api/config/hidden-boards returns list of hidden board names (auth required)
- PUT /api/config/hidden-boards saves hidden boards list (admin only)
- PUT /api/config/hidden-boards returns 403 for non-admin
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

# Test session tokens (these will be created by the test script)
ADMIN_SESSION = "admin_session_iter39_1772829170623"
REGULAR_SESSION = "regular_session_iter39_1772829170640"


class TestHiddenBoardsAPI:
    """Test hidden boards feature - Backend API tests"""

    def test_get_hidden_boards_unauthenticated(self):
        """GET /api/config/hidden-boards without auth should return 401"""
        response = requests.get(f"{BASE_URL}/api/config/hidden-boards")
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("PASS: GET hidden-boards without auth returns 401")

    def test_get_hidden_boards_with_auth(self):
        """GET /api/config/hidden-boards with auth should return list"""
        response = requests.get(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert isinstance(data, list), f"Expected list, got {type(data)}"
        print(f"PASS: GET hidden-boards returns list: {data}")

    def test_get_hidden_boards_regular_user(self):
        """GET /api/config/hidden-boards with regular user auth should work"""
        response = requests.get(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={"Authorization": f"Bearer {REGULAR_SESSION}"}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        print("PASS: GET hidden-boards works for regular users")

    def test_put_hidden_boards_admin(self):
        """PUT /api/config/hidden-boards with admin should succeed"""
        test_boards = ["TEST_HIDDEN_BOARD_A", "TEST_HIDDEN_BOARD_B"]
        response = requests.put(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={
                "Authorization": f"Bearer {ADMIN_SESSION}",
                "Content-Type": "application/json"
            },
            json={"boards": test_boards}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert data.get("message") == "Hidden boards saved", f"Unexpected response: {data}"
        print(f"PASS: PUT hidden-boards admin saves: {test_boards}")
        
        # Verify the boards were saved by GET
        get_response = requests.get(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        assert get_response.status_code == 200
        saved_boards = get_response.json()
        assert saved_boards == test_boards, f"Expected {test_boards}, got {saved_boards}"
        print(f"PASS: GET hidden-boards confirms saved: {saved_boards}")

    def test_put_hidden_boards_non_admin_returns_403(self):
        """PUT /api/config/hidden-boards with non-admin should return 403"""
        response = requests.put(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={
                "Authorization": f"Bearer {REGULAR_SESSION}",
                "Content-Type": "application/json"
            },
            json={"boards": ["SHOULD_NOT_SAVE"]}
        )
        assert response.status_code == 403, f"Expected 403, got {response.status_code}: {response.text}"
        print("PASS: PUT hidden-boards non-admin returns 403")

    def test_put_hidden_boards_unauthenticated_returns_401(self):
        """PUT /api/config/hidden-boards without auth should return 401"""
        response = requests.put(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={"Content-Type": "application/json"},
            json={"boards": ["SHOULD_NOT_SAVE"]}
        )
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("PASS: PUT hidden-boards unauthenticated returns 401")

    def test_toggle_board_visibility_workflow(self):
        """Test complete workflow: hide board, verify hidden, show board, verify visible"""
        # Step 1: Clear hidden boards
        clear_response = requests.put(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={
                "Authorization": f"Bearer {ADMIN_SESSION}",
                "Content-Type": "application/json"
            },
            json={"boards": []}
        )
        assert clear_response.status_code == 200
        print("PASS: Cleared hidden boards")

        # Step 2: Hide "SCHEDULING" board
        hide_response = requests.put(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={
                "Authorization": f"Bearer {ADMIN_SESSION}",
                "Content-Type": "application/json"
            },
            json={"boards": ["SCHEDULING"]}
        )
        assert hide_response.status_code == 200
        print("PASS: Hid SCHEDULING board")

        # Step 3: Verify SCHEDULING is in hidden list
        get_response = requests.get(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        hidden = get_response.json()
        assert "SCHEDULING" in hidden, f"SCHEDULING should be hidden, got {hidden}"
        print("PASS: SCHEDULING is in hidden list")

        # Step 4: Show SCHEDULING (remove from hidden)
        show_response = requests.put(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={
                "Authorization": f"Bearer {ADMIN_SESSION}",
                "Content-Type": "application/json"
            },
            json={"boards": []}
        )
        assert show_response.status_code == 200
        
        # Step 5: Verify hidden list is empty
        get_response2 = requests.get(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        hidden2 = get_response2.json()
        assert "SCHEDULING" not in hidden2, f"SCHEDULING should not be hidden, got {hidden2}"
        print("PASS: SCHEDULING removed from hidden list")


class TestBoardsEndpoint:
    """Test that boards endpoint returns dynamic boards"""

    def test_get_boards(self):
        """GET /api/config/boards returns list of boards"""
        response = requests.get(
            f"{BASE_URL}/api/config/boards",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert "boards" in data, f"Expected 'boards' key in response"
        boards = data["boards"]
        assert isinstance(boards, list), f"Expected list, got {type(boards)}"
        assert len(boards) > 0, "Expected at least one board"
        print(f"PASS: GET boards returns: {boards}")
        
        # Verify expected boards exist
        expected_boards = ["SCHEDULING", "COMPLETOS", "PAPELERA DE RECICLAJE"]
        for expected in expected_boards:
            assert expected in boards, f"Expected board '{expected}' not found in {boards}"
        print("PASS: All expected boards present")


class TestPapeleraDeReciclajeRename:
    """Test that 'PAPELERA DE RECICLAJE' name is correctly used (not 'FINAL BILL')"""

    def test_boards_include_papelera(self):
        """Verify PAPELERA DE RECICLAJE exists in boards list"""
        response = requests.get(
            f"{BASE_URL}/api/config/boards",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        data = response.json()
        boards = data["boards"]
        
        # Check PAPELERA DE RECICLAJE exists
        assert "PAPELERA DE RECICLAJE" in boards, f"'PAPELERA DE RECICLAJE' not in boards: {boards}"
        print("PASS: 'PAPELERA DE RECICLAJE' found in boards")
        
        # Check FINAL BILL does NOT exist
        assert "FINAL BILL" not in boards, f"'FINAL BILL' should not exist in boards: {boards}"
        print("PASS: 'FINAL BILL' correctly removed from boards")

    def test_trash_orders_use_papelera(self):
        """Verify orders can be moved to PAPELERA DE RECICLAJE"""
        # Create a test order
        create_response = requests.post(
            f"{BASE_URL}/api/orders",
            headers={
                "Authorization": f"Bearer {ADMIN_SESSION}",
                "Content-Type": "application/json"
            },
            json={
                "client": "TEST_PAPELERA_CLIENT",
                "branding": "Test Brand",
                "priority": "RUSH",
                "quantity": 10,
                "board": "SCHEDULING"
            }
        )
        assert create_response.status_code in [200, 201], f"Failed to create order: {create_response.text}"
        order = create_response.json()
        order_id = order.get("order_id")
        print(f"PASS: Created test order {order_id}")

        # Move order to PAPELERA DE RECICLAJE
        move_response = requests.post(
            f"{BASE_URL}/api/orders/bulk-move",
            headers={
                "Authorization": f"Bearer {ADMIN_SESSION}",
                "Content-Type": "application/json"
            },
            json={"order_ids": [order_id], "board": "PAPELERA DE RECICLAJE"}
        )
        assert move_response.status_code == 200, f"Failed to move order: {move_response.text}"
        print("PASS: Order moved to PAPELERA DE RECICLAJE")

        # Verify order is in PAPELERA DE RECICLAJE
        get_response = requests.get(
            f"{BASE_URL}/api/orders?board=PAPELERA DE RECICLAJE",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        assert get_response.status_code == 200
        orders = get_response.json()
        order_ids = [o["order_id"] for o in orders]
        assert order_id in order_ids, f"Order {order_id} not found in PAPELERA DE RECICLAJE"
        print("PASS: Order verified in PAPELERA DE RECICLAJE")

        # Cleanup - permanently delete
        delete_response = requests.delete(
            f"{BASE_URL}/api/orders/{order_id}/permanent",
            headers={"Authorization": f"Bearer {ADMIN_SESSION}"}
        )
        assert delete_response.status_code == 200, f"Failed to delete order: {delete_response.text}"
        print("PASS: Test order cleaned up")


# Cleanup test: reset hidden boards to empty
class TestCleanup:
    """Cleanup after tests"""
    
    def test_cleanup_hidden_boards(self):
        """Reset hidden boards to empty list"""
        response = requests.put(
            f"{BASE_URL}/api/config/hidden-boards",
            headers={
                "Authorization": f"Bearer {ADMIN_SESSION}",
                "Content-Type": "application/json"
            },
            json={"boards": []}
        )
        assert response.status_code == 200
        print("PASS: Hidden boards reset to empty")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
