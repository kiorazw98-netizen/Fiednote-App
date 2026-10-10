import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from pathlib import Path

import app


class BusinessApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.previous_db_path = app.DB_PATH
        app.DB_PATH = Path(self.temp_dir.name) / "test.db"
        app.initialize_database()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.BusinessHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        app.DB_PATH = self.previous_db_path
        self.temp_dir.cleanup()

    def request(self, path, method="GET", payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        request = Request(self.base_url + path, data=body, method=method,
                          headers={"Content-Type": "application/json"})
        try:
            with urlopen(request) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def test_sale_deducts_stock_and_deletion_restores_it(self):
        _, customer = self.request("/api/customers", "POST", {"name": "Avery Lane"})
        _, product = self.request("/api/products", "POST", {
            "name": "Notebook", "sku": "NOTE-1", "price": 12.5, "cost": 4, "stock": 8
        })
        status, sale = self.request("/api/sales", "POST", {
            "customer_id": customer["id"], "sale_date": "2026-10-07",
            "items": [{"product_id": product["id"], "quantity": 2}]
        })
        self.assertEqual(status, 201)
        self.assertEqual(sale["total"], 25)
        self.assertEqual(self.request("/api/products")[1][0]["stock"], 6)
        self.assertEqual(self.request("/api/sales/1", "DELETE")[0], 200)
        self.assertEqual(self.request("/api/products")[1][0]["stock"], 8)

    def test_sale_rejects_insufficient_stock_without_creating_sale(self):
        _, product = self.request("/api/products", "POST", {
            "name": "Notebook", "sku": "NOTE-1", "price": 12.5, "stock": 1
        })
        status, error = self.request("/api/sales", "POST", {
            "items": [{"product_id": product["id"], "quantity": 2}]
        })
        self.assertEqual(status, 400)
        self.assertIn("Not enough stock", error["error"])
        self.assertEqual(self.request("/api/sales")[1], [])
        self.assertEqual(self.request("/api/products")[1][0]["stock"], 1)

    def test_duplicate_sku_and_invalid_report_dates_are_reported(self):
        payload = {"name": "Notebook", "sku": "NOTE-1", "price": 12.5, "stock": 1}
        self.assertEqual(self.request("/api/products", "POST", payload)[0], 201)
        self.assertEqual(self.request("/api/products", "POST", payload)[0], 409)
        status, error = self.request("/api/reports?start=2026-10-08&end=2026-10-01")
        self.assertEqual(status, 400)
        self.assertIn("Start date", error["error"])

    def test_report_totals_account_for_sales_and_expenses(self):
        _, product = self.request("/api/products", "POST", {
            "name": "Notebook", "sku": "NOTE-1", "price": 12.5, "cost": 4, "stock": 3
        })
        self.request("/api/sales", "POST", {
            "sale_date": "2026-10-07", "items": [{"product_id": product["id"], "quantity": 2}]
        })
        self.request("/api/expenses", "POST", {
            "description": "Shipping", "category": "Supplies", "amount": 5, "expense_date": "2026-10-07"
        })
        status, report = self.request("/api/reports?start=2026-10-01&end=2026-10-31")
        self.assertEqual(status, 200)
        self.assertEqual(report["totals"]["revenue"], 25)
        self.assertEqual(report["totals"]["gross_profit"], 17)
        self.assertEqual(report["totals"]["expenses"], 5)
        self.assertEqual(report["totals"]["net_profit"], 12)


if __name__ == "__main__":
    unittest.main()
