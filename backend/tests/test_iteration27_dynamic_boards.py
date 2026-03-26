"""
Test iteration 27: Dynamic Boards Feature
Tests:
- GET /api/config/boards returns dynamic boards list from DB (falls back to defaults if no DB config)
- POST /api/config/boards creates new board - requires admin, rejects duplicates and empty names
- DELETE /api/config/boards/{name} deletes board - requires admin, rejects system boards (MASTER, COMPLETOS, PAPELERA DE RECICLAJE)
- DELETE /api/config/boards/{name} moves orders from deleted board to MASTER
- POST /api/orders/{order_id}/move validates against dynamic boards list
"""

import pytest
import requests
import os
import time

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

# Get session tokens from environment or use defaults from test setup
ADMIN_SESSION = os.environ.get('ADMIN_SESSION_TOKEN', 'test_session_iter27_1772744415808')
REGULAR_SESSION = os.environ.get('REGULAR_SESSION_TOKEN', 'test_session_regular_iter27_1772744415823')

# System boards that cannot be deleted
SYSTEM_BOARDS = ["MASTER", "COMPLETOS", "PAPELERA DE RECICLAJE"]

# Default boards expected when no DB config exists
DEFAULT_BOARDS = [
    "MASTER", "SCHEDULING", "BLANKS", "SCREENS", "NECK", "EJEMPLOS", "COMPLETOS",
    "PAPELERA DE RECICLAJE", "MAQUINA1", "MAQUINA2", "MAQUINA3", "MAQUINA4",
    "MAQUINA5", "MAQUINA6", "MAQUINA7", "MAQUINA8", "MAQUINA9", "MAQUINA10",
    "MAQUINA11", "MAQUINA12", "MAQUINA13", "MAQUINA14"
]


@pytest.fixture
def admin_client():
    """Admin authenticated session"""
    session = requests.Session()
    session.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {ADMIN_SESSION}"
    })
    return session


@pytest.fixture
def regular_client():
    """Regular user authenticated session (non-admin)"""
    session = requests.Session()
    session.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {REGULAR_SESSION}"
    })
    return session


