"""Step 1: read our fictional shop's CSV files without any AI or dependencies."""

import csv
from collections import defaultdict
from datetime import date
from decimal import Decimal
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DEMO_DATE = date(2026, 11, 3)
ZERO = Decimal("0.00")


def read_table(filename):
    """Read a CSV file into a list of records (Python dictionaries)."""
    with (DATA_DIR / filename).open(newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def money(value):
    return f"£{value:,.2f}"


def main():
    products = {row["product_id"]: row for row in read_table("products.csv")}
    sales = [
        row for row in read_table("sales.csv")
        if row["date"].startswith("2026-10-")
    ]
    expenses = [
        row for row in read_table("expenses.csv")
        if row["date"].startswith("2026-10-")
    ]
    invoices = read_table("invoices.csv")

    revenue = ZERO
    goods_cost = ZERO
    units_sold = defaultdict(int)
    product_revenue = defaultdict(lambda: ZERO)

    for sale in sales:
        product_id = sale["product_id"]
        if product_id not in products:
            raise ValueError(f"Unknown product in sales: {product_id}")
        quantity = int(sale["quantity"])
        if quantity <= 0:
            raise ValueError("Sale quantities must be positive")
        sale_revenue = quantity * Decimal(sale["unit_price_gbp"])
        revenue += sale_revenue
        goods_cost += quantity * Decimal(sale["unit_cost_gbp"])
        units_sold[product_id] += quantity
        product_revenue[product_id] += sale_revenue

    operating_expenses = sum((Decimal(row["amount_gbp"]) for row in expenses), ZERO)
    unpaid = [row for row in invoices if row["status"] == "unpaid"]
    overdue = [row for row in unpaid if date.fromisoformat(row["due_date"]) < DEMO_DATE]
    best_by_units = max(units_sold, key=units_sold.get)
    best_by_revenue = max(product_revenue, key=product_revenue.get)

    print("PAPER & PARCEL — fictional shop, October 2026")
    print(f"Revenue:            {money(revenue)}")
    print(f"Cost of goods sold: {money(goods_cost)}")
    print(f"Operating expenses: {money(operating_expenses)}")
    print(f"Demo profit:        {money(revenue - goods_cost - operating_expenses)}")
    print(f"Best seller by units: {products[best_by_units]['name']} ({units_sold[best_by_units]})")
    print(f"Best seller by revenue: {products[best_by_revenue]['name']} ({money(product_revenue[best_by_revenue])})")
    print(f"Unpaid invoices: {money(sum((Decimal(row['amount_gbp']) for row in unpaid), ZERO))}")

    print(f"\nOverdue invoices as of {DEMO_DATE}:")
    for invoice in overdue:
        print(f"  {invoice['customer']}: {money(Decimal(invoice['amount_gbp']))}, due {invoice['due_date']}")

    print("\nStock remaining after October sales:")
    for product_id, product in products.items():
        remaining = int(product["opening_stock"]) - units_sold[product_id]
        if remaining < 0:
            raise ValueError(f"Sales exceed available stock for {product_id}")
        flag = " — RESTOCK" if remaining <= int(product["reorder_level"]) else ""
        print(f"  {product['name']}: {remaining}{flag}")


if __name__ == "__main__":
    main()
