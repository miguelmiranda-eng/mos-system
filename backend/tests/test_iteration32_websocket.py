"""
Test iteration 32: WebSocket real-time updates functionality
Tests:
- WebSocket endpoint /api/ws accepts connections and stays open
- WebSocket broadcasts on order create, update, move, delete, and bulk-move
- WebSocket message format is JSON with 'type' and 'data' fields
"""

import pytest
import requests
import os
import json
import threading
import time
from websockets.sync.client import connect

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
WS_URL = BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/api/ws'
SESSION_TOKEN = "test_session_ws_1772813196688"


class TestWebSocketConnection:
    """Test WebSocket endpoint connectivity"""
    
    def test_01_websocket_endpoint_accepts_connection(self):
        """Test that /api/ws accepts WebSocket connections"""
        print(f"Connecting to WebSocket: {WS_URL}")
        try:
            ws = connect(WS_URL, close_timeout=5, open_timeout=10)
            assert ws is not None, "WebSocket connection should be established"
            print("SUCCESS: WebSocket connection accepted")
            ws.close()
        except Exception as e:
            pytest.fail(f"WebSocket connection failed: {str(e)}")
    
    def test_02_websocket_stays_open(self):
        """Test that WebSocket stays open for at least 3 seconds"""
        ws = connect(WS_URL, close_timeout=5, open_timeout=10)
        time.sleep(3)  # Wait for 3 seconds
        try:
            # Try to send a ping - if connection is open this should work
            ws.ping()
            print("SUCCESS: WebSocket stayed open for 3 seconds")
        except Exception as e:
            pytest.fail(f"WebSocket closed unexpectedly: {str(e)}")
        finally:
            ws.close()


class TestWebSocketBroadcastOnOrderCreate:
    """Test WebSocket broadcasts when orders are created"""
    
    def test_03_broadcast_on_order_create(self):
        """Test that creating an order triggers WebSocket broadcast with type 'order_change'"""
        messages_received = []
        ws_ready = threading.Event()
        ws_done = threading.Event()
        stop_listening = threading.Event()
        
        def ws_listener():
            try:
                # Use timeout in connect instead of settimeout
                ws = connect(WS_URL, close_timeout=15, open_timeout=10)
                ws_ready.set()  # Signal that WS is connected
                # Wait for message - the recv() will block
                try:
                    while not stop_listening.is_set():
                        try:
                            msg = ws.recv(timeout=12)  # Use recv with timeout parameter
                            messages_received.append(json.loads(msg))
                            print(f"Received WS message: {msg}")
                            break
                        except TimeoutError:
                            print("WS recv timeout")
                            break
                except Exception as e:
                    print(f"WS recv error: {e}")
                finally:
                    ws.close()
            except Exception as e:
                print(f"WS listener error: {e}")
            finally:
                ws_done.set()
        
        # Start WS listener in background thread
        listener_thread = threading.Thread(target=ws_listener)
        listener_thread.start()
        
        # Wait for WS to be connected
        ws_ready.wait(timeout=10)
        time.sleep(1)  # Give a moment for connection to be fully ready
        
        # Create an order via API
        create_payload = {
            "client": "WS Test Client",
            "branding": "Test Branding",
            "priority": "NORMAL",
            "quantity": 100,
            "notes": "Created for WebSocket test"
        }
        
        response = requests.post(
            f"{BASE_URL}/api/orders",
            json=create_payload,
            cookies={"session_token": SESSION_TOKEN},
            headers={"Content-Type": "application/json"}
        )
        
        assert response.status_code == 200, f"Order create failed: {response.status_code} - {response.text}"
        created_order = response.json()
        order_id = created_order.get("order_id")
        print(f"Created order: {order_id}")
        
        # Wait for WS message
        ws_done.wait(timeout=15)
        stop_listening.set()
        listener_thread.join(timeout=2)
        
        # Verify broadcast message
        assert len(messages_received) > 0, "Should have received at least one WebSocket message"
        msg = messages_received[0]
        assert msg.get("type") == "order_change", f"Message type should be 'order_change', got: {msg.get('type')}"
        assert "data" in msg, "Message should have 'data' field"
        assert msg["data"].get("action") == "create", f"Action should be 'create', got: {msg['data'].get('action')}"
        print(f"SUCCESS: Received order_change broadcast on create: {msg}")
        
        # Cleanup - delete the order
        requests.delete(
            f"{BASE_URL}/api/orders/{order_id}",
            cookies={"session_token": SESSION_TOKEN}
        )