@pytest.fixture
def unauthenticated_client():
    """Unauthenticated session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


class TestGetBoards:
    """Test GET /api/config/boards endpoint"""

    def test_01_get_boards_returns_list(self, admin_client):
        """GET /api/config/boards returns boards list"""
        response = admin_client.get(f"{BASE_URL}/api/config/boards")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "boards" in data, "Response should contain 'boards' key"
        assert isinstance(data["boards"], list), "boards should be a list"
        print(f"PASS: GET /api/config/boards returns list with {len(data['boards'])} boards")

    def test_02_get_boards_contains_default_boards(self, admin_client):
        """GET /api/config/boards returns default boards when no custom config"""
        response = admin_client.get(f"{BASE_URL}/api/config/boards")
        assert response.status_code == 200
        boards = response.json()["boards"]
        # Check that system boards are present
        for system_board in SYSTEM_BOARDS:
            assert system_board in boards, f"System board {system_board} should be present"
        print(f"PASS: All system boards present: {SYSTEM_BOARDS}")

    def test_03_get_boards_requires_no_auth(self, unauthenticated_client):
        """GET /api/config/boards works without authentication (optional)"""
        response = unauthenticated_client.get(f"{BASE_URL}/api/config/boards")
        # This endpoint may or may not require auth - testing actual behavior
        if response.status_code == 200:
            print("PASS: GET /api/config/boards accessible without auth")
        else:
            print(f"INFO: GET /api/config/boards requires auth (status {response.status_code})")
        assert response.status_code in [200, 401], f"Unexpected status: {response.status_code}"


class TestCreateBoard:
    """Test POST /api/config/boards endpoint"""

    def test_04_create_board_success(self, admin_client):
        """Admin can create a new board"""
        new_board_name = f"TEST_BOARD_{int(time.time())}"
        response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": new_board_name}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "boards" in data, "Response should contain 'boards' key"
        assert "created" in data, "Response should contain 'created' key"
        assert data["created"] == new_board_name.upper(), f"Created board name should match (uppercase): {data['created']}"
        assert new_board_name.upper() in data["boards"], "New board should be in boards list"
        print(f"PASS: Created board '{new_board_name.upper()}' successfully")

    def test_05_create_board_requires_admin(self, regular_client):
        """Regular user cannot create board (403)"""
        response = regular_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": "REGULAR_USER_BOARD"}
        )
        assert response.status_code == 403, f"Expected 403 for non-admin, got {response.status_code}: {response.text}"
        print("PASS: Non-admin user cannot create board (403)")

    def test_06_create_board_rejects_empty_name(self, admin_client):
        """Cannot create board with empty name"""
        response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": ""}
        )
        assert response.status_code == 400, f"Expected 400 for empty name, got {response.status_code}: {response.text}"
        data = response.json()
        assert "detail" in data, "Error response should have detail"
        print(f"PASS: Empty board name rejected: {data.get('detail')}")

    def test_07_create_board_rejects_whitespace_name(self, admin_client):
        """Cannot create board with whitespace-only name"""
        response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": "   "}
        )
        assert response.status_code == 400, f"Expected 400 for whitespace name, got {response.status_code}: {response.text}"
        print("PASS: Whitespace-only board name rejected")

    def test_08_create_board_rejects_duplicate(self, admin_client):
        """Cannot create board that already exists"""
        # Try to create MASTER which is a system board
        response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": "MASTER"}
        )
        assert response.status_code == 400, f"Expected 400 for duplicate, got {response.status_code}: {response.text}"
        data = response.json()
        assert "already exists" in data.get("detail", "").lower(), "Error should mention board exists"
        print(f"PASS: Duplicate board rejected: {data.get('detail')}")

    def test_09_create_board_converts_to_uppercase(self, admin_client):
        """Board names are stored in uppercase"""
        unique_name = f"lowercase_test_{int(time.time())}"
        response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": unique_name}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert data["created"] == unique_name.upper(), f"Board name should be uppercase: {data['created']}"
        print(f"PASS: Board name converted to uppercase: {data['created']}")

    def test_10_create_board_requires_auth(self, unauthenticated_client):
        """Cannot create board without authentication"""
        response = unauthenticated_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": "UNAUTHORIZED_BOARD"}
        )
        assert response.status_code == 401, f"Expected 401 for unauthenticated, got {response.status_code}"
        print("PASS: Unauthenticated user cannot create board (401)")


class TestDeleteBoard:
    """Test DELETE /api/config/boards/{name} endpoint"""

    def test_11_delete_board_success(self, admin_client):
        """Admin can delete a non-system board"""
        # First create a board to delete
        board_name = f"TO_DELETE_{int(time.time())}"
        create_response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": board_name}
        )
        assert create_response.status_code == 200, f"Failed to create board: {create_response.text}"
        board_name_upper = board_name.upper()

        # Now delete it
        response = admin_client.delete(f"{BASE_URL}/api/config/boards/{board_name_upper}")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "boards" in data, "Response should contain 'boards' key"
        assert "deleted" in data, "Response should contain 'deleted' key"
        assert data["deleted"] == board_name_upper, f"Deleted board name should match: {data['deleted']}"
        assert board_name_upper not in data["boards"], "Deleted board should not be in boards list"
        print(f"PASS: Deleted board '{board_name_upper}' successfully")

    def test_12_cannot_delete_master(self, admin_client):
        """Cannot delete system board MASTER"""
        response = admin_client.delete(f"{BASE_URL}/api/config/boards/MASTER")
        assert response.status_code == 400, f"Expected 400 for MASTER deletion, got {response.status_code}: {response.text}"
        data = response.json()
        assert "system" in data.get("detail", "").lower() or "cannot" in data.get("detail", "").lower(), \
            f"Error should mention system board: {data.get('detail')}"
        print(f"PASS: Cannot delete MASTER: {data.get('detail')}")

    def test_13_cannot_delete_completos(self, admin_client):
        """Cannot delete system board COMPLETOS"""
        response = admin_client.delete(f"{BASE_URL}/api/config/boards/COMPLETOS")
        assert response.status_code == 400, f"Expected 400 for COMPLETOS deletion, got {response.status_code}: {response.text}"
        print("PASS: Cannot delete COMPLETOS")

    def test_14_cannot_delete_papelera(self, admin_client):
        """Cannot delete system board PAPELERA DE RECICLAJE"""
        response = admin_client.delete(f"{BASE_URL}/api/config/boards/PAPELERA DE RECICLAJE")
        assert response.status_code == 400, f"Expected 400 for PAPELERA deletion, got {response.status_code}: {response.text}"
        print("PASS: Cannot delete PAPELERA DE RECICLAJE")

    def test_15_delete_board_requires_admin(self, regular_client, admin_client):
        """Regular user cannot delete board (403)"""
        # First create a board as admin
        board_name = f"FOR_REGULAR_DELETE_{int(time.time())}"
        create_response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": board_name}
        )
        assert create_response.status_code == 200
        board_name_upper = board_name.upper()

        # Try to delete as regular user
        response = regular_client.delete(f"{BASE_URL}/api/config/boards/{board_name_upper}")
        assert response.status_code == 403, f"Expected 403 for non-admin, got {response.status_code}: {response.text}"
        print("PASS: Non-admin user cannot delete board (403)")

        # Cleanup: delete as admin
        admin_client.delete(f"{BASE_URL}/api/config/boards/{board_name_upper}")

    def test_16_delete_nonexistent_board(self, admin_client):
        """Deleting non-existent board returns 404"""
        response = admin_client.delete(f"{BASE_URL}/api/config/boards/NONEXISTENT_BOARD_XYZ123")
        assert response.status_code == 404, f"Expected 404 for non-existent board, got {response.status_code}: {response.text}"
        print("PASS: Deleting non-existent board returns 404")


class TestDeleteBoardMovesOrders:
    """Test that deleting a board moves its orders to MASTER"""

    def test_17_delete_board_moves_orders_to_master(self, admin_client):
        """When a board is deleted, its orders move to MASTER"""
        # Create a unique board
        board_name = f"ORDERS_MOVE_TEST_{int(time.time())}"
        create_response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": board_name}
        )
        assert create_response.status_code == 200
        board_name_upper = board_name.upper()

        # Create an order on this board
        order_response = admin_client.post(
            f"{BASE_URL}/api/orders",
            json={"client": "TEST_CLIENT_BOARDS", "quantity": 50}
        )
        assert order_response.status_code in [200, 201], f"Failed to create order: {order_response.text}"
        order = order_response.json()
        order_id = order["order_id"]

        # Move the order to the test board
        move_response = admin_client.post(
            f"{BASE_URL}/api/orders/{order_id}/move",
            json={"board": board_name_upper}
        )
        assert move_response.status_code == 200, f"Failed to move order: {move_response.text}"
        
        # Verify order is on the test board
        get_response = admin_client.get(f"{BASE_URL}/api/orders/{order_id}")
        assert get_response.status_code == 200
        assert get_response.json()["board"] == board_name_upper, "Order should be on test board"

        # Delete the board
        delete_response = admin_client.delete(f"{BASE_URL}/api/config/boards/{board_name_upper}")
        assert delete_response.status_code == 200, f"Failed to delete board: {delete_response.text}"

        # Verify order moved to MASTER
        get_response_after = admin_client.get(f"{BASE_URL}/api/orders/{order_id}")
        assert get_response_after.status_code == 200
        assert get_response_after.json()["board"] == "MASTER", \
            f"Order should be moved to MASTER, got: {get_response_after.json()['board']}"
        print("PASS: Order moved from deleted board to MASTER")

        # Cleanup: delete the test order
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")


class TestMoveOrderValidation:
    """Test that move_order validates against dynamic boards list"""

    def test_18_move_order_to_valid_board(self, admin_client):
        """Can move order to a valid board in the dynamic list"""
        # Create an order
        order_response = admin_client.post(
            f"{BASE_URL}/api/orders",
            json={"client": "TEST_MOVE_VALID", "quantity": 10}
        )
        assert order_response.status_code in [200, 201]
        order = order_response.json()
        order_id = order["order_id"]

        # Move to SCHEDULING (a default board)
        move_response = admin_client.post(
            f"{BASE_URL}/api/orders/{order_id}/move",
            json={"board": "SCHEDULING"}
        )
        assert move_response.status_code == 200, f"Failed to move: {move_response.text}"
        assert move_response.json()["board"] == "SCHEDULING"
        print("PASS: Can move order to valid board")

        # Cleanup
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")

    def test_19_move_order_to_invalid_board(self, admin_client):
        """Cannot move order to a board not in dynamic list"""
        # Create an order
        order_response = admin_client.post(
            f"{BASE_URL}/api/orders",
            json={"client": "TEST_MOVE_INVALID", "quantity": 10}
        )
        assert order_response.status_code in [200, 201]
        order = order_response.json()
        order_id = order["order_id"]

        # Try to move to a non-existent board
        move_response = admin_client.post(
            f"{BASE_URL}/api/orders/{order_id}/move",
            json={"board": "INVALID_BOARD_XYZ999"}
        )
        assert move_response.status_code == 400, f"Expected 400 for invalid board, got {move_response.status_code}: {move_response.text}"
        print("PASS: Cannot move order to invalid board (400)")

        # Cleanup
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")

    def test_20_move_order_to_newly_created_board(self, admin_client):
        """Can move order to a newly created dynamic board"""
        # Create a new board
        new_board = f"NEW_BOARD_{int(time.time())}"
        create_response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": new_board}
        )
        assert create_response.status_code == 200
        new_board_upper = new_board.upper()

        # Create an order
        order_response = admin_client.post(
            f"{BASE_URL}/api/orders",
            json={"client": "TEST_MOVE_NEW_BOARD", "quantity": 10}
        )
        assert order_response.status_code in [200, 201]
        order = order_response.json()
        order_id = order["order_id"]

        # Move to the new board
        move_response = admin_client.post(
            f"{BASE_URL}/api/orders/{order_id}/move",
            json={"board": new_board_upper}
        )
        assert move_response.status_code == 200, f"Failed to move to new board: {move_response.text}"
        assert move_response.json()["board"] == new_board_upper
        print(f"PASS: Can move order to newly created board '{new_board_upper}'")

        # Cleanup
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")
        admin_client.delete(f"{BASE_URL}/api/config/boards/{new_board_upper}")


class TestBulkMoveValidation:
    """Test that bulk-move validates against dynamic boards list"""

    def test_21_bulk_move_to_valid_board(self, admin_client):
        """Can bulk move orders to a valid board"""
        # Create orders
        order_ids = []
        for i in range(2):
            resp = admin_client.post(
                f"{BASE_URL}/api/orders",
                json={"client": f"TEST_BULK_{i}", "quantity": 10}
            )
            assert resp.status_code in [200, 201]
            order_ids.append(resp.json()["order_id"])

        # Bulk move to BLANKS
        bulk_response = admin_client.post(
            f"{BASE_URL}/api/orders/bulk-move",
            json={"order_ids": order_ids, "board": "BLANKS"}
        )
        assert bulk_response.status_code == 200, f"Failed bulk move: {bulk_response.text}"
        assert bulk_response.json()["modified_count"] == 2
        print("PASS: Bulk move to valid board works")

        # Cleanup
        for oid in order_ids:
            admin_client.delete(f"{BASE_URL}/api/orders/{oid}/permanent")

    def test_22_bulk_move_to_invalid_board(self, admin_client):
        """Cannot bulk move orders to invalid board"""
        # Create an order
        resp = admin_client.post(
            f"{BASE_URL}/api/orders",
            json={"client": "TEST_BULK_INVALID", "quantity": 10}
        )
        assert resp.status_code in [200, 201]
        order_id = resp.json()["order_id"]

        # Try bulk move to invalid board
        bulk_response = admin_client.post(
            f"{BASE_URL}/api/orders/bulk-move",
            json={"order_ids": [order_id], "board": "INVALID_BOARD_ABC"}
        )
        assert bulk_response.status_code == 400, f"Expected 400 for invalid board, got {bulk_response.status_code}"
        print("PASS: Bulk move to invalid board rejected (400)")

        # Cleanup
        admin_client.delete(f"{BASE_URL}/api/orders/{order_id}/permanent")


class TestBoardPersistence:
    """Test that board changes persist in DB"""

    def test_23_board_changes_persist(self, admin_client):
        """Created boards persist after multiple GET calls"""
        unique_board = f"PERSIST_TEST_{int(time.time())}"
        
        # Create board
        create_response = admin_client.post(
            f"{BASE_URL}/api/config/boards",
            json={"name": unique_board}
        )
        assert create_response.status_code == 200
        unique_board_upper = unique_board.upper()

        # Verify it persists with multiple GET calls
        for i in range(3):
            get_response = admin_client.get(f"{BASE_URL}/api/config/boards")
            assert get_response.status_code == 200
            boards = get_response.json()["boards"]
            assert unique_board_upper in boards, f"Board should persist after GET call {i+1}"

        print("PASS: Board changes persist in DB")

        # Cleanup
        admin_client.delete(f"{BASE_URL}/api/config/boards/{unique_board_upper}")


class TestCleanup:
    """Cleanup test data"""

    def test_99_cleanup_test_data(self, admin_client):
        """Cleanup all TEST_ prefixed data"""
        # Get current boards
        response = admin_client.get(f"{BASE_URL}/api/config/boards")
        if response.status_code == 200:
            boards = response.json()["boards"]
            for board in boards:
                if board.startswith("TEST_") or board.startswith("TO_DELETE") or \
                   board.startswith("LOWERCASE_") or board.startswith("FOR_REGULAR") or \
                   board.startswith("ORDERS_MOVE") or board.startswith("NEW_BOARD") or \
                   board.startswith("PERSIST_"):
                    admin_client.delete(f"{BASE_URL}/api/config/boards/{board}")
                    print(f"Cleaned up board: {board}")

        # Clean up test orders
        orders_response = admin_client.get(f"{BASE_URL}/api/orders")
        if orders_response.status_code == 200:
            orders = orders_response.json()
            for order in orders:
                client = order.get("client", "")
                if client and client.startswith("TEST_"):
                    admin_client.delete(f"{BASE_URL}/api/orders/{order['order_id']}/permanent")
                    print(f"Cleaned up order: {order['order_id']}")

        print("PASS: Cleanup completed")
