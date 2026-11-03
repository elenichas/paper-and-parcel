"""Run step 3's four business tools directly: python -m shop.demo_tools."""

import json

from shop.tools import (
    get_profit_summary,
    get_sales_summary,
    get_stock_status,
    get_unpaid_invoices,
)


def main():
    examples = [
        ("get_sales_summary(month='2026-10')", get_sales_summary(month="2026-10")),
        ("get_profit_summary(month='2026-10')", get_profit_summary(month="2026-10")),
        ("get_unpaid_invoices(overdue_only=True)", get_unpaid_invoices(overdue_only=True)),
        ("get_stock_status(low_stock_only=True)", get_stock_status(low_stock_only=True)),
    ]
    for call, result in examples:
        print(f"\n>>> {call}")
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
