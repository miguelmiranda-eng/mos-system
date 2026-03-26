"""
Iteration 45 Backend Tests: Duplicate Users Fix & Board Permissions
Tests:
1. Verify no duplicate users exist in DB after cleanup
2. Verify unique index on email prevents duplicate user creation
3. Board permissions CRUD: GET/PUT per user and /me endpoint
4. User invite uses upsert to prevent duplicates
5. Config descriptions endpoints
"""
import pytest
import requests
import os
import time
import uuid

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

# Test session - we'll create one dynamically
TEST_USER_EMAIL = f"test_iter45_{int(time.time())}@test.com"
TEST_SESSION_TOKEN = f"test_session_iter45_{int(time.time())}"

# Admin tokens from iteration 28 tests
ADMIN_TOKEN = "test_session_iter28_admin_1772745164956"


class TestSetup:
    """Create test session for authenticated tests"""
    
    @pytest.fixture(scope="class", autouse=True)
    def setup_test_session(self):
        """Create test user session in MongoDB"""
        import asyncio
        from motor.motor_asyncio import AsyncIOMotorClient
        
        async def create_session():
            client = AsyncIOMotorClient('mongodb://localhost:27017')
            db = client['test_database']
            
            # Create admin test user with unique email
            admin_email = f"test_admin_iter45_{int(time.time())}@test.com"
            admin_user_id = f"test_admin_{uuid.uuid4().hex[:8]}"
            await db.users.update_one(
                {"email": admin_email},
                {"$set": {
                    "user_id": admin_user_id,
                    "email": admin_email,
                    "name": "Test Admin Iter45",
                    "role": "admin"
                }},
                upsert=True
            )
            
            # Create admin session
            admin_token = f"admin_session_iter45_{int(time.time())}"
            await db.user_sessions.insert_one({
                "user_id": admin_user_id,
                "session_token": admin_token,
                "expires_at": "2030-01-01T00:00:00Z"
            })
            
            # Create regular test user
            user_email = f"test_user_iter45_{int(time.time())}@test.com"
            user_id = f"test_user_{uuid.uuid4().hex[:8]}"
            await db.users.update_one(
                {"email": user_email},
                {"$set": {
                    "user_id": user_id,
                    "email": user_email,
                    "name": "Test User Iter45",
                    "role": "user"
                }},
                upsert=True
            )
            
            # Create user session
            user_token = f"user_session_iter45_{int(time.time())}"
            await db.user_sessions.insert_one({
                "user_id": user_id,
                "session_token": user_token,
                "expires_at": "2030-01-01T00:00:00Z"
            })
            
            client.close()
            return {
                "admin_email": admin_email,
                "admin_token": admin_token,
                "admin_user_id": admin_user_id,
                "user_email": user_email,
                "user_token": user_token,
                "user_id": user_id
            }
        
        result = asyncio.get_event_loop().run_until_complete(create_session())
        self.__class__.admin_email = result["admin_email"]
        self.__class__.admin_token = result["admin_token"]
        self.__class__.admin_user_id = result["admin_user_id"]
        self.__class__.user_email = result["user_email"]
        self.__class__.user_token = result["user_token"]
        self.__class__.user_id = result["user_id"]
        
        yield result
        
        # Cleanup
        async def cleanup():
            client = AsyncIOMotorClient('mongodb://localhost:27017')
            db = client['test_database']
            await db.users.delete_many({"email": {"$regex": "test_.*iter45.*@test.com"}})
            await db.user_sessions.delete_many({"session_token": {"$regex": ".*iter45.*"}})
            await db.board_permissions.delete_many({"email": {"$regex": "test_.*iter45.*@test.com"}})
            client.close()
        
        asyncio.get_event_loop().run_until_complete(cleanup())


# ==================== DUPLICATE USERS TESTS ====================

