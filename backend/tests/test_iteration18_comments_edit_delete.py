"""
Iteration 18 Tests: Comment Edit and Delete functionality
Features tested:
- PUT /api/orders/{order_id}/comments/{comment_id} - Edit comment
- DELETE /api/orders/{order_id}/comments/{comment_id} - Delete comment
- Authorization: Only comment owner or admin can modify/delete
- Validation: Empty content returns 400
- Persistence: edited_at field added on edit
"""
import pytest
import requests
import os
from datetime import datetime

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

class TestCommentEditDelete:
    """Tests for PUT and DELETE comment endpoints"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup test session and create test order for comments"""
        # Create a test user and session
        import subprocess
        result = subprocess.run([
            'mongosh', '--quiet', '--eval', '''
            use('test_database');
            var userId = 'test-comment-crud-' + Date.now();
            var sessionToken = 'test_crud_session_' + Date.now();
            db.users.insertOne({
              user_id: userId,
              email: 'test.crud.' + Date.now() + '@example.com',
              name: 'Test CRUD User',
              role: 'user',
              created_at: new Date()
            });
            db.user_sessions.insertOne({
              user_id: userId,
              session_token: sessionToken,
              expires_at: new Date(Date.now() + 7*24*60*60*1000),
              created_at: new Date()
            });
            print('TOKEN=' + sessionToken);
            print('USERID=' + userId);
            '''
        ], capture_output=True, text=True)
        
        lines = result.stdout.strip().split('\n')
        self.session_token = None
        self.user_id = None
        for line in lines:
            if line.startswith('TOKEN='):
                self.session_token = line.split('=')[1]
            if line.startswith('USERID='):
                self.user_id = line.split('=')[1]
        
        self.headers = {
            'Authorization': f'Bearer {self.session_token}',
            'Content-Type': 'application/json'
        }
        
        # Create test order
        order_resp = requests.post(f'{BASE_URL}/api/orders', 
            headers=self.headers,
            json={'client': 'TEST_COMMENT_CLIENT', 'quantity': 100})
        if order_resp.status_code == 201:
            self.test_order_id = order_resp.json().get('order_id')
        else:
            self.test_order_id = None
        
        yield
        
        # Cleanup
        if self.test_order_id:
            requests.delete(f'{BASE_URL}/api/orders/{self.test_order_id}/permanent', headers=self.headers)

    def test_create_comment_and_verify(self):
        """Test creating a comment - baseline for edit/delete tests"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        response = requests.post(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.headers,
            json={'content': 'Test comment content'}
        )
        
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert 'comment_id' in data
        assert data['content'] == 'Test comment content'
        assert data['order_id'] == self.test_order_id
        assert 'created_at' in data
        assert 'edited_at' not in data or data.get('edited_at') is None
        print(f"✓ Comment created: {data['comment_id']}")

    def test_edit_comment_success(self):
        """Test editing a comment - owner can edit"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        # Create a comment first
        create_resp = requests.post(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.headers,
            json={'content': 'Original content'}
        )
        assert create_resp.status_code == 200
        comment_id = create_resp.json()['comment_id']
        
        # Edit the comment
        edit_resp = requests.put(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/{comment_id}',
            headers=self.headers,
            json={'content': 'Updated content'}
        )
        
        assert edit_resp.status_code == 200, f"Expected 200, got {edit_resp.status_code}: {edit_resp.text}"
        data = edit_resp.json()
        assert data['content'] == 'Updated content'
        assert 'edited_at' in data
        assert data['edited_at'] is not None
        print(f"✓ Comment edited successfully, edited_at: {data['edited_at']}")
        
        # Verify via GET
        get_resp = requests.get(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.headers
        )
        assert get_resp.status_code == 200
        comments = get_resp.json()
        edited_comment = next((c for c in comments if c['comment_id'] == comment_id), None)
        assert edited_comment is not None
        assert edited_comment['content'] == 'Updated content'
        assert edited_comment.get('edited_at') is not None
        print("✓ Edit verified via GET - content and edited_at field persisted")

    def test_edit_comment_empty_content_fails(self):
        """Test that editing with empty content returns 400"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        # Create a comment first
        create_resp = requests.post(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.headers,
            json={'content': 'Original content'}
        )
        assert create_resp.status_code == 200
        comment_id = create_resp.json()['comment_id']
        
        # Try to edit with empty content
        edit_resp = requests.put(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/{comment_id}',
            headers=self.headers,
            json={'content': ''}
        )
        
        assert edit_resp.status_code == 400, f"Expected 400, got {edit_resp.status_code}"
        print("✓ Empty content returns 400 as expected")
        
        # Also test whitespace-only
        edit_resp2 = requests.put(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/{comment_id}',
            headers=self.headers,
            json={'content': '   '}
        )
        assert edit_resp2.status_code == 400
        print("✓ Whitespace-only content returns 400 as expected")

    def test_edit_comment_not_found(self):
        """Test editing non-existent comment returns 404"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        response = requests.put(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/nonexistent_comment_id',
            headers=self.headers,
            json={'content': 'Some content'}
        )
        
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        print("✓ Non-existent comment returns 404")

    def test_delete_comment_success(self):
        """Test deleting a comment - owner can delete"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        # Create a comment first
        create_resp = requests.post(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.headers,
            json={'content': 'Comment to delete'}
        )
        assert create_resp.status_code == 200
        comment_id = create_resp.json()['comment_id']
        
        # Delete the comment
        delete_resp = requests.delete(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/{comment_id}',
            headers=self.headers
        )
        
        assert delete_resp.status_code == 200, f"Expected 200, got {delete_resp.status_code}: {delete_resp.text}"
        print(f"✓ Comment deleted successfully")
        
        # Verify via GET - comment should not exist
        get_resp = requests.get(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.headers
        )
        assert get_resp.status_code == 200
        comments = get_resp.json()
        deleted_comment = next((c for c in comments if c['comment_id'] == comment_id), None)
        assert deleted_comment is None
        print("✓ Delete verified via GET - comment no longer exists")

    def test_delete_comment_not_found(self):
        """Test deleting non-existent comment returns 404"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        response = requests.delete(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/nonexistent_comment_id',
            headers=self.headers
        )
        
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        print("✓ Non-existent comment delete returns 404")


