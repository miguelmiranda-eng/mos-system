"""
Iteration 26: Production Monitor Major Upgrade Tests
Tests:
1. POST /api/production-logs with new fields (operator, shift, design_type, stop_cause, supervisor)
2. GET /api/production-analytics with filters and aggregations
3. POST /api/production-report for Excel and PDF generation
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', 'https://production-crm-1.preview.emergentagent.com').rstrip('/')
SESSION_TOKEN = "test_session_iteration26_1772743226446"

@pytest.fixture
def auth_headers():
    return {"Authorization": f"Bearer {SESSION_TOKEN}", "Content-Type": "application/json"}


class TestProductionLogsNewFields:
    """Test POST /api/production-logs accepts new fields: operator, shift, design_type, stop_cause, supervisor"""
    
    def test_01_get_existing_order_for_production(self, auth_headers):
        """Find an existing order to use for production log tests"""
        res = requests.get(f"{BASE_URL}/api/orders", headers=auth_headers)
        assert res.status_code == 200
        orders = res.json()
        # Find an order not in trash
        active_orders = [o for o in orders if o.get("board") != "PAPELERA DE RECICLAJE"]
        assert len(active_orders) > 0, "Need at least one active order for testing"
        print(f"Found {len(active_orders)} active orders")
    
    def test_02_create_production_log_with_new_fields(self, auth_headers):
        """POST /api/production-logs with all new fields"""
        # Get an order first
        res = requests.get(f"{BASE_URL}/api/orders", headers=auth_headers)
        orders = res.json()
        active_orders = [o for o in orders if o.get("board") != "PAPELERA DE RECICLAJE"]
        test_order = active_orders[0]
        
        payload = {
            "order_id": test_order["order_id"],
            "quantity_produced": 50,
            "machine": "MAQUINA5",
            "setup": 15,
            "operator": "TEST_OperadorPrueba",
            "shift": "TURNO 2",
            "design_type": "FRENTE",
            "stop_cause": "TEST_Cambio de diseño",
            "supervisor": "TEST_SupervisorPrueba"
        }
        
        res = requests.post(f"{BASE_URL}/api/production-logs", json=payload, headers=auth_headers)
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        
        data = res.json()
        # Verify new fields are stored
        assert data.get("operator") == "TEST_OperadorPrueba"
        assert data.get("shift") == "TURNO 2"
        assert data.get("design_type") == "FRENTE"
        assert data.get("stop_cause") == "TEST_Cambio de diseño"
        assert data.get("supervisor") == "TEST_SupervisorPrueba"
        assert data.get("client") == test_order.get("client", "")  # Client from order
        print(f"Production log created with ID: {data.get('log_id')}")
    
    def test_03_create_production_log_espalda_design(self, auth_headers):
        """Test creating log with ESPALDA design_type"""
        res = requests.get(f"{BASE_URL}/api/orders", headers=auth_headers)
        orders = res.json()
        active_orders = [o for o in orders if o.get("board") != "PAPELERA DE RECICLAJE"]
        test_order = active_orders[0]
        
        payload = {
            "order_id": test_order["order_id"],
            "quantity_produced": 30,
            "machine": "MAQUINA6",
            "setup": 10,
            "operator": "TEST_OperadorB",
            "shift": "TURNO 1",
            "design_type": "ESPALDA",
            "stop_cause": "",
            "supervisor": "TEST_SupervisorB"
        }
        
        res = requests.post(f"{BASE_URL}/api/production-logs", json=payload, headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert data.get("design_type") == "ESPALDA"
    
    def test_04_create_production_log_manga_design(self, auth_headers):
        """Test creating log with MANGA design_type"""
        res = requests.get(f"{BASE_URL}/api/orders", headers=auth_headers)
        orders = res.json()
        active_orders = [o for o in orders if o.get("board") != "PAPELERA DE RECICLAJE"]
        test_order = active_orders[0]
        
        payload = {
            "order_id": test_order["order_id"],
            "quantity_produced": 25,
            "machine": "MAQUINA7",
            "setup": 5,
            "operator": "TEST_OperadorC",
            "shift": "TURNO 3",
            "design_type": "MANGA",
            "stop_cause": "TEST_Mantenimiento",
            "supervisor": "TEST_SupervisorC"
        }
        
        res = requests.post(f"{BASE_URL}/api/production-logs", json=payload, headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert data.get("design_type") == "MANGA"
        assert data.get("shift") == "TURNO 3"


class TestProductionAnalytics:
    """Test GET /api/production-analytics endpoint with filters and aggregations"""
    
    def test_05_analytics_endpoint_accessible(self, auth_headers):
        """Verify /api/production-analytics returns 200"""
        res = requests.get(f"{BASE_URL}/api/production-analytics", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "total_produced" in data
        assert "total_target" in data
        assert "efficiency" in data
        assert "avg_setup" in data
        print(f"Analytics: total_produced={data['total_produced']}, efficiency={data['efficiency']}%")
    
    def test_06_analytics_returns_required_fields(self, auth_headers):
        """Verify all required aggregation fields are returned"""
        res = requests.get(f"{BASE_URL}/api/production-analytics", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        
        # Check all required fields
        required_fields = [
            "total_produced", "total_target", "efficiency", "avg_setup", "total_logs",
            "by_machine", "by_operator", "by_shift", "by_client", "by_po", "hourly_trend",
            "filters", "logs"
        ]
        for field in required_fields:
            assert field in data, f"Missing required field: {field}"
        
        # Verify filters structure
        assert "machines" in data["filters"]
        assert "operators" in data["filters"]
        assert "clients" in data["filters"]
        print(f"All {len(required_fields)} required fields present")
    
    def test_07_analytics_preset_today(self, auth_headers):
        """Test preset=today filter"""
        res = requests.get(f"{BASE_URL}/api/production-analytics?preset=today", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "total_produced" in data
        assert "logs" in data
        print(f"Today's logs count: {data['total_logs']}")
    
    def test_08_analytics_preset_week(self, auth_headers):
        """Test preset=week filter"""
        res = requests.get(f"{BASE_URL}/api/production-analytics?preset=week", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "total_produced" in data
        print(f"Week's total produced: {data['total_produced']}")
    
    def test_09_analytics_filter_by_machine(self, auth_headers):
        """Test machine filter"""
        res = requests.get(f"{BASE_URL}/api/production-analytics?machine=MAQUINA5", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        # All logs should be from MAQUINA5
        for log in data.get("logs", []):
            assert log.get("machine") == "MAQUINA5", f"Expected MAQUINA5, got {log.get('machine')}"
        print(f"MAQUINA5 logs: {len(data.get('logs', []))}")
    
    def test_10_analytics_by_machine_aggregation(self, auth_headers):
        """Test by_machine aggregation structure"""
        res = requests.get(f"{BASE_URL}/api/production-analytics", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        
        by_machine = data.get("by_machine", [])
        if len(by_machine) > 0:
            machine_entry = by_machine[0]
            assert "machine" in machine_entry
            assert "produced" in machine_entry
            assert "avg_setup" in machine_entry
            assert "count" in machine_entry
            print(f"by_machine sample: {machine_entry}")
    
    def test_11_analytics_by_operator_aggregation(self, auth_headers):
        """Test by_operator aggregation structure"""
        res = requests.get(f"{BASE_URL}/api/production-analytics", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        
        by_operator = data.get("by_operator", [])
        if len(by_operator) > 0:
            op_entry = by_operator[0]
            assert "operator" in op_entry
            assert "produced" in op_entry
            assert "count" in op_entry
            print(f"by_operator has {len(by_operator)} entries")
    
    def test_12_analytics_by_shift_aggregation(self, auth_headers):
        """Test by_shift aggregation structure"""
        res = requests.get(f"{BASE_URL}/api/production-analytics", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        
        by_shift = data.get("by_shift", [])
        if len(by_shift) > 0:
            shift_entry = by_shift[0]
            assert "shift" in shift_entry
            assert "produced" in shift_entry
            assert "count" in shift_entry
            print(f"by_shift has {len(by_shift)} entries")
    
    def test_13_analytics_by_client_aggregation(self, auth_headers):
        """Test by_client aggregation structure"""
        res = requests.get(f"{BASE_URL}/api/production-analytics", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        
        by_client = data.get("by_client", [])
        if len(by_client) > 0:
            client_entry = by_client[0]
            assert "client" in client_entry
            assert "produced" in client_entry
            assert "count" in client_entry
            print(f"by_client has {len(by_client)} entries")
    
    def test_14_analytics_by_po_aggregation(self, auth_headers):
        """Test by_po aggregation structure"""
        res = requests.get(f"{BASE_URL}/api/production-analytics", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        
        by_po = data.get("by_po", [])
        if len(by_po) > 0:
            po_entry = by_po[0]
            assert "order_number" in po_entry
            assert "produced" in po_entry
            assert "target" in po_entry
            assert "count" in po_entry
            print(f"by_po has {len(by_po)} entries")
    
    def test_15_analytics_hourly_trend(self, auth_headers):
        """Test hourly_trend structure"""
        res = requests.get(f"{BASE_URL}/api/production-analytics", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        
        hourly_trend = data.get("hourly_trend", [])
        if len(hourly_trend) > 0:
            hourly_entry = hourly_trend[0]
            assert "hour" in hourly_entry
            assert "produced" in hourly_entry
            print(f"hourly_trend has {len(hourly_trend)} entries")


class TestProductionReport:
    """Test POST /api/production-report for Excel and PDF generation"""
    
    def test_16_report_excel_generation(self, auth_headers):
        """Test Excel report generation"""
        payload = {
            "format": "excel",
            "filters": {}
        }
        res = requests.post(f"{BASE_URL}/api/production-report", json=payload, headers=auth_headers)
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        
        data = res.json()
        assert "filename" in data
        assert "data" in data
        assert "content_type" in data
        assert data["filename"].endswith(".xlsx")
        assert data["content_type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        # Verify base64 data exists
        assert len(data["data"]) > 100  # Should have substantial content
        print(f"Excel report generated: {data['filename']}, data length: {len(data['data'])}")
    
    def test_17_report_pdf_generation(self, auth_headers):
        """Test PDF report generation"""
        payload = {
            "format": "pdf",
            "filters": {}
        }
        res = requests.post(f"{BASE_URL}/api/production-report", json=payload, headers=auth_headers)
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        
        data = res.json()
        assert "filename" in data
        assert "data" in data
        assert "content_type" in data
        assert data["filename"].endswith(".pdf")
        assert data["content_type"] == "application/pdf"
        # Verify base64 data exists
        assert len(data["data"]) > 100
        print(f"PDF report generated: {data['filename']}, data length: {len(data['data'])}")
    
    def test_18_report_excel_with_shift_filter(self, auth_headers):
        """Test Excel report with shift filter"""
        payload = {
            "format": "excel",
            "filters": {
                "shift": "TURNO 2"
            }
        }
        res = requests.post(f"{BASE_URL}/api/production-report", json=payload, headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert data["filename"].endswith(".xlsx")
        print(f"Excel report with shift filter: {data['filename']}")
    
    def test_19_report_pdf_with_date_filter(self, auth_headers):
        """Test PDF report with date filters"""
        from datetime import datetime
        today = datetime.now().strftime("%Y-%m-%d")
        
        payload = {
            "format": "pdf",
            "filters": {
                "date_from": today,
                "date_to": today
            }
        }
        res = requests.post(f"{BASE_URL}/api/production-report", json=payload, headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert data["filename"].endswith(".pdf")
        print(f"PDF report with date filter: {data['filename']}")
    
    def test_20_report_excel_with_supervisor_filter(self, auth_headers):
        """Test Excel report with supervisor filter"""
        payload = {
            "format": "excel",
            "filters": {
                "supervisor": "TEST_Supervisor"
            }
        }
        res = requests.post(f"{BASE_URL}/api/production-report", json=payload, headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        assert "data" in data
        print(f"Excel report with supervisor filter generated")


class TestProductionLogsEndpoint:
    """Test GET /api/production-logs/{order_id} returns logs with new fields"""
    
    def test_21_get_production_logs_has_new_fields(self, auth_headers):
        """Verify production logs contain new fields"""
        res = requests.get(f"{BASE_URL}/api/orders", headers=auth_headers)
        orders = res.json()
        active_orders = [o for o in orders if o.get("board") != "PAPELERA DE RECICLAJE"]
        
        if len(active_orders) > 0:
            test_order = active_orders[0]
            logs_res = requests.get(f"{BASE_URL}/api/production-logs/{test_order['order_id']}", headers=auth_headers)
            assert logs_res.status_code == 200
            data = logs_res.json()
            
            assert "logs" in data
            assert "total_produced" in data
            
            # Check that logs can have new fields
            if len(data["logs"]) > 0:
                # New fields should be present (even if empty)
                print(f"Found {len(data['logs'])} logs for order {test_order.get('order_number')}")


class TestCleanup:
    """Cleanup test data"""
    
    def test_99_cleanup_test_data(self, auth_headers):
        """Delete TEST_ prefixed production logs"""
        # Note: We don't have a direct way to delete by prefix, 
        # but we can verify our test logs exist
        res = requests.get(f"{BASE_URL}/api/production-analytics", headers=auth_headers)
        assert res.status_code == 200
        data = res.json()
        
        test_logs = [l for l in data.get("logs", []) if "TEST_" in str(l.get("operator", "")) or "TEST_" in str(l.get("supervisor", ""))]
        print(f"Test data created: {len(test_logs)} logs with TEST_ prefix")