class TestWebSocketBroadcastOnOrderUpdate:
    """Test WebSocket broadcasts when orders are updated"""
    
    def test_04_broadcast_on_order_update(self):
        """Test that updating an order triggers WebSocket broadcast"""
        # First create an order
        create_response = requests.post(
            f"{BASE_URL}/api/orders",
            json={"client": "WS Update Test", "branding": "Test", "priority": "NORMAL", "quantity": 50},
            cookies={"session_token": SESSION_TOKEN},
            headers={"Content-Type": "application/json"}
        )
        assert create_response.status_code == 200
        order_id = create_response.json().get("order_id")
        
        messages_received = []
        ws_ready = threading.Event()
        ws_done = threading.Event()
        
        def ws_listener():
            try:
                ws = connect(WS_URL, close_timeout=15, open_timeout=10)
                ws_ready.set()
                try:
                    msg = ws.recv(timeout=12)
                    messages_received.append(json.loads(msg))
                    print(f"Received WS message: {msg}")
                except TimeoutError:
                    print("WS recv timeout")
                except Exception as e:
                    print(f"WS recv error: {e}")
                finally:
                    ws.close()
            except Exception as e:
                print(f"WS listener error: {e}")
            finally:
                ws_done.set()
        
        listener_thread = threading.Thread(target=ws_listener)
        listener_thread.start()
        ws_ready.wait(timeout=10)
        time.sleep(1)
        
        # Update the order
        update_response = requests.put(
            f"{BASE_URL}/api/orders/{order_id}",
            json={"notes": "Updated via WebSocket test"},
            cookies={"session_token": SESSION_TOKEN},
            headers={"Content-Type": "application/json"}
        )
        
        assert update_response.status_code == 200, f"Order update failed: {update_response.status_code}"
        
        ws_done.wait(timeout=15)
        listener_thread.join(timeout=2)
        
        assert len(messages_received) > 0, "Should have received WebSocket message on update"
        msg = messages_received[0]
        assert msg.get("type") == "order_change", f"Message type should be 'order_change'"
        assert msg["data"].get("action") == "update", f"Action should be 'update', got: {msg['data'].get('action')}"
        print(f"SUCCESS: Received order_change broadcast on update: {msg}")
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/orders/{order_id}", cookies={"session_token": SESSION_TOKEN})


class TestWebSocketBroadcastOnOrderMove:
    """Test WebSocket broadcasts when orders are moved"""
    
    def test_05_broadcast_on_order_move(self):
        """Test that moving an order via POST /api/orders/{id}/move triggers broadcast"""
        # First create an order
        create_response = requests.post(
            f"{BASE_URL}/api/orders",
            json={"client": "WS Move Test", "branding": "Test", "priority": "RUSH", "quantity": 30},
            cookies={"session_token": SESSION_TOKEN},
            headers={"Content-Type": "application/json"}
        )
        assert create_response.status_code == 200
        order_id = create_response.json().get("order_id")
        
        messages_received = []
        ws_ready = threading.Event()
        ws_done = threading.Event()
        
        def ws_listener():
            try:
                ws = connect(WS_URL, close_timeout=15, open_timeout=10)
                ws_ready.set()
                try:
                    msg = ws.recv(timeout=12)
                    messages_received.append(json.loads(msg))
                    print(f"Received WS message: {msg}")
                except TimeoutError:
                    print("WS recv timeout")
                except Exception as e:
                    print(f"WS recv error: {e}")
                finally:
                    ws.close()
            except Exception as e:
                print(f"WS listener error: {e}")
            finally:
                ws_done.set()
        
        listener_thread = threading.Thread(target=ws_listener)
        listener_thread.start()
        ws_ready.wait(timeout=10)
        time.sleep(1)
        
        # Move the order
        move_response = requests.post(
            f"{BASE_URL}/api/orders/{order_id}/move",
            json={"board": "BLANKS"},
            cookies={"session_token": SESSION_TOKEN},
            headers={"Content-Type": "application/json"}
        )
        
        assert move_response.status_code == 200, f"Order move failed: {move_response.status_code}"
        
        ws_done.wait(timeout=15)
        listener_thread.join(timeout=2)
        
        assert len(messages_received) > 0, "Should have received WebSocket message on move"
        msg = messages_received[0]
        assert msg.get("type") == "order_change", f"Message type should be 'order_change'"
        assert msg["data"].get("action") == "move", f"Action should be 'move', got: {msg['data'].get('action')}"
        assert "boards" in msg["data"], "Message data should have 'boards' field"
        print(f"SUCCESS: Received order_change broadcast on move: {msg}")
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/orders/{order_id}", cookies={"session_token": SESSION_TOKEN})