class TestCommentAuthorization:
    """Tests for authorization on comment edit/delete"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """Setup two users - one regular, one admin"""
        import subprocess
        
        # Create regular user
        result1 = subprocess.run([
            'mongosh', '--quiet', '--eval', f'''
            use('test_database');
            var userId = 'test-regular-user-' + Date.now();
            var sessionToken = 'test_regular_' + Date.now();
            db.users.insertOne({{
              user_id: userId,
              email: 'test.regular.' + Date.now() + '@example.com',
              name: 'Regular User',
              role: 'user',
              created_at: new Date()
            }});
            db.user_sessions.insertOne({{
              user_id: userId,
              session_token: sessionToken,
              expires_at: new Date(Date.now() + 7*24*60*60*1000),
              created_at: new Date()
            }});
            print('TOKEN=' + sessionToken);
            print('USERID=' + userId);
            '''
        ], capture_output=True, text=True)
        
        lines1 = result1.stdout.strip().split('\n')
        self.regular_token = None
        self.regular_user_id = None
        for line in lines1:
            if line.startswith('TOKEN='):
                self.regular_token = line.split('=')[1]
            if line.startswith('USERID='):
                self.regular_user_id = line.split('=')[1]
        
        # Create admin user
        result2 = subprocess.run([
            'mongosh', '--quiet', '--eval', f'''
            use('test_database');
            var userId = 'test-admin-user-' + Date.now();
            var sessionToken = 'test_admin_' + Date.now();
            db.users.insertOne({{
              user_id: userId,
              email: 'test.admin.' + Date.now() + '@example.com',
              name: 'Admin User',
              role: 'admin',
              created_at: new Date()
            }});
            db.user_sessions.insertOne({{
              user_id: userId,
              session_token: sessionToken,
              expires_at: new Date(Date.now() + 7*24*60*60*1000),
              created_at: new Date()
            }});
            print('TOKEN=' + sessionToken);
            print('USERID=' + userId);
            '''
        ], capture_output=True, text=True)
        
        lines2 = result2.stdout.strip().split('\n')
        self.admin_token = None
        self.admin_user_id = None
        for line in lines2:
            if line.startswith('TOKEN='):
                self.admin_token = line.split('=')[1]
            if line.startswith('USERID='):
                self.admin_user_id = line.split('=')[1]
        
        self.regular_headers = {
            'Authorization': f'Bearer {self.regular_token}',
            'Content-Type': 'application/json'
        }
        self.admin_headers = {
            'Authorization': f'Bearer {self.admin_token}',
            'Content-Type': 'application/json'
        }
        
        # Create test order as admin
        order_resp = requests.post(f'{BASE_URL}/api/orders', 
            headers=self.admin_headers,
            json={'client': 'TEST_AUTH_CLIENT', 'quantity': 50})
        self.test_order_id = order_resp.json().get('order_id') if order_resp.status_code == 201 else None
        
        yield
        
        # Cleanup
        if self.test_order_id:
            requests.delete(f'{BASE_URL}/api/orders/{self.test_order_id}/permanent', headers=self.admin_headers)

    def test_other_user_cannot_edit_comment(self):
        """Test that a user cannot edit another user's comment (returns 403)"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        # Regular user creates a comment
        create_resp = requests.post(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.regular_headers,
            json={'content': 'Regular user comment'}
        )
        assert create_resp.status_code == 200
        comment_id = create_resp.json()['comment_id']
        
        # Create another non-admin user
        import subprocess
        result = subprocess.run([
            'mongosh', '--quiet', '--eval', f'''
            use('test_database');
            var userId = 'test-other-user-' + Date.now();
            var sessionToken = 'test_other_' + Date.now();
            db.users.insertOne({{
              user_id: userId,
              email: 'test.other.' + Date.now() + '@example.com',
              name: 'Other User',
              role: 'user',
              created_at: new Date()
            }});
            db.user_sessions.insertOne({{
              user_id: userId,
              session_token: sessionToken,
              expires_at: new Date(Date.now() + 7*24*60*60*1000),
              created_at: new Date()
            }});
            print('TOKEN=' + sessionToken);
            '''
        ], capture_output=True, text=True)
        
        other_token = None
        for line in result.stdout.strip().split('\n'):
            if line.startswith('TOKEN='):
                other_token = line.split('=')[1]
        
        other_headers = {
            'Authorization': f'Bearer {other_token}',
            'Content-Type': 'application/json'
        }
        
        # Other user tries to edit
        edit_resp = requests.put(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/{comment_id}',
            headers=other_headers,
            json={'content': 'Hijacked content'}
        )
        
        assert edit_resp.status_code == 403, f"Expected 403, got {edit_resp.status_code}"
        print("✓ Non-owner cannot edit comment - returns 403")

    def test_other_user_cannot_delete_comment(self):
        """Test that a user cannot delete another user's comment (returns 403)"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        # Regular user creates a comment
        create_resp = requests.post(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.regular_headers,
            json={'content': 'Regular user comment to keep'}
        )
        assert create_resp.status_code == 200
        comment_id = create_resp.json()['comment_id']
        
        # Create another non-admin user
        import subprocess
        result = subprocess.run([
            'mongosh', '--quiet', '--eval', f'''
            use('test_database');
            var userId = 'test-other-del-' + Date.now();
            var sessionToken = 'test_other_del_' + Date.now();
            db.users.insertOne({{
              user_id: userId,
              email: 'test.otherdel.' + Date.now() + '@example.com',
              name: 'Other Delete User',
              role: 'user',
              created_at: new Date()
            }});
            db.user_sessions.insertOne({{
              user_id: userId,
              session_token: sessionToken,
              expires_at: new Date(Date.now() + 7*24*60*60*1000),
              created_at: new Date()
            }});
            print('TOKEN=' + sessionToken);
            '''
        ], capture_output=True, text=True)
        
        other_token = None
        for line in result.stdout.strip().split('\n'):
            if line.startswith('TOKEN='):
                other_token = line.split('=')[1]
        
        other_headers = {
            'Authorization': f'Bearer {other_token}',
            'Content-Type': 'application/json'
        }
        
        # Other user tries to delete
        delete_resp = requests.delete(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/{comment_id}',
            headers=other_headers
        )
        
        assert delete_resp.status_code == 403, f"Expected 403, got {delete_resp.status_code}"
        print("✓ Non-owner cannot delete comment - returns 403")

    def test_admin_can_edit_any_comment(self):
        """Test that admin can edit any user's comment"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        # Regular user creates a comment
        create_resp = requests.post(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.regular_headers,
            json={'content': 'User comment for admin to edit'}
        )
        assert create_resp.status_code == 200
        comment_id = create_resp.json()['comment_id']
        
        # Admin edits the comment
        edit_resp = requests.put(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/{comment_id}',
            headers=self.admin_headers,
            json={'content': 'Admin edited this comment'}
        )
        
        assert edit_resp.status_code == 200, f"Expected 200, got {edit_resp.status_code}: {edit_resp.text}"
        data = edit_resp.json()
        assert data['content'] == 'Admin edited this comment'
        print("✓ Admin can edit any user's comment")

    def test_admin_can_delete_any_comment(self):
        """Test that admin can delete any user's comment"""
        if not self.test_order_id:
            pytest.skip("No test order created")
        
        # Regular user creates a comment
        create_resp = requests.post(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments',
            headers=self.regular_headers,
            json={'content': 'User comment for admin to delete'}
        )
        assert create_resp.status_code == 200
        comment_id = create_resp.json()['comment_id']
        
        # Admin deletes the comment
        delete_resp = requests.delete(
            f'{BASE_URL}/api/orders/{self.test_order_id}/comments/{comment_id}',
            headers=self.admin_headers
        )
        
        assert delete_resp.status_code == 200, f"Expected 200, got {delete_resp.status_code}: {delete_resp.text}"
        print("✓ Admin can delete any user's comment")


if __name__ == "__main__":
    pytest.main([__file__, '-v', '--tb=short'])
