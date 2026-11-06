"""Bounded pandas tools: the model chooses an analysis, Python computes the data."""

import re
from decimal import Decimal
from typing import Literal

import pandas as pd

from shop.learning_schemas import ChartSpec
from shop.tools import DATA_DIR


def require_october(question: str):
    """The report/chart fixtures cannot answer questions about unavailable periods."""
    months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
    named = [month for month in months if month != "may" and re.search(rf"\b{month}\b", question, re.I)]
    if re.search(r"\bmay\s+(?:20\d{2}|sales|revenue|units|profit)\b|\b(?:in|for|during)\s+may\b", question, re.I):
        named.append("may")
    dated = re.findall(r"\b(\d{4}-\d{2})(?:-\d{2})?\b", question)
    years = re.findall(r"\b(20\d{2})\b", question)
    if any(month != "october" for month in named) or any(month != "2026-10" for month in dated) or any(year != "2026" for year in years) or re.search(r"\b(this month|today|yesterday|last year)\b", question, re.I):
        raise ValueError("Report and chart records only cover October 2026. The requested period is unavailable; missing data does not mean zero sales.")



def sales_dataframe() -> pd.DataFrame:
    sales = pd.read_csv(DATA_DIR / "sales.csv", dtype={"unit_price_gbp": str, "unit_cost_gbp": str})
    products = pd.read_csv(DATA_DIR / "products.csv", usecols=["product_id", "name"])
    frame = sales.merge(products, on="product_id", validate="many_to_one")
    frame["revenue_pence"] = frame["quantity"] * frame["unit_price_gbp"].map(lambda value: int(Decimal(value) * 100))
    return frame


def describe_sales_dataframe() -> dict:
    """Inspect the available pandas sales DataFrame, its columns and three sample rows."""
    frame = sales_dataframe()
    return {"rows": len(frame), "month": "2026-10", "columns": {column: str(dtype) for column, dtype in frame.dtypes.items()}, "sample": frame.head(3).to_dict(orient="records")}


def aggregate_sales(group_by: Literal["product", "date"], metric: Literal["revenue", "units"], chart_type: Literal["bar", "line"] = "bar") -> dict:
    """Use pandas to aggregate October sales and return a validated chart.

    Group by product for comparisons or date for daily trends. Choose revenue
    (GBP) or units. Line charts require date grouping; products use bars. Dates
    without a recorded sale are not added. Do not use this for other months.
    """
    frame = sales_dataframe()
    column = "name" if group_by == "product" else "date"
    measure = "revenue_pence" if metric == "revenue" else "quantity"
    grouped = frame.groupby(column, as_index=False)[measure].sum()
    grouped = grouped.sort_values(measure, ascending=False) if group_by == "product" else grouped.sort_values(column)
    chart = ChartSpec(
        kind=chart_type, title=f"October 2026 {metric} by {group_by}", grouping=group_by, metric=metric,
        unit="GBP" if metric == "revenue" else "items", labels=grouped[column].tolist(),
        values=[int(value) / 100 if metric == "revenue" else int(value) for value in grouped[measure].tolist()],
    )
    return {
        "chart": chart.model_dump(mode="json"), "input_rows": len(frame),
        "source_files": ["data/sales.csv", "data/products.csv"],
        "operation": f"pd.read_csv → merge(validate='many_to_one') → groupby('{column}')['{measure}'].sum() → sort_values",
    }