class TestWebSocketBroadcastOnOrderDelete:
    """Test WebSocket broadcasts when orders are deleted"""
    
    def test_06_broadcast_on_order_delete(self):
        """Test that deleting an order triggers WebSocket broadcast"""
        # First create an order
        create_response = requests.post(
            f"{BASE_URL}/api/orders",
            json={"client": "WS Delete Test", "branding": "Test", "priority": "NORMAL", "quantity": 25},
            cookies={"session_token": SESSION_TOKEN},
            headers={"Content-Type": "application/json"}
        )
        assert create_response.status_code == 200
        order_id = create_response.json().get("order_id")
        
        messages_received = []
        ws_ready = threading.Event()
        ws_done = threading.Event()
        
        def ws_listener():
            try:
                ws = connect(WS_URL, close_timeout=15, open_timeout=10)
                ws_ready.set()
                try:
                    msg = ws.recv(timeout=12)
                    messages_received.append(json.loads(msg))
                    print(f"Received WS message: {msg}")
                except TimeoutError:
                    print("WS recv timeout")
                except Exception as e:
                    print(f"WS recv error: {e}")
                finally:
                    ws.close()
            except Exception as e:
                print(f"WS listener error: {e}")
            finally:
                ws_done.set()
        
        listener_thread = threading.Thread(target=ws_listener)
        listener_thread.start()
        ws_ready.wait(timeout=10)
        time.sleep(1)
        
        # Delete the order
        delete_response = requests.delete(
            f"{BASE_URL}/api/orders/{order_id}",
            cookies={"session_token": SESSION_TOKEN}
        )
        
        assert delete_response.status_code == 200, f"Order delete failed: {delete_response.status_code}"
        
        ws_done.wait(timeout=15)
        listener_thread.join(timeout=2)
        
        assert len(messages_received) > 0, "Should have received WebSocket message on delete"
        msg = messages_received[0]
        assert msg.get("type") == "order_change", f"Message type should be 'order_change'"
        assert msg["data"].get("action") == "delete", f"Action should be 'delete', got: {msg['data'].get('action')}"
        print(f"SUCCESS: Received order_change broadcast on delete: {msg}")


class TestWebSocketBroadcastOnBulkMove:
    """Test WebSocket broadcasts on bulk-move operations"""
    
    def test_07_broadcast_on_bulk_move(self):
        """Test that bulk-moving orders triggers WebSocket broadcast"""
        # Create two orders
        order_ids = []
        for i in range(2):
            create_response = requests.post(
                f"{BASE_URL}/api/orders",
                json={"client": f"WS Bulk Test {i+1}", "branding": "Test", "priority": "NORMAL", "quantity": 10},
                cookies={"session_token": SESSION_TOKEN},
                headers={"Content-Type": "application/json"}
            )
            assert create_response.status_code == 200
            order_ids.append(create_response.json().get("order_id"))
        
        messages_received = []
        ws_ready = threading.Event()
        ws_done = threading.Event()
        
        def ws_listener():
            try:
                ws = connect(WS_URL, close_timeout=15, open_timeout=10)
                ws_ready.set()
                try:
                    msg = ws.recv(timeout=12)
                    messages_received.append(json.loads(msg))
                    print(f"Received WS message: {msg}")
                except TimeoutError:
                    print("WS recv timeout")
                except Exception as e:
                    print(f"WS recv error: {e}")
                finally:
                    ws.close()
            except Exception as e:
                print(f"WS listener error: {e}")
            finally:
                ws_done.set()
        
        listener_thread = threading.Thread(target=ws_listener)
        listener_thread.start()
        ws_ready.wait(timeout=10)
        time.sleep(1)
        
        # Bulk move orders
        bulk_response = requests.post(
            f"{BASE_URL}/api/orders/bulk-move",
            json={"order_ids": order_ids, "board": "SCREENS"},
            cookies={"session_token": SESSION_TOKEN},
            headers={"Content-Type": "application/json"}
        )
        
        assert bulk_response.status_code == 200, f"Bulk move failed: {bulk_response.status_code}"
        
        ws_done.wait(timeout=15)
        listener_thread.join(timeout=2)
        
        assert len(messages_received) > 0, "Should have received WebSocket message on bulk-move"
        msg = messages_received[0]
        assert msg.get("type") == "order_change", f"Message type should be 'order_change'"
        assert msg["data"].get("action") == "bulk_move", f"Action should be 'bulk_move', got: {msg['data'].get('action')}"
        assert "boards" in msg["data"], "Message data should have 'boards' field"
        print(f"SUCCESS: Received order_change broadcast on bulk-move: {msg}")
        
        # Cleanup
        for oid in order_ids:
            requests.delete(f"{BASE_URL}/api/orders/{oid}", cookies={"session_token": SESSION_TOKEN})