class TestNoDuplicateUsers:
    """Verify no duplicate users exist after cleanup"""
    
    def test_01_no_duplicate_emails_in_database(self):
        """Check that all user emails are unique in DB"""
        import asyncio
        from motor.motor_asyncio import AsyncIOMotorClient
        
        async def check_duplicates():
            client = AsyncIOMotorClient('mongodb://localhost:27017')
            db = client['test_database']
            
            # Get all emails
            cursor = db.users.find({}, {'email': 1, '_id': 0})
            emails = []
            async for doc in cursor:
                emails.append(doc.get('email'))
            
            client.close()
            
            # Check for duplicates
            unique_emails = set(emails)
            return len(emails) == len(unique_emails), len(emails), len(unique_emails)
        
        no_duplicates, total, unique = asyncio.get_event_loop().run_until_complete(check_duplicates())
        assert no_duplicates, f"Found duplicates: {total} total, {unique} unique"
        print(f"✓ No duplicate emails: {total} users, all unique")
    
    def test_02_unique_index_exists_on_email(self):
        """Verify unique index on email field exists"""
        import asyncio
        from motor.motor_asyncio import AsyncIOMotorClient
        
        async def check_index():
            client = AsyncIOMotorClient('mongodb://localhost:27017')
            db = client['test_database']
            
            indexes = await db.users.index_information()
            client.close()
            
            # Look for unique index on email
            for name, info in indexes.items():
                if info.get('key') == [('email', 1)] and info.get('unique') == True:
                    return True, name
            return False, None
        
        has_index, index_name = asyncio.get_event_loop().run_until_complete(check_index())
        assert has_index, "No unique index found on email field"
        print(f"✓ Unique index on email exists: {index_name}")
    
    def test_03_unique_index_prevents_duplicate_insert(self):
        """Verify unique index prevents inserting duplicate emails"""
        import asyncio
        from motor.motor_asyncio import AsyncIOMotorClient
        from pymongo.errors import DuplicateKeyError
        
        async def try_duplicate():
            client = AsyncIOMotorClient('mongodb://localhost:27017')
            db = client['test_database']
            
            test_email = f"test_dup_check_{int(time.time())}@test.com"
            
            # Insert first user
            await db.users.insert_one({
                "email": test_email,
                "name": "First User",
                "role": "user"
            })
            
            # Try to insert duplicate - should fail
            try:
                await db.users.insert_one({
                    "email": test_email,
                    "name": "Duplicate User",
                    "role": "user"
                })
                result = False  # Should not reach here
            except DuplicateKeyError:
                result = True  # Expected behavior
            
            # Cleanup
            await db.users.delete_one({"email": test_email})
            client.close()
            return result
        
        prevented = asyncio.get_event_loop().run_until_complete(try_duplicate())
        assert prevented, "Unique index did not prevent duplicate insertion"
        print("✓ Unique index correctly prevents duplicate email insertion")


# ==================== BOARD PERMISSIONS TESTS ====================

