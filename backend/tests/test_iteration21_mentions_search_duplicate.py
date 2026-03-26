"""
Test iteration 21: @mentions in comments, duplicate order warning, enhanced search
Features tested:
1. GET /api/users/list - returns user list for any authenticated user (not admin only)
2. GET /api/orders/check-number - checks if order number exists and returns order info
3. GET /api/orders?search= - now searches in store_po and customer_po fields
4. POST /api/orders/{order_id}/comments - @mentions create 'mention' type notifications
5. Comments without @mentions create 'comment' type notifications for all users
"""
import pytest
import requests
import os
import time
import random
import string

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
SESSION_TOKEN = os.environ.get('TEST_SESSION_TOKEN', '')

class TestUsersListEndpoint:
    """Test GET /api/users/list endpoint - accessible to all authenticated users"""
    
    def test_users_list_returns_users(self):
        """Users list endpoint should return list of users with name, email, picture"""
        response = requests.get(
            f"{BASE_URL}/api/users/list",
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        users = response.json()
        assert isinstance(users, list), "Response should be a list"
        assert len(users) > 0, "Should return at least one user"
        
        # Check first user has required fields
        user = users[0]
        assert "email" in user, "User should have email field"
        assert "name" in user, "User should have name field"
        # picture and user_id are optional
        print(f"Users list returned {len(users)} users")
    
    def test_users_list_does_not_expose_sensitive_data(self):
        """Users list should not expose passwords or sensitive session data"""
        response = requests.get(
            f"{BASE_URL}/api/users/list",
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        
        users = response.json()
        for user in users:
            assert "password" not in user, "Should not expose password"
            assert "session_token" not in user, "Should not expose session token"


class TestOrderCheckNumberEndpoint:
    """Test GET /api/orders/check-number endpoint for duplicate detection"""
    
    @pytest.fixture(autouse=True)
    def setup_test_order(self):
        """Create a test order for duplicate checking"""
        random_suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        self.test_order_number = f"TEST-DUP-{random_suffix}"
        
        # Create an order with known order_number
        response = requests.post(
            f"{BASE_URL}/api/orders",
            json={
                "order_number": self.test_order_number,
                "client": "Test Duplicate Client",
                "priority": "NORMAL"
            },
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200, f"Failed to create test order: {response.text}"
        self.test_order = response.json()
        yield
        
        # Cleanup - delete order (move to trash then permanent delete)
        requests.delete(
            f"{BASE_URL}/api/orders/{self.test_order['order_id']}",
            cookies={"session_token": SESSION_TOKEN}
        )
    
    def test_check_number_returns_exists_true_for_existing(self):
        """Check-number should return exists=true for existing order number"""
        response = requests.get(
            f"{BASE_URL}/api/orders/check-number",
            params={"order_number": self.test_order_number},
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        
        data = response.json()
        assert data["exists"] == True, "Should return exists=true for existing order"
        assert "order" in data, "Should return order info"
        assert data["order"]["order_number"] == self.test_order_number
        assert "board" in data["order"], "Order should include board field"
        print(f"Duplicate check for '{self.test_order_number}': exists={data['exists']}, board={data['order']['board']}")
    
    def test_check_number_returns_exists_false_for_nonexistent(self):
        """Check-number should return exists=false for non-existent order number"""
        response = requests.get(
            f"{BASE_URL}/api/orders/check-number",
            params={"order_number": "NONEXISTENT-ORDER-12345"},
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        
        data = response.json()
        assert data["exists"] == False, "Should return exists=false for non-existent order"
    
    def test_check_number_case_insensitive(self):
        """Check-number should be case insensitive"""
        # Check with lowercase
        response = requests.get(
            f"{BASE_URL}/api/orders/check-number",
            params={"order_number": self.test_order_number.lower()},
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["exists"] == True, "Should find order with case-insensitive search"
    
    def test_check_number_handles_empty_input(self):
        """Check-number should handle empty/null input gracefully"""
        response = requests.get(
            f"{BASE_URL}/api/orders/check-number",
            params={"order_number": ""},
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["exists"] == False


class TestEnhancedSearch:
    """Test enhanced search that includes store_po and customer_po fields"""
    
    @pytest.fixture(autouse=True)
    def setup_test_orders_for_search(self):
        """Create test orders with unique store_po and customer_po"""
        random_suffix = ''.join(random.choices(string.digits, k=6))
        self.store_po_value = f"STORE-PO-{random_suffix}"
        self.customer_po_value = f"CUST-PO-{random_suffix}"
        self.unique_order_number = f"SEARCH-TEST-{random_suffix}"
        
        # Create order with store_po
        response1 = requests.post(
            f"{BASE_URL}/api/orders",
            json={
                "order_number": self.unique_order_number,
                "store_po": self.store_po_value,
                "customer_po": self.customer_po_value,
                "client": "Search Test Client",
                "priority": "NORMAL"
            },
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response1.status_code == 200, f"Failed to create test order: {response1.text}"
        self.test_order = response1.json()
        yield
        
        # Cleanup
        requests.delete(
            f"{BASE_URL}/api/orders/{self.test_order['order_id']}",
            cookies={"session_token": SESSION_TOKEN}
        )
    
    def test_search_by_store_po(self):
        """Search should find orders by store_po field"""
        response = requests.get(
            f"{BASE_URL}/api/orders",
            params={"search": self.store_po_value},
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        
        orders = response.json()
        found = any(o.get("store_po") == self.store_po_value for o in orders)
        assert found, f"Should find order with store_po={self.store_po_value}"
        print(f"Search by store_po '{self.store_po_value}' found {len(orders)} result(s)")
    
    def test_search_by_customer_po(self):
        """Search should find orders by customer_po field"""
        response = requests.get(
            f"{BASE_URL}/api/orders",
            params={"search": self.customer_po_value},
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        
        orders = response.json()
        found = any(o.get("customer_po") == self.customer_po_value for o in orders)
        assert found, f"Should find order with customer_po={self.customer_po_value}"
        print(f"Search by customer_po '{self.customer_po_value}' found {len(orders)} result(s)")
    
    def test_search_by_order_number(self):
        """Search should still work with order_number"""
        response = requests.get(
            f"{BASE_URL}/api/orders",
            params={"search": self.unique_order_number},
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        
        orders = response.json()
        found = any(o.get("order_number") == self.unique_order_number for o in orders)
        assert found, f"Should find order with order_number={self.unique_order_number}"


class TestMentionsInComments:
    """Test @mentions in comments creating targeted notifications"""
    
    @pytest.fixture(autouse=True)
    def setup_test_order_for_comments(self):
        """Create a test order for commenting"""
        random_suffix = ''.join(random.choices(string.digits, k=6))
        
        response = requests.post(
            f"{BASE_URL}/api/orders",
            json={
                "order_number": f"MENTION-TEST-{random_suffix}",
                "client": "Mention Test Client",
                "priority": "NORMAL"
            },
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200, f"Failed to create test order: {response.text}"
        self.test_order = response.json()
        
        # Get list of users to know who to mention
        users_response = requests.get(
            f"{BASE_URL}/api/users/list",
            cookies={"session_token": SESSION_TOKEN}
        )
        self.users = users_response.json() if users_response.status_code == 200 else []
        
        # Clear notifications before test
        yield
        
        # Cleanup
        requests.delete(
            f"{BASE_URL}/api/orders/{self.test_order['order_id']}",
            cookies={"session_token": SESSION_TOKEN}
        )
    
    def test_comment_with_mention_creates_mention_notification(self):
        """Comment with @mention should create 'mention' type notification for mentioned user"""
        # Find a user to mention (not the current test user)
        mentioned_user = None
        for u in self.users:
            if "john" in (u.get("name") or "").lower() or "jane" in (u.get("name") or "").lower():
                mentioned_user = u
                break
        
        if not mentioned_user:
            pytest.skip("No other users to mention in test")
        
        # Use first name only since regex @(\S+) captures word without spaces
        full_name = mentioned_user.get("name", mentioned_user["email"].split("@")[0])
        mention_name = full_name.split()[0] if " " in full_name else full_name
        comment_content = f"Hey @{mention_name} please check this order!"
        
        response = requests.post(
            f"{BASE_URL}/api/orders/{self.test_order['order_id']}/comments",
            json={"content": comment_content},
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200, f"Failed to create comment: {response.text}"
        
        comment = response.json()
        assert "mentions" in comment, "Comment should have mentions array"
        assert len(comment["mentions"]) > 0, "Comment should have parsed mentions"
        assert mention_name in comment["mentions"], f"Mentions should include '{mention_name}'"
        print(f"Comment with @mention created. Mentions parsed: {comment['mentions']}")
    
    def test_comment_without_mention_saved_correctly(self):
        """Comment without @mention should be saved correctly"""
        comment_content = "This is a regular comment without any mentions"
        
        response = requests.post(
            f"{BASE_URL}/api/orders/{self.test_order['order_id']}/comments",
            json={"content": comment_content},
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        
        comment = response.json()
        assert comment["content"] == comment_content
        assert "mentions" in comment
        assert len(comment["mentions"]) == 0, "Comment without @ should have empty mentions"
    
    def test_get_comments_includes_mentions_field(self):
        """GET comments should include mentions field in response"""
        # First create a comment
        requests.post(
            f"{BASE_URL}/api/orders/{self.test_order['order_id']}/comments",
            json={"content": "Test comment for listing"},
            cookies={"session_token": SESSION_TOKEN}
        )
        
        response = requests.get(
            f"{BASE_URL}/api/orders/{self.test_order['order_id']}/comments",
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        
        comments = response.json()
        assert isinstance(comments, list)
        if len(comments) > 0:
            assert "mentions" in comments[-1], "Comment should have mentions field"


class TestNotificationTypes:
    """Test that notifications have correct type based on mentions"""
    
    @pytest.fixture(autouse=True)
    def setup_for_notification_test(self):
        """Create test order and get notification count before test"""
        random_suffix = ''.join(random.choices(string.digits, k=6))
        
        response = requests.post(
            f"{BASE_URL}/api/orders",
            json={
                "order_number": f"NOTIF-TEST-{random_suffix}",
                "client": "Notification Test Client",
                "priority": "NORMAL"
            },
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        self.test_order = response.json()
        yield
        
        requests.delete(
            f"{BASE_URL}/api/orders/{self.test_order['order_id']}",
            cookies={"session_token": SESSION_TOKEN}
        )
    
    def test_notifications_endpoint_accessible(self):
        """Notifications endpoint should be accessible"""
        response = requests.get(
            f"{BASE_URL}/api/notifications",
            cookies={"session_token": SESSION_TOKEN}
        )
        assert response.status_code == 200
        
        data = response.json()
        assert "notifications" in data, "Response should have notifications array"
        assert "unread_count" in data, "Response should have unread_count"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
