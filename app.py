import json
import logging
import sqlite3
from contextlib import contextmanager
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "business.db"
STATIC_DIR = ROOT / "static"


@contextmanager
def connect():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize_database():
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                address TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                sku TEXT NOT NULL UNIQUE,
                category TEXT NOT NULL DEFAULT '',
                price REAL NOT NULL CHECK (price >= 0),
                cost REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
                stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sales (
                id INTEGER PRIMARY KEY,
                customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
                total REAL NOT NULL CHECK (total >= 0),
                profit REAL NOT NULL DEFAULT 0,
                sale_date TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sale_items (
                id INTEGER PRIMARY KEY,
                sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
                product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
                product_name TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                unit_price REAL NOT NULL,
                unit_cost REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'Other',
                amount REAL NOT NULL CHECK (amount > 0),
                expense_date TEXT NOT NULL
            );
            """
        )


def as_dict(row):
    return dict(row) if row else None


def require_text(data, key, label=None):
    value = str(data.get(key, "")).strip()
    if not value:
        raise ValueError(f"{label or key.replace('_', ' ').capitalize()} is required.")
    return value


def money(data, key, *, allow_zero=True):
    try:
        value = round(float(data.get(key, 0)), 2)
    except (TypeError, ValueError):
        raise ValueError(f"{key.replace('_', ' ').capitalize()} must be a number.") from None
    if value < 0 or (not allow_zero and value == 0):
        raise ValueError(f"{key.replace('_', ' ').capitalize()} must be greater than zero.")
    return value


def integer(data, key, *, minimum=0):
    try:
        value = int(data.get(key, minimum))
    except (TypeError, ValueError):
        raise ValueError(f"{key.replace('_', ' ').capitalize()} must be a whole number.") from None
    if value < minimum:
        raise ValueError(f"{key.replace('_', ' ').capitalize()} must be at least {minimum}.")
    return value


def valid_date(value):
    value = str(value or date.today().isoformat())
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ValueError("Date must use YYYY-MM-DD format.") from None
    return value


def list_customers(db):
    return [as_dict(row) for row in db.execute(
        "SELECT c.*, (SELECT COUNT(*) FROM sales s WHERE s.customer_id=c.id) AS orders "
        "FROM customers c ORDER BY c.name COLLATE NOCASE"
    )]


def list_products(db):
    return [as_dict(row) for row in db.execute("SELECT * FROM products ORDER BY name COLLATE NOCASE")]


def list_sales(db):
    rows = db.execute(
        "SELECT s.*, COALESCE(c.name, 'Walk-in customer') AS customer_name, "
        "(SELECT COUNT(*) FROM sale_items i WHERE i.sale_id=s.id) AS item_count "
        "FROM sales s LEFT JOIN customers c ON c.id=s.customer_id "
        "ORDER BY s.sale_date DESC, s.id DESC"
    )
    result = []
    for row in rows:
        sale = as_dict(row)
        sale["items"] = [as_dict(item) for item in db.execute(
            "SELECT product_id, product_name, quantity, unit_price, unit_cost "
            "FROM sale_items WHERE sale_id=? ORDER BY id", (sale["id"],)
        )]
        result.append(sale)
    return result


def list_expenses(db):
    return [as_dict(row) for row in db.execute(
        "SELECT * FROM expenses ORDER BY expense_date DESC, id DESC"
    )]


def report_data(db, start, end):
    start = valid_date(start)
    end = valid_date(end)
    if start > end:
        raise ValueError("Start date must be on or before end date.")
    totals = as_dict(db.execute(
        "SELECT COALESCE((SELECT SUM(total) FROM sales WHERE sale_date BETWEEN ? AND ?),0) AS revenue, "
        "COALESCE((SELECT SUM(profit) FROM sales WHERE sale_date BETWEEN ? AND ?),0) AS gross_profit, "
        "COALESCE((SELECT SUM(amount) FROM expenses WHERE expense_date BETWEEN ? AND ?),0) AS expenses, "
        "(SELECT COUNT(*) FROM sales WHERE sale_date BETWEEN ? AND ?) AS orders",
        (start, end, start, end, start, end, start, end),
    ).fetchone())
    totals["net_profit"] = round(totals["gross_profit"] - totals["expenses"], 2)
    totals["revenue"] = round(totals["revenue"], 2)
    totals["gross_profit"] = round(totals["gross_profit"], 2)
    totals["expenses"] = round(totals["expenses"], 2)
    totals["net_profit"] = round(totals["net_profit"], 2)
    totals["average_order"] = round(totals["revenue"] / totals["orders"], 2) if totals["orders"] else 0
    by_day = [as_dict(row) for row in db.execute(
        "SELECT sale_date AS date, SUM(total) AS revenue FROM sales "
        "WHERE sale_date BETWEEN ? AND ? GROUP BY sale_date ORDER BY sale_date", (start, end)
    )]
    by_category = [as_dict(row) for row in db.execute(
        "SELECT category, SUM(amount) AS amount FROM expenses "
        "WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC", (start, end)
    )]
    return {"start": start, "end": end, "totals": totals, "sales_by_day": by_day,
            "expenses_by_category": by_category}


class BusinessHandler(BaseHTTPRequestHandler):
    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1_000_000:
                raise ValueError("Request body is too large.")
            return json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("Request body must be valid JSON.") from None

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/"):
            try:
                with connect() as db:
                    if path == "/api/customers":
                        return self.send_json(list_customers(db))
                    if path == "/api/products":
                        return self.send_json(list_products(db))
                    if path == "/api/sales":
                        return self.send_json(list_sales(db))
                    if path == "/api/expenses":
                        return self.send_json(list_expenses(db))
                    if path == "/api/reports":
                        query = parse_qs(parsed.query)
                        start = query.get("start", [date.today().replace(day=1).isoformat()])[0]
                        end = query.get("end", [date.today().isoformat()])[0]
                        return self.send_json(report_data(db, start, end))
                    if path == "/api/dashboard":
                        today = date.today().isoformat()
                        month_start = date.today().replace(day=1).isoformat()
                        return self.send_json({
                            "customers": db.execute("SELECT COUNT(*) FROM customers").fetchone()[0],
                            "products": db.execute("SELECT COUNT(*) FROM products").fetchone()[0],
                            "revenue": db.execute(
                                "SELECT COALESCE(SUM(total),0) FROM sales WHERE sale_date BETWEEN ? AND ?",
                                (month_start, today)).fetchone()[0],
                            "expenses": db.execute(
                                "SELECT COALESCE(SUM(amount),0) FROM expenses WHERE expense_date BETWEEN ? AND ?",
                                (month_start, today)).fetchone()[0],
                            "low_stock": [as_dict(row) for row in db.execute(
                                "SELECT id,name,sku,stock FROM products WHERE stock <= 5 ORDER BY stock,name LIMIT 6"
                            )],
                            "recent_sales": list_sales(db)[:5],
                            "monthly_sales": [as_dict(row) for row in db.execute(
                                "SELECT sale_date AS date, SUM(total) AS revenue FROM sales "
                                "WHERE sale_date >= date('now','-6 months') "
                                "GROUP BY sale_date ORDER BY sale_date"
                            )],
                        })
            except ValueError as error:
                return self.send_json({"error": str(error)}, 400)
            return self.send_json({"error": "Not found."}, 404)
        self.serve_static(path)

    def serve_static(self, path):
        relative = "index.html" if path == "/" else path.lstrip("/")
        target = (STATIC_DIR / relative).resolve()
        if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
            self.send_error(404)
            return
        content_type = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                        ".js": "text/javascript; charset=utf-8"}.get(target.suffix, "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            data = self.read_json()
            with connect() as db:
                path = urlparse(self.path).path
                if path == "/api/customers":
                    name = require_text(data, "name", "Customer name")
                    cursor = db.execute(
                        "INSERT INTO customers(name,email,phone,address) VALUES(?,?,?,?)",
                        (name, str(data.get("email", "")).strip(), str(data.get("phone", "")).strip(),
                         str(data.get("address", "")).strip()))
                    return self.send_json({"id": cursor.lastrowid}, 201)
                if path == "/api/products":
                    name, sku = require_text(data, "name", "Product name"), require_text(data, "sku", "SKU")
                    cursor = db.execute(
                        "INSERT INTO products(name,sku,category,price,cost,stock) VALUES(?,?,?,?,?,?)",
                        (name, sku, str(data.get("category", "")).strip(), money(data, "price"),
                         money(data, "cost"), integer(data, "stock")))
                    return self.send_json({"id": cursor.lastrowid}, 201)
                if path == "/api/expenses":
                    cursor = db.execute(
                        "INSERT INTO expenses(description,category,amount,expense_date) VALUES(?,?,?,?)",
                        (require_text(data, "description", "Description"),
                         str(data.get("category", "Other")).strip() or "Other",
                         money(data, "amount", allow_zero=False), valid_date(data.get("expense_date"))))
                    return self.send_json({"id": cursor.lastrowid}, 201)
                if path == "/api/sales":
                    return self.create_sale(db, data)
            return self.send_json({"error": "Not found."}, 404)
        except ValueError as error:
            return self.send_json({"error": str(error)}, 400)
        except sqlite3.IntegrityError as error:
            message = "That SKU is already in use." if "products.sku" in str(error) else "The record could not be saved."
            return self.send_json({"error": message}, 409)

    def create_sale(self, db, data):
        items = data.get("items")
        if not isinstance(items, list) or not items:
            raise ValueError("Add at least one product to the sale.")
        customer_id = data.get("customer_id") or None
        if customer_id is not None:
            customer_id = integer({"customer_id": customer_id}, "customer_id", minimum=1)
            if not db.execute("SELECT 1 FROM customers WHERE id=?", (customer_id,)).fetchone():
                raise ValueError("Selected customer was not found.")
        sale_date = valid_date(data.get("sale_date"))
        quantities = {}
        for item in items:
            product_id = integer(item, "product_id", minimum=1)
            quantities[product_id] = quantities.get(product_id, 0) + integer(item, "quantity", minimum=1)
        products = {}
        total, profit = 0, 0
        for product_id, quantity in quantities.items():
            product = db.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
            if not product:
                raise ValueError("A selected product was not found.")
            if product["stock"] < quantity:
                raise ValueError(f"Not enough stock for {product['name']} (available: {product['stock']}).")
            products[product_id] = (product, quantity)
            total += product["price"] * quantity
            profit += (product["price"] - product["cost"]) * quantity
        cursor = db.execute("INSERT INTO sales(customer_id,total,profit,sale_date) VALUES(?,?,?,?)",
                            (customer_id, round(total, 2), round(profit, 2), sale_date))
        for product_id, (product, quantity) in products.items():
            db.execute("INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,unit_cost) "
                       "VALUES(?,?,?,?,?,?)",
                       (cursor.lastrowid, product_id, product["name"], quantity, product["price"], product["cost"]))
            db.execute("UPDATE products SET stock=stock-? WHERE id=?", (quantity, product_id))
        return self.send_json({"id": cursor.lastrowid, "total": round(total, 2)}, 201)

    def do_PUT(self):
        try:
            data = self.read_json()
            parts = urlparse(self.path).path.strip("/").split("/")
            if len(parts) != 3 or parts[0] != "api":
                return self.send_json({"error": "Not found."}, 404)
            resource, record_id = parts[1], int(parts[2])
            with connect() as db:
                if resource == "customers":
                    values = (require_text(data, "name", "Customer name"),
                              str(data.get("email", "")).strip(), str(data.get("phone", "")).strip(),
                              str(data.get("address", "")).strip(), record_id)
                    cursor = db.execute("UPDATE customers SET name=?,email=?,phone=?,address=? WHERE id=?", values)
                elif resource == "products":
                    values = (require_text(data, "name", "Product name"), require_text(data, "sku", "SKU"),
                              str(data.get("category", "")).strip(), money(data, "price"), money(data, "cost"),
                              integer(data, "stock"), record_id)
                    cursor = db.execute("UPDATE products SET name=?,sku=?,category=?,price=?,cost=?,stock=? WHERE id=?",
                                        values)
                elif resource == "expenses":
                    values = (require_text(data, "description", "Description"),
                              str(data.get("category", "Other")).strip() or "Other",
                              money(data, "amount", allow_zero=False), valid_date(data.get("expense_date")), record_id)
                    cursor = db.execute(
                        "UPDATE expenses SET description=?,category=?,amount=?,expense_date=? WHERE id=?", values)
                else:
                    return self.send_json({"error": "Not found."}, 404)
                if not cursor.rowcount:
                    return self.send_json({"error": "Record not found."}, 404)
            return self.send_json({"ok": True})
        except (ValueError, TypeError):
            return self.send_json({"error": "Invalid record ID or request data."}, 400)
        except sqlite3.IntegrityError as error:
            message = "That SKU is already in use." if "products.sku" in str(error) else "The record could not be saved."
            return self.send_json({"error": message}, 409)

    def do_DELETE(self):
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) != 3 or parts[0] != "api":
            return self.send_json({"error": "Not found."}, 404)
        try:
            record_id = int(parts[2])
            with connect() as db:
                if parts[1] == "sales":
                    sale = db.execute("SELECT id FROM sales WHERE id=?", (record_id,)).fetchone()
                    if not sale:
                        return self.send_json({"error": "Record not found."}, 404)
                    for item in db.execute("SELECT product_id,quantity FROM sale_items WHERE sale_id=?", (record_id,)):
                        db.execute("UPDATE products SET stock=stock+? WHERE id=?", (item["quantity"], item["product_id"]))
                    db.execute("DELETE FROM sales WHERE id=?", (record_id,))
                elif parts[1] in ("customers", "products", "expenses"):
                    cursor = db.execute(f"DELETE FROM {parts[1]} WHERE id=?", (record_id,))
                    if not cursor.rowcount:
                        return self.send_json({"error": "Record not found."}, 404)
                else:
                    return self.send_json({"error": "Not found."}, 404)
            return self.send_json({"ok": True})
        except ValueError:
            return self.send_json({"error": "Invalid record ID."}, 400)
        except sqlite3.IntegrityError:
            return self.send_json({"error": "This product is used in a sale and cannot be deleted."}, 409)

    def log_message(self, format_string, *args):
        logging.info("%s - %s", self.address_string(), format_string % args)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    initialize_database()
    server = ThreadingHTTPServer(("127.0.0.1", 8000), BusinessHandler)
    print("Business manager is running at http://127.0.0.1:8000")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.server_close()