class TestBoardPermissionsEndpoints(TestSetup):
    """Test board permissions CRUD operations"""
    
    def test_10_get_user_board_permissions_empty(self):
        """GET /api/users/{email}/board-permissions returns empty for new user"""
        response = requests.get(
            f"{BASE_URL}/api/users/{self.user_email}/board-permissions",
            cookies={"session_token": self.admin_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert data == {}, f"Expected empty dict for new user, got {data}"
        print(f"✓ GET board-permissions returns empty for new user")
    
    def test_11_put_user_board_permissions_creates(self):
        """PUT /api/users/{email}/board-permissions creates permissions"""
        permissions = {
            "SCHEDULING": "edit",
            "BLANKS": "view",
            "SCREENS": "none"
        }
        response = requests.put(
            f"{BASE_URL}/api/users/{self.user_email}/board-permissions",
            json=permissions,
            cookies={"session_token": self.admin_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "message" in data
        print(f"✓ PUT board-permissions creates permissions for user")
    
    def test_12_get_user_board_permissions_returns_saved(self):
        """GET /api/users/{email}/board-permissions returns saved permissions"""
        response = requests.get(
            f"{BASE_URL}/api/users/{self.user_email}/board-permissions",
            cookies={"session_token": self.admin_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert data.get("SCHEDULING") == "edit"
        assert data.get("BLANKS") == "view"
        assert data.get("SCREENS") == "none"
        print(f"✓ GET board-permissions returns saved permissions: {data}")
    
    def test_13_put_user_board_permissions_updates(self):
        """PUT /api/users/{email}/board-permissions updates existing permissions"""
        updated_permissions = {
            "SCHEDULING": "view",
            "BLANKS": "edit",
            "SCREENS": "edit",
            "MASTER": "none"
        }
        response = requests.put(
            f"{BASE_URL}/api/users/{self.user_email}/board-permissions",
            json=updated_permissions,
            cookies={"session_token": self.admin_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        
        # Verify update
        get_response = requests.get(
            f"{BASE_URL}/api/users/{self.user_email}/board-permissions",
            cookies={"session_token": self.admin_token}
        )
        data = get_response.json()
        assert data.get("SCHEDULING") == "view"
        assert data.get("BLANKS") == "edit"
        assert data.get("MASTER") == "none"
        print(f"✓ PUT board-permissions updates existing permissions")
    
    def test_14_get_board_permissions_requires_admin(self):
        """GET /api/users/{email}/board-permissions requires admin"""
        response = requests.get(
            f"{BASE_URL}/api/users/{self.user_email}/board-permissions",
            cookies={"session_token": self.user_token}
        )
        assert response.status_code == 403, f"Expected 403 for non-admin, got {response.status_code}"
        print(f"✓ GET board-permissions requires admin (403 for regular user)")
    
    def test_15_put_board_permissions_requires_admin(self):
        """PUT /api/users/{email}/board-permissions requires admin"""
        response = requests.put(
            f"{BASE_URL}/api/users/{self.user_email}/board-permissions",
            json={"SCHEDULING": "view"},
            cookies={"session_token": self.user_token}
        )
        assert response.status_code == 403, f"Expected 403 for non-admin, got {response.status_code}"
        print(f"✓ PUT board-permissions requires admin (403 for regular user)")
    
    def test_16_get_my_board_permissions_as_user(self):
        """GET /api/board-permissions/me returns permissions for current user"""
        response = requests.get(
            f"{BASE_URL}/api/board-permissions/me",
            cookies={"session_token": self.user_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        # Should match what we saved for this user
        assert data.get("SCHEDULING") == "view"
        assert data.get("BLANKS") == "edit"
        print(f"✓ GET /api/board-permissions/me returns user's permissions: {data}")
    
    def test_17_get_my_board_permissions_empty_user(self):
        """GET /api/board-permissions/me returns empty for user without permissions"""
        # Create a new user without permissions
        import asyncio
        from motor.motor_asyncio import AsyncIOMotorClient
        
        async def create_temp_user():
            client = AsyncIOMotorClient('mongodb://localhost:27017')
            db = client['test_database']
            
            temp_email = f"test_no_perms_{int(time.time())}@test.com"
            temp_user_id = f"temp_user_{uuid.uuid4().hex[:8]}"
            await db.users.insert_one({
                "user_id": temp_user_id,
                "email": temp_email,
                "name": "Temp No Perms User",
                "role": "user"
            })
            
            temp_token = f"temp_token_{int(time.time())}"
            await db.user_sessions.insert_one({
                "user_id": temp_user_id,
                "session_token": temp_token,
                "expires_at": "2030-01-01T00:00:00Z"
            })
            
            client.close()
            return temp_email, temp_token
        
        temp_email, temp_token = asyncio.get_event_loop().run_until_complete(create_temp_user())
        
        response = requests.get(
            f"{BASE_URL}/api/board-permissions/me",
            cookies={"session_token": temp_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert data == {}, f"Expected empty permissions for new user, got {data}"
        print(f"✓ GET /api/board-permissions/me returns empty for user without permissions")
        
        # Cleanup
        async def cleanup():
            client = AsyncIOMotorClient('mongodb://localhost:27017')
            db = client['test_database']
            await db.users.delete_one({"email": temp_email})
            await db.user_sessions.delete_one({"session_token": temp_token})
            client.close()
        
        asyncio.get_event_loop().run_until_complete(cleanup())


# ==================== USER INVITE UPSERT TESTS ====================

class TestUserInviteUpsert(TestSetup):
    """Test that user invite uses upsert to prevent duplicates"""
    
    def test_20_invite_new_user_creates(self):
        """POST /api/users/invite creates new user"""
        new_email = f"invited_user_{int(time.time())}@test.com"
        response = requests.post(
            f"{BASE_URL}/api/users/invite",
            json={"email": new_email, "role": "user"},
            cookies={"session_token": self.admin_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert "message" in data
        print(f"✓ POST /api/users/invite creates new user: {new_email}")
        
        # Cleanup
        requests.delete(
            f"{BASE_URL}/api/users/{new_email}",
            cookies={"session_token": self.admin_token}
        )
    
    def test_21_invite_existing_user_returns_400(self):
        """POST /api/users/invite returns 400 for existing user"""
        # First create user
        test_email = f"invited_existing_{int(time.time())}@test.com"
        requests.post(
            f"{BASE_URL}/api/users/invite",
            json={"email": test_email, "role": "user"},
            cookies={"session_token": self.admin_token}
        )
        
        # Try to invite again
        response = requests.post(
            f"{BASE_URL}/api/users/invite",
            json={"email": test_email, "role": "admin"},
            cookies={"session_token": self.admin_token}
        )
        assert response.status_code == 400, f"Expected 400 for existing user, got {response.status_code}"
        assert "ya existe" in response.json().get("detail", "").lower()
        print(f"✓ POST /api/users/invite returns 400 for existing user")
        
        # Cleanup
        requests.delete(
            f"{BASE_URL}/api/users/{test_email}",
            cookies={"session_token": self.admin_token}
        )
    
    def test_22_invite_requires_admin(self):
        """POST /api/users/invite requires admin role"""
        response = requests.post(
            f"{BASE_URL}/api/users/invite",
            json={"email": "someone@test.com", "role": "user"},
            cookies={"session_token": self.user_token}
        )
        assert response.status_code == 403, f"Expected 403 for non-admin, got {response.status_code}"
        print(f"✓ POST /api/users/invite requires admin (403 for regular user)")
    
    def test_23_invite_invalid_email_returns_400(self):
        """POST /api/users/invite returns 400 for invalid email"""
        response = requests.post(
            f"{BASE_URL}/api/users/invite",
            json={"email": "invalid-email", "role": "user"},
            cookies={"session_token": self.admin_token}
        )
        assert response.status_code == 400, f"Expected 400 for invalid email, got {response.status_code}"
        print(f"✓ POST /api/users/invite returns 400 for invalid email")


# ==================== CONFIG DESCRIPTIONS TESTS ====================

class TestConfigDescriptions(TestSetup):
    """Test config descriptions endpoints"""
    
    def test_30_get_descriptions_empty_initially(self):
        """GET /api/config/descriptions returns empty initially or existing data"""
        response = requests.get(
            f"{BASE_URL}/api/config/descriptions",
            cookies={"session_token": self.user_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        data = response.json()
        assert isinstance(data, dict)
        print(f"✓ GET /api/config/descriptions returns dict: {data}")
    
    def test_31_put_descriptions_stores_data(self):
        """PUT /api/config/descriptions stores label descriptions"""
        descriptions = {
            "STATUS_PENDIENTE": "Order is waiting to be processed",
            "STATUS_EN_PROCESO": "Order is being manufactured",
            "PRIORITY_ALTA": "High priority - needs immediate attention",
            "CUSTOM_FIELD_1": "Test custom field description"
        }
        response = requests.put(
            f"{BASE_URL}/api/config/descriptions",
            json=descriptions,
            cookies={"session_token": self.admin_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"
        print(f"✓ PUT /api/config/descriptions stores descriptions")
    
    def test_32_get_descriptions_returns_saved(self):
        """GET /api/config/descriptions returns saved descriptions"""
        response = requests.get(
            f"{BASE_URL}/api/config/descriptions",
            cookies={"session_token": self.user_token}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert data.get("STATUS_PENDIENTE") == "Order is waiting to be processed"
        assert data.get("PRIORITY_ALTA") == "High priority - needs immediate attention"
        print(f"✓ GET /api/config/descriptions returns saved data: {len(data)} keys")
    
    def test_33_put_descriptions_requires_admin(self):
        """PUT /api/config/descriptions requires admin role"""
        response = requests.put(
            f"{BASE_URL}/api/config/descriptions",
            json={"TEST": "value"},
            cookies={"session_token": self.user_token}
        )
        assert response.status_code == 403, f"Expected 403 for non-admin, got {response.status_code}"
        print(f"✓ PUT /api/config/descriptions requires admin (403 for regular user)")
    
    def test_34_get_descriptions_requires_auth(self):
        """GET /api/config/descriptions requires authentication"""
        response = requests.get(f"{BASE_URL}/api/config/descriptions")
        assert response.status_code == 401, f"Expected 401 without auth, got {response.status_code}"
        print(f"✓ GET /api/config/descriptions requires auth (401 without session)")


# ==================== AUTH SESSION UPSERT TEST ====================

class TestAuthSessionUpsert:
    """Verify auth session uses upsert to prevent duplicate users"""
    
    def test_40_auth_flow_uses_upsert_pattern(self):
        """Verify auth.py uses update_one with upsert=True"""
        import os
        auth_path = "/app/backend/routers/auth.py"
        with open(auth_path, 'r') as f:
            content = f.read()
        
        # Check for upsert pattern in auth.py
        assert "upsert=True" in content, "Auth flow should use upsert=True"
        assert "update_one" in content, "Auth flow should use update_one"
        print(f"✓ Auth flow uses update_one with upsert=True pattern")


# ==================== CLEANUP ====================

class TestCleanup:
    """Cleanup test data"""
    
    def test_99_cleanup_test_data(self):
        """Remove test data created during this iteration"""
        import asyncio
        from motor.motor_asyncio import AsyncIOMotorClient
        
        async def cleanup():
            client = AsyncIOMotorClient('mongodb://localhost:27017')
            db = client['test_database']
            
            # Delete test users
            result1 = await db.users.delete_many({"email": {"$regex": ".*iter45.*"}})
            result2 = await db.users.delete_many({"email": {"$regex": ".*test_dup_check.*"}})
            result3 = await db.users.delete_many({"email": {"$regex": "invited_.*@test.com"}})
            result4 = await db.users.delete_many({"email": {"$regex": "test_no_perms.*@test.com"}})
            
            # Delete test sessions
            result5 = await db.user_sessions.delete_many({"session_token": {"$regex": ".*iter45.*"}})
            result6 = await db.user_sessions.delete_many({"session_token": {"$regex": "temp_token.*"}})
            
            # Delete test board permissions
            result7 = await db.board_permissions.delete_many({"email": {"$regex": ".*iter45.*"}})
            
            client.close()
            return result1.deleted_count + result2.deleted_count + result3.deleted_count + result4.deleted_count
        
        deleted = asyncio.get_event_loop().run_until_complete(cleanup())
        print(f"✓ Cleanup complete: removed {deleted} test users and related data")
