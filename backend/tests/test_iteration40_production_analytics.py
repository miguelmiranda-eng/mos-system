"""
Iteration 40: Test new production analytics fields
- total_remaining: total_target - total_produced (never negative)
- by_production_status: groups active orders by production_status (excludes PAPELERA DE RECICLAJE and COMPLETOS)
"""
import pytest
import requests
import os
from datetime import datetime, timezone, timedelta
import uuid

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

@pytest.fixture(scope="module")
def admin_session():
    """Create admin session for testing"""
    from motor.motor_asyncio import AsyncIOMotorClient
    import asyncio
    
    async def create_session():
        client = AsyncIOMotorClient('mongodb://localhost:27017')
        db = client['test_database']
        
        admin_email = 'miguel.miranda@prosper-mfg.com'
        user = await db.users.find_one({'email': admin_email}, {'_id': 0})
        
        if not user:
            user = {
                'user_id': f'admin_iter40_{uuid.uuid4().hex[:8]}',
                'email': admin_email,
                'name': 'Miguel Miranda',
                'role': 'admin',
                'created_at': datetime.now(timezone.utc).isoformat()
            }
            await db.users.insert_one(user)
        
        session_token = f'iter40_session_{uuid.uuid4().hex[:12]}'
        session = {
            'user_id': user['user_id'],
            'session_token': session_token,
            'expires_at': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            'created_at': datetime.now(timezone.utc).isoformat()
        }
        await db.user_sessions.insert_one(session)
        client.close()
        return session_token
    
    return asyncio.get_event_loop().run_until_complete(create_session())


class TestProductionAnalyticsNewFields:
    """Test new production analytics fields: total_remaining and by_production_status"""
    
    def test_production_analytics_returns_total_remaining(self, admin_session):
        """Test that /api/production-analytics returns total_remaining field"""
        response = requests.get(
            f"{BASE_URL}/api/production-analytics?preset=month",
            cookies={"session_token": admin_session}
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert "total_remaining" in data, "total_remaining field missing from response"
        assert isinstance(data["total_remaining"], (int, float)), "total_remaining should be numeric"
        
        # Verify calculation: total_remaining = max(total_target - total_produced, 0)
        expected_remaining = max(data.get("total_target", 0) - data.get("total_produced", 0), 0)
        assert data["total_remaining"] == expected_remaining, f"total_remaining should be {expected_remaining}, got {data['total_remaining']}"
        print(f"✓ total_remaining: {data['total_remaining']} (target: {data.get('total_target')}, produced: {data.get('total_produced')})")
    
    def test_total_remaining_never_negative(self, admin_session):
        """Test that total_remaining is never negative"""
        response = requests.get(
            f"{BASE_URL}/api/production-analytics?preset=month",
            cookies={"session_token": admin_session}
        )
        assert response.status_code == 200
        
        data = response.json()
        assert data["total_remaining"] >= 0, "total_remaining should never be negative"
        print(f"✓ total_remaining >= 0: {data['total_remaining']}")
    
    def test_production_analytics_returns_by_production_status(self, admin_session):
        """Test that /api/production-analytics returns by_production_status array"""
        response = requests.get(
            f"{BASE_URL}/api/production-analytics?preset=month",
            cookies={"session_token": admin_session}
        )
        assert response.status_code == 200
        
        data = response.json()
        assert "by_production_status" in data, "by_production_status field missing from response"
        assert isinstance(data["by_production_status"], list), "by_production_status should be a list"
        print(f"✓ by_production_status is present and is a list with {len(data['by_production_status'])} items")
    
    def test_by_production_status_structure(self, admin_session):
        """Test that each item in by_production_status has required fields"""
        response = requests.get(
            f"{BASE_URL}/api/production-analytics?preset=month",
            cookies={"session_token": admin_session}
        )
        assert response.status_code == 200
        
        data = response.json()
        by_prod_status = data.get("by_production_status", [])
        
        for item in by_prod_status:
            assert "status" in item, "Each item should have 'status' field"
            assert "count" in item, "Each item should have 'count' field (order count)"
            assert "quantity" in item, "Each item should have 'quantity' field (total pieces)"
            assert isinstance(item["status"], str), "status should be string"
            assert isinstance(item["count"], (int, float)), "count should be numeric"
            assert isinstance(item["quantity"], (int, float)), "quantity should be numeric"
        
        print(f"✓ All {len(by_prod_status)} production status items have correct structure")
        for item in by_prod_status[:5]:
            print(f"  - {item['status']}: {item['quantity']} piezas, {item['count']} ordenes")
    
    def test_by_production_status_sorted_by_quantity(self, admin_session):
        """Test that by_production_status is sorted by quantity descending"""
        response = requests.get(
            f"{BASE_URL}/api/production-analytics?preset=month",
            cookies={"session_token": admin_session}
        )
        assert response.status_code == 200
        
        data = response.json()
        by_prod_status = data.get("by_production_status", [])
        
        if len(by_prod_status) > 1:
            quantities = [item["quantity"] for item in by_prod_status]
            assert quantities == sorted(quantities, reverse=True), "by_production_status should be sorted by quantity descending"
        
        print(f"✓ by_production_status is sorted by quantity descending")
    
    def test_production_analytics_with_different_presets(self, admin_session):
        """Test that new fields work with different preset filters"""
        presets = ["today", "week", "month"]
        
        for preset in presets:
            response = requests.get(
                f"{BASE_URL}/api/production-analytics?preset={preset}",
                cookies={"session_token": admin_session}
            )
            assert response.status_code == 200, f"Failed for preset={preset}"
            
            data = response.json()
            assert "total_remaining" in data, f"total_remaining missing for preset={preset}"
            assert "by_production_status" in data, f"by_production_status missing for preset={preset}"
            
            print(f"✓ Preset '{preset}': total_remaining={data['total_remaining']}, statuses={len(data['by_production_status'])}")
    
    def test_production_analytics_without_auth_returns_401(self):
        """Test that /api/production-analytics requires authentication"""
        response = requests.get(f"{BASE_URL}/api/production-analytics?preset=month")
        assert response.status_code == 401, f"Expected 401, got {response.status_code}"
        print("✓ Unauthenticated request returns 401")
    
    def test_response_includes_all_expected_fields(self, admin_session):
        """Test that response includes all expected fields including new ones"""
        response = requests.get(
            f"{BASE_URL}/api/production-analytics?preset=month",
            cookies={"session_token": admin_session}
        )
        assert response.status_code == 200
        
        data = response.json()
        expected_fields = [
            "total_produced", "total_target", "total_remaining", 
            "efficiency", "avg_setup", "total_logs",
            "by_machine", "by_operator", "by_shift", "by_client",
            "by_po", "hourly_trend", "by_production_status",
            "filters", "logs"
        ]
        
        for field in expected_fields:
            assert field in data, f"Missing expected field: {field}"
        
        print(f"✓ All {len(expected_fields)} expected fields present in response")