class TestWebSocketMessageFormat:
    """Test WebSocket message format compliance"""
    
    def test_08_message_format_json_with_type_and_data(self):
        """Verify message format is JSON with 'type' and 'data' fields"""
        messages_received = []
        ws_ready = threading.Event()
        ws_done = threading.Event()
        
        def ws_listener():
            try:
                ws = connect(WS_URL, close_timeout=15, open_timeout=10)
                ws_ready.set()
                try:
                    msg = ws.recv(timeout=12)
                    messages_received.append(msg)  # Keep as raw string to verify JSON
                    print(f"Raw WS message: {msg}")
                except TimeoutError:
                    print("WS recv timeout")
                except Exception as e:
                    print(f"WS recv error: {e}")
                finally:
                    ws.close()
            except Exception as e:
                print(f"WS listener error: {e}")
            finally:
                ws_done.set()
        
        listener_thread = threading.Thread(target=ws_listener)
        listener_thread.start()
        ws_ready.wait(timeout=10)
        time.sleep(1)
        
        # Create an order to trigger message
        create_response = requests.post(
            f"{BASE_URL}/api/orders",
            json={"client": "WS Format Test", "branding": "Test", "priority": "NORMAL", "quantity": 5},
            cookies={"session_token": SESSION_TOKEN},
            headers={"Content-Type": "application/json"}
        )
        order_id = create_response.json().get("order_id")
        
        ws_done.wait(timeout=15)
        listener_thread.join(timeout=2)
        
        assert len(messages_received) > 0, "Should have received a message"
        raw_msg = messages_received[0]
        
        # Verify it's valid JSON
        try:
            parsed = json.loads(raw_msg)
        except json.JSONDecodeError:
            pytest.fail(f"Message is not valid JSON: {raw_msg}")
        
        # Verify structure
        assert "type" in parsed, "Message must have 'type' field"
        assert "data" in parsed, "Message must have 'data' field"
        assert isinstance(parsed["type"], str), "'type' must be a string"
        assert isinstance(parsed["data"], dict), "'data' must be an object/dict"
        
        print(f"SUCCESS: Message format is correct - type: {parsed['type']}, data keys: {list(parsed['data'].keys())}")
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/orders/{order_id}", cookies={"session_token": SESSION_TOKEN})


class TestCleanup:
    """Cleanup test data"""
    
    def test_99_cleanup_ws_test_orders(self):
        """Clean up any remaining WS test orders"""
        response = requests.get(
            f"{BASE_URL}/api/orders?search=WS",
            cookies={"session_token": SESSION_TOKEN}
        )
        if response.status_code == 200:
            orders = response.json()
            ws_orders = [o for o in orders if o.get("client", "").startswith("WS ")]
            for order in ws_orders:
                requests.delete(
                    f"{BASE_URL}/api/orders/{order['order_id']}",
                    cookies={"session_token": SESSION_TOKEN}
                )
            print(f"Cleaned up {len(ws_orders)} WS test orders")
        print("SUCCESS: Cleanup completed")
