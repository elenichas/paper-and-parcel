"""Step 3: ordinary Python functions that our LangChain agent will call later.

Money is calculated with Decimal and returned as strings with two decimal places,
so results are exact and can be sent as JSON to a model or web frontend.
"""

import csv
from collections import defaultdict
from datetime import date
from decimal import Decimal
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_MONTH = "2026-10"
STOCK_DATE = "2026-10-31"
DEMO_DATE = date(2026, 11, 3)
ZERO = Decimal("0.00")


def _read_table(filename: str) -> list[dict]:
    with (DATA_DIR / filename).open(newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def _monthly_rows(filename: str, month: str) -> list[dict]:
    try:
        date.fromisoformat(f"{month}-01")
    except ValueError:
        raise ValueError("Use a valid month in YYYY-MM format, such as 2026-10.") from None
    if month != DATA_MONTH:
        raise ValueError(
            f"Sample records only cover {DATA_MONTH}; data for {month} is unavailable. "
            "Unavailable data does not mean zero sales."
        )
    return [row for row in _read_table(filename) if row["date"].startswith(month + "-")]


def _amount(value: Decimal) -> str:
    return f"{value:.2f}"


def _sales_quantity(sale: dict) -> int:
    quantity = int(sale["quantity"])
    if quantity <= 0:
        raise ValueError(f"Sale {sale['sale_id']} must have a positive quantity.")
    return quantity


def get_sales_summary(month: str = DATA_MONTH) -> dict:
    """Get paid revenue, units sold, and best sellers for a YYYY-MM month.

    Only October 2026 is available in this fictional shop's dataset. Best sellers
    are reported separately by units and revenue. Unpaid invoices are excluded.
    """
    sales = _monthly_rows("sales.csv", month)
    products = {row["product_id"]: row for row in _read_table("products.csv")}
    units = defaultdict(int)
    revenue = defaultdict(lambda: ZERO)

    for sale in sales:
        product_id = sale["product_id"]
        if product_id not in products:
            raise ValueError(f"Unknown product in sales: {product_id}")
        quantity = _sales_quantity(sale)
        units[product_id] += quantity
        revenue[product_id] += quantity * Decimal(sale["unit_price_gbp"])

    breakdown = [
        {
            "product_id": product_id,
            "name": products[product_id]["name"],
            "units_sold": units[product_id],
            "revenue_gbp": _amount(revenue[product_id]),
        }
        for product_id in sorted(units)
    ]
    most_units = max(units.values(), default=0)
    most_revenue = max(revenue.values(), default=ZERO)

    return {
        "month": month,
        "currency": "GBP",
        "paid_sale_count": len(sales),
        "units_sold": sum(units.values()),
        "revenue_gbp": _amount(sum(revenue.values(), ZERO)),
        "best_sellers_by_units": [row for row in breakdown if row["units_sold"] == most_units],
        "best_sellers_by_revenue": [
            row for row in breakdown if Decimal(row["revenue_gbp"]) == most_revenue
        ],
        "products": breakdown,
    }


def get_profit_summary(month: str = DATA_MONTH) -> dict:
    """Calculate a month's paid revenue minus sold-product costs and expenses.

    Only October 2026 is available. Use each sale's recorded unit cost, not the
    current catalog cost. Unpaid wholesale invoices and VAT are excluded.
    """
    sales_summary = get_sales_summary(month)
    sales = _monthly_rows("sales.csv", month)
    expenses = _monthly_rows("expenses.csv", month)
    goods_cost = sum(
        (_sales_quantity(sale) * Decimal(sale["unit_cost_gbp"]) for sale in sales), ZERO
    )
    operating_expenses = sum((Decimal(row["amount_gbp"]) for row in expenses), ZERO)
    revenue = Decimal(sales_summary["revenue_gbp"])

    return {
        "month": month,
        "currency": "GBP",
        "revenue_gbp": _amount(revenue),
        "product_costs_gbp": _amount(goods_cost),
        "gross_profit_gbp": _amount(revenue - goods_cost),
        "operating_expenses_gbp": _amount(operating_expenses),
        "profit_gbp": _amount(revenue - goods_cost - operating_expenses),
        "basis": "Paid sales only. Unpaid wholesale invoices and VAT are excluded.",
    }


def get_unpaid_invoices(overdue_only: bool = False) -> dict:
    """List unpaid invoices or only overdue ones, as of the demo date 2026-11-03.

    An invoice is overdue when its due date is before the demo date. Invoices
    due on the demo date are not overdue. Paid invoices are always excluded.
    """
    invoices = []
    for row in _read_table("invoices.csv"):
        if row["status"] != "unpaid" or date.fromisoformat(row["issued_date"]) > DEMO_DATE:
            continue
        days_overdue = max(0, (DEMO_DATE - date.fromisoformat(row["due_date"])).days)
        if overdue_only and days_overdue == 0:
            continue
        invoices.append({
            "invoice_id": row["invoice_id"],
            "customer": row["customer"],
            "due_date": row["due_date"],
            "amount_gbp": _amount(Decimal(row["amount_gbp"])),
            "is_overdue": days_overdue > 0,
            "days_overdue": days_overdue,
        })

    invoices.sort(key=lambda row: (row["due_date"], row["invoice_id"]))
    return {
        "as_of": DEMO_DATE.isoformat(),
        "currency": "GBP",
        "overdue_only": overdue_only,
        "invoice_count": len(invoices),
        "total_gbp": _amount(sum((Decimal(row["amount_gbp"]) for row in invoices), ZERO)),
        "invoices": invoices,
    }


def get_stock_status(low_stock_only: bool = False) -> dict:
    """Get stock after October 2026 paid sales, optionally only restock items.

    Opening stock is from 2026-10-01. This sample has no restocks or returns;
    unpaid wholesale orders have not shipped. Restock at or below reorder level.
    """
    sales_summary = get_sales_summary(DATA_MONTH)
    units_sold = {row["product_id"]: row["units_sold"] for row in sales_summary["products"]}
    products = []
    restock_count = 0

    for row in _read_table("products.csv"):
        sold = units_sold.get(row["product_id"], 0)
        remaining = int(row["opening_stock"]) - sold
        if remaining < 0:
            raise ValueError(f"Sales exceed available stock for {row['product_id']}.")
        needs_restock = remaining <= int(row["reorder_level"])
        restock_count += int(needs_restock)
        if low_stock_only and not needs_restock:
            continue
        products.append({
            "product_id": row["product_id"],
            "name": row["name"],
            "opening_stock": int(row["opening_stock"]),
            "units_sold": sold,
            "remaining_stock": remaining,
            "reorder_level": int(row["reorder_level"]),
            "needs_restock": needs_restock,
        })

    return {
        "as_of": STOCK_DATE,
        "low_stock_only": low_stock_only,
        "restock_count": restock_count,
        "products": products,
    }
