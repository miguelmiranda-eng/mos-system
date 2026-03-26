import requests
import sys
import json
from datetime import datetime

class CRMBackendTester:
    def __init__(self, base_url="https://production-crm-1.preview.emergentagent.com"):
        self.base_url = base_url
        self.api_url = f"{base_url}/api"
        self.session_token = "test_session_1772063739005"  # From MongoDB setup
        self.headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {self.session_token}'
        }
        self.tests_run = 0
        self.tests_passed = 0
        self.results = []

    def run_test(self, name, method, endpoint, expected_status, data=None, auth_required=True):
        """Run a single API test"""
        url = f"{self.api_url}/{endpoint}"
        headers = {'Content-Type': 'application/json'}
        if auth_required:
            headers.update(self.headers)

        self.tests_run += 1
        print(f"\n🔍 Testing {name}...")
        print(f"   URL: {method} {url}")
        
        try:
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=10)
            elif method == 'POST':
                response = requests.post(url, json=data, headers=headers, timeout=10)
            elif method == 'PUT':
                response = requests.put(url, json=data, headers=headers, timeout=10)
            elif method == 'DELETE':
                response = requests.delete(url, headers=headers, timeout=10)

            success = response.status_code == expected_status
            if success:
                self.tests_passed += 1
                print(f"✅ PASSED - Status: {response.status_code}")
                try:
                    response_data = response.json()
                    if isinstance(response_data, list) and len(response_data) > 0:
                        print(f"   Response: {len(response_data)} items returned")
                    elif isinstance(response_data, dict):
                        print(f"   Response keys: {list(response_data.keys())}")
                except:
                    print(f"   Response: {response.text[:100]}...")
            else:
                print(f"❌ FAILED - Expected {expected_status}, got {response.status_code}")
                try:
                    error_data = response.json()
                    print(f"   Error: {error_data}")
                except:
                    print(f"   Raw response: {response.text[:200]}...")

            self.results.append({
                'name': name,
                'method': method,
                'endpoint': endpoint,
                'expected_status': expected_status,
                'actual_status': response.status_code,
                'success': success,
                'response_summary': self._get_response_summary(response)
            })

            return success, response.json() if success and response.content else {}

        except Exception as e:
            print(f"❌ FAILED - Exception: {str(e)}")
            self.results.append({
                'name': name,
                'method': method,
                'endpoint': endpoint,
                'expected_status': expected_status,
                'actual_status': 'Exception',
                'success': False,
                'error': str(e)
            })
            return False, {}

    def _get_response_summary(self, response):
        """Get a brief summary of the response"""
        try:
            data = response.json()
            if isinstance(data, list):
                return f"{len(data)} items"
            elif isinstance(data, dict):
                return f"Dict with keys: {list(data.keys())[:5]}"
            return str(data)[:50]
        except:
            return response.text[:50] if response.text else "Empty response"

    def test_auth_endpoints(self):
        """Test authentication endpoints"""
        print("\n" + "="*50)
        print("TESTING AUTHENTICATION ENDPOINTS")
        print("="*50)
        
        # Test /auth/me
        self.run_test(
            "Get Current User", 
            "GET", 
            "auth/me", 
            200,
            auth_required=True
        )

    def test_config_endpoints(self):
        """Test configuration endpoints"""
        print("\n" + "="*50)
        print("TESTING CONFIGURATION ENDPOINTS")
        print("="*50)
        
        # Test dropdown options
        success, options = self.run_test(
            "Get Dropdown Options", 
            "GET", 
            "config/options", 
            200,
            auth_required=False
        )
        
        if success and options:
            expected_keys = ['priorities', 'clients', 'brandings', 'boards']
            for key in expected_keys:
                if key in options:
                    print(f"   ✅ {key}: {len(options[key])} options")
                else:
                    print(f"   ❌ Missing {key}")

        # Test boards config
        success, boards = self.run_test(
            "Get Boards Config", 
            "GET", 
            "config/boards", 
            200,
            auth_required=False
        )
        
        if success and boards and 'boards' in boards:
            print(f"   ✅ Found {len(boards['boards'])} boards")
            # Check for expected boards
            expected_boards = ['MASTER', 'SCHEDULING', 'BLANKS', 'SCREENS', 'MAQUINA1']
            found_boards = boards['boards']
            for board in expected_boards:
                if board in found_boards:
                    print(f"   ✅ {board} found")
                else:
                    print(f"   ❌ {board} missing")

    def test_orders_endpoints(self):
        """Test order management endpoints"""
        print("\n" + "="*50)
        print("TESTING ORDER ENDPOINTS")
        print("="*50)
        
        # Test get orders
        success, orders = self.run_test(
            "Get All Orders", 
            "GET", 
            "orders", 
            200,
            auth_required=True
        )

        # Test create order
        create_data = {
            "client": "LOVE IN FAITH",
            "branding": "LIF Regular", 
            "priority": "RUSH",
            "quantity": 100,
            "notes": "Test order from automated testing"
        }
        
        success, new_order = self.run_test(
            "Create New Order", 
            "POST", 
            "orders", 
            200,  # Backend returns 200 instead of 201
            data=create_data,
            auth_required=True
        )

        order_id = None
        if success and new_order and 'order_id' in new_order:
            order_id = new_order['order_id']
            print(f"   ✅ Created order: {order_id}")
            
            # Verify it's in SCHEDULING board
            if new_order.get('board') == 'SCHEDULING':
                print(f"   ✅ Order placed in SCHEDULING board")
            else:
                print(f"   ❌ Order in wrong board: {new_order.get('board')}")

        # Test get single order
        if order_id:
            self.run_test(
                "Get Single Order", 
                "GET", 
                f"orders/{order_id}", 
                200,
                auth_required=True
            )

            # Test update order
            update_data = {
                "quantity": 150,
                "notes": "Updated from automated testing",
                "production_status": "EN PRODUCCION"
            }
            
            self.run_test(
                "Update Order", 
                "PUT", 
                f"orders/{order_id}", 
                200,
                data=update_data,
                auth_required=True
            )

            # Test move order
            move_data = {"board": "BLANKS"}
            self.run_test(
                "Move Order to BLANKS", 
                "POST", 
                f"orders/{order_id}/move", 
                200,
                data=move_data,
                auth_required=True
            )

            return order_id

        return None

    def test_comments_endpoints(self, order_id):
        """Test comments endpoints"""
        if not order_id:
            print("\n⚠️ Skipping comments tests - no order ID")
            return
            
        print("\n" + "="*50)
        print("TESTING COMMENTS ENDPOINTS")
        print("="*50)

        # Test get comments
        self.run_test(
            "Get Order Comments", 
            "GET", 
            f"orders/{order_id}/comments", 
            200,
            auth_required=True
        )

        # Test create comment
        comment_data = {
            "content": "Test comment from automated testing"
        }
        
        self.run_test(
            "Create Comment", 
            "POST", 
            f"orders/{order_id}/comments", 
            200,  # Backend returns 200 instead of 201
            data=comment_data,
            auth_required=True
        )

    def test_automations_endpoints(self):
        """Test automation endpoints"""
        print("\n" + "="*50)
        print("TESTING AUTOMATIONS ENDPOINTS")
        print("="*50)

        # Test get automations
        success, automations = self.run_test(
            "Get Automations", 
            "GET", 
            "automations", 
            200,
            auth_required=True
        )

        # Test create automation
        automation_data = {
            "name": "Test Automation",
            "trigger_type": "create",
            "trigger_conditions": {"board": "SCHEDULING"},
            "action_type": "send_email",
            "action_params": {
                "to_email": "test@example.com",
                "subject": "New Order Created"
            }
        }
        
        success, new_automation = self.run_test(
            "Create Automation", 
            "POST", 
            "automations", 
            200,  # Backend returns 200 instead of 201
            data=automation_data,
            auth_required=True
        )

        automation_id = None
        if success and new_automation and 'automation_id' in new_automation:
            automation_id = new_automation['automation_id']
            print(f"   ✅ Created automation: {automation_id}")

            # Test delete automation
            self.run_test(
                "Delete Automation", 
                "DELETE", 
                f"automations/{automation_id}", 
                200,
                auth_required=True
            )

    def test_bulk_operations(self):
        """Test bulk operations"""
        print("\n" + "="*50)
        print("TESTING BULK OPERATIONS")
        print("="*50)

        # Create multiple orders for bulk testing
        order_ids = []
        for i in range(2):
            create_data = {
                "client": "TARGET",
                "branding": "Target", 
                "priority": "PRIORITY 1",
                "quantity": 50 + i * 10,
                "notes": f"Bulk test order {i+1}"
            }
            
            success, new_order = self.run_test(
                f"Create Bulk Order {i+1}", 
                "POST", 
                "orders", 
                200,  # Backend returns 200 instead of 201
                data=create_data,
                auth_required=True
            )
            
            if success and new_order and 'order_id' in new_order:
                order_ids.append(new_order['order_id'])

        # Test bulk move
        if len(order_ids) >= 2:
            bulk_move_data = {
                "order_ids": order_ids,
                "board": "SCREENS"
            }
            
            self.run_test(
                "Bulk Move Orders", 
                "POST", 
                "orders/bulk-move", 
                200,
                data=bulk_move_data,
                auth_required=True
            )

        # Test delete orders (move to trash)
        for order_id in order_ids:
            self.run_test(
                "Delete Order (Move to Trash)", 
                "DELETE", 
                f"orders/{order_id}", 
                200,
                auth_required=True
            )

    def run_all_tests(self):
        """Run all backend tests"""
        print("🚀 Starting CRM Backend API Tests")
        print(f"📍 Base URL: {self.base_url}")
        print(f"🔑 Session Token: {self.session_token}")
        
        try:
            # Test auth first
            self.test_auth_endpoints()
            
            # Test config endpoints
            self.test_config_endpoints()
            
            # Test orders (main functionality)
            order_id = self.test_orders_endpoints()
            
            # Test comments
            self.test_comments_endpoints(order_id)
            
            # Test automations
            self.test_automations_endpoints()
            
            # Test bulk operations
            self.test_bulk_operations()
            
        except KeyboardInterrupt:
            print("\n⚠️ Tests interrupted by user")
        except Exception as e:
            print(f"\n💥 Unexpected error: {e}")
        
        # Print final results
        self.print_summary()
        return self.tests_passed == self.tests_run

    def print_summary(self):
        """Print test summary"""
        print("\n" + "="*60)
        print("📊 TEST SUMMARY")
        print("="*60)
        print(f"📈 Tests Run: {self.tests_run}")
        print(f"✅ Tests Passed: {self.tests_passed}")
        print(f"❌ Tests Failed: {self.tests_run - self.tests_passed}")
        print(f"📊 Success Rate: {(self.tests_passed/self.tests_run*100):.1f}%" if self.tests_run > 0 else "0.0%")
        
        # Show failed tests
        failed_tests = [r for r in self.results if not r['success']]
        if failed_tests:
            print(f"\n❌ FAILED TESTS ({len(failed_tests)}):")
            for test in failed_tests:
                error_msg = test.get('error', f"Status {test['actual_status']}")
                print(f"   • {test['name']}: {error_msg}")
        else:
            print(f"\n🎉 ALL TESTS PASSED!")

def main():
    tester = CRMBackendTester()
    success = tester.run_all_tests()
    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())