"""Check business answers, missing data, and financial/date boundaries."""

import csv
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shop import tools


class ShopToolsTests(unittest.TestCase):
    def test_october_financial_answers(self):
        profit = tools.get_profit_summary("2026-10")
        self.assertEqual(profit["revenue_gbp"], "439.00")
        self.assertEqual(profit["product_costs_gbp"], "142.60")
        self.assertEqual(profit["operating_expenses_gbp"], "78.00")
        self.assertEqual(profit["profit_gbp"], "218.40")

    def test_best_sellers_depend_on_measure(self):
        sales = tools.get_sales_summary("2026-10")
        self.assertEqual(sales["units_sold"], 77)
        self.assertEqual(sales["best_sellers_by_units"][0]["name"], "Greeting Card")
        self.assertEqual(sales["best_sellers_by_revenue"][0]["name"], "Weekly Planner")

    def test_unavailable_month_is_not_zero_revenue(self):
        for function in [tools.get_sales_summary, tools.get_profit_summary]:
            with self.subTest(function=function.__name__):
                with self.assertRaisesRegex(ValueError, "unavailable"):
                    function("2026-11")
                with self.assertRaisesRegex(ValueError, "YYYY-MM"):
                    function("2026-13")

    def test_unpaid_and_overdue_are_different(self):
        self.assertEqual(tools.get_unpaid_invoices()["total_gbp"], "205.00")
        overdue = tools.get_unpaid_invoices(overdue_only=True)
        self.assertEqual(overdue["total_gbp"], "120.00")
        self.assertEqual(overdue["invoice_count"], 1)
        self.assertEqual(overdue["invoices"][0]["customer"], "Studio Fern")
        self.assertEqual(overdue["invoices"][0]["days_overdue"], 9)

    def test_stock_reflects_sold_quantities(self):
        stock = tools.get_stock_status(low_stock_only=True)
        self.assertEqual(stock["as_of"], "2026-10-31")
        self.assertEqual(stock["restock_count"], 1)
        self.assertEqual(stock["products"][0]["name"], "Dotted Notebook")
        self.assertEqual(stock["products"][0]["remaining_stock"], 5)

    def test_tools_read_records_and_handle_boundaries(self):
        # Use a separate tiny dataset with prices that require exact arithmetic.
        # Catalog cost differs from sale cost: profit must use the sale cost.
        fixtures = {
            "products.csv": [
                ["product_id", "name", "price_gbp", "unit_cost_gbp", "opening_stock", "reorder_level"],
                ["P1", "Test Pen", "0.10", "9.99", "5", "2"],
                ["P2", "Test Card", "0.30", "0.02", "10", "2"],
            ],
            "sales.csv": [
                ["sale_id", "date", "product_id", "quantity", "unit_price_gbp", "unit_cost_gbp"],
                ["S1", "2026-10-01", "P1", "3", "0.10", "0.03"],
                ["S2", "2026-10-31", "P2", "1", "0.30", "0.02"],
            ],
            "expenses.csv": [
                ["expense_id", "date", "category", "description", "amount_gbp"],
                ["E1", "2026-10-31", "Other", "Test expense", "0.10"],
            ],
            "invoices.csv": [
                ["invoice_id", "customer", "issued_date", "due_date", "amount_gbp", "status"],
                ["I1", "Due today", "2026-10-01", "2026-11-03", "5.00", "unpaid"],
                ["I2", "Already paid", "2026-10-01", "2026-10-15", "7.00", "paid"],
                ["I3", "Due yesterday", "2026-10-01", "2026-11-02", "2.00", "unpaid"],
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            fixture_dir = Path(directory)
            for filename, rows in fixtures.items():
                with (fixture_dir / filename).open("w", newline="", encoding="utf-8") as file:
                    csv.writer(file).writerows(rows)
            with patch.object(tools, "DATA_DIR", fixture_dir):
                self.assertEqual(tools.get_profit_summary()["profit_gbp"], "0.39")
                self.assertEqual(tools.get_unpaid_invoices()["total_gbp"], "7.00")
                overdue = tools.get_unpaid_invoices(overdue_only=True)
                self.assertEqual(overdue["total_gbp"], "2.00")
                self.assertEqual(overdue["invoices"][0]["days_overdue"], 1)
                self.assertEqual(len(tools.get_sales_summary()["best_sellers_by_revenue"]), 2)
                restock = tools.get_stock_status(low_stock_only=True)["products"]
                self.assertEqual(len(restock), 1)
                self.assertEqual(restock[0]["remaining_stock"], 2)


if __name__ == "__main__":
    unittest.main()
