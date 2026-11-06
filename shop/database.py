"""A reproducible SQLite copy of the CSV fixtures, queried through read-only tools."""

import csv
import hashlib
import sqlite3
import threading
import time
from decimal import Decimal
from pathlib import Path

from shop.tools import DATA_DIR


DATABASE = DATA_DIR.parent / ".runtime" / "shop.sqlite"
_database_lock = threading.Lock()
SCHEMA = {
    "products": "product_id TEXT PRIMARY KEY, name TEXT, price_pence INTEGER, unit_cost_pence INTEGER, opening_stock INTEGER, reorder_level INTEGER",
    "sales": "sale_id TEXT PRIMARY KEY, date TEXT, product_id TEXT, quantity INTEGER, unit_price_pence INTEGER, unit_cost_pence INTEGER",
    "expenses": "expense_id TEXT PRIMARY KEY, date TEXT, category TEXT, description TEXT, amount_pence INTEGER",
    "invoices": "invoice_id TEXT PRIMARY KEY, customer TEXT, issued_date TEXT, due_date TEXT, amount_pence INTEGER, status TEXT",
}


def ensure_database(data_dir: Path = DATA_DIR, database: Path = DATABASE) -> Path:
    """Rebuild the local snapshot only when its source records have changed."""
    fingerprint = hashlib.sha256(b"".join((data_dir / f"{name}.csv").read_bytes() for name in SCHEMA)).hexdigest()
    with _database_lock:
        database.parent.mkdir(exist_ok=True, parents=True)
        with sqlite3.connect(database) as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS _source (fingerprint TEXT)")
            if connection.execute("SELECT fingerprint FROM _source").fetchone() == (fingerprint,):
                return database
            for name, columns in SCHEMA.items():
                connection.execute(f'DROP TABLE IF EXISTS "{name}"')
                connection.execute(f'CREATE TABLE "{name}" ({columns})')
                with (data_dir / f"{name}.csv").open(newline="", encoding="utf-8") as file:
                    rows = list(csv.DictReader(file))
                for row in rows:
                    values = []
                    for key, value in row.items():
                        if key.endswith("_gbp"):
                            values.append(int(Decimal(value) * 100))
                        elif key in {"opening_stock", "reorder_level", "quantity"}:
                            values.append(int(value))
                        else:
                            values.append(value)
                    placeholders = ",".join("?" for _ in values)
                    connection.execute(f'INSERT INTO "{name}" VALUES ({placeholders})', values)
            connection.execute("DELETE FROM _source")
            connection.execute("INSERT INTO _source VALUES (?)", (fingerprint,))
    return database


def list_shop_tables() -> dict:
    """List the four available shop tables. Monetary columns contain integer pence."""
    ensure_database()
    return {"tables": list(SCHEMA), "month": "2026-10", "invoice_as_of": "2026-11-03", "money_storage": "Integer pence; divide by 100.0 for GBP."}


def describe_shop_tables(table_names: list[str]) -> dict:
    """Read column names and types for selected shop tables before writing SQL."""
    if not table_names or any(name not in SCHEMA for name in table_names):
        raise ValueError("Choose one or more of products, sales, expenses, invoices.")
    return {name: SCHEMA[name] for name in table_names}


def execute_select(database: Path, query: str) -> dict:
    """Run one bounded SELECT; SQLite also enforces read-only table/function access."""
    if not query.lstrip().upper().startswith(("SELECT ", "SELECT\n", "WITH ", "WITH\n")):
        raise ValueError("Only one SELECT or WITH ... SELECT query is allowed.")
    allowed_functions = {"sum", "count", "avg", "min", "max", "round", "coalesce", "ifnull", "nullif", "date", "strftime", "substr", "lower", "upper", "length", "abs", "printf", "like", "glob", "total"}

    def authorize(action, arg1, arg2, *_):
        if action == sqlite3.SQLITE_SELECT:
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_READ and arg1 in SCHEMA:
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_FUNCTION and (arg2 or "").lower() in allowed_functions:
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY

    try:
        with sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True) as connection:
            connection.execute("PRAGMA query_only=ON")
            connection.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 5000)
            connection.set_authorizer(authorize)
            deadline = time.monotonic() + 1.5
            connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            cursor = connection.execute(query)
            rows = cursor.fetchmany(101)
            return {"query": query, "columns": [column[0] for column in cursor.description], "rows": [list(row) for row in rows[:100]], "truncated": len(rows) > 100}
    except sqlite3.Error as error:
        raise ValueError(f"SQL query could not run: {error}. Check the table schema; only read-only shop queries are supported.") from error


def query_shop_database(query: str) -> dict:
    """Execute a read-only SQLite SELECT on the shop tables; return at most 100 rows.

    Money is stored in pence. Revenue in GBP is SUM(quantity * unit_price_pence) / 100.0.
    Product costs use sales.unit_cost_pence, not products.unit_cost_pence.
    Only October 2026 sales and expenses are available. Invoice date is 2026-11-03.
    """
    return execute_select(ensure_database(), query)
