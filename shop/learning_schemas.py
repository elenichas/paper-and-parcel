"""Contracts between the learning workflows and the browser."""

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, model_validator


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ReportNarrative(Contract):
    title: str = Field(min_length=1, max_length=120)
    summary: str = Field(min_length=1, max_length=900)
    next_steps: list[str] = Field(min_length=1, max_length=3)


class ReportMetrics(Contract):
    revenue_gbp: Decimal
    profit_gbp: Decimal
    unpaid_gbp: Decimal
    overdue_gbp: Decimal
    units_sold: int = Field(ge=0)
    restock_count: int = Field(ge=0)


class ReportResult(Contract):
    kind: Literal["report"] = "report"
    month: Literal["2026-10"] = "2026-10"
    narrative: ReportNarrative
    metrics: ReportMetrics
    evidence: dict[str, dict[str, JsonValue]]


class QueryResult(Contract):
    query: str
    columns: list[str]
    rows: list[list[str | int | float | None]]
    truncated: bool

    @model_validator(mode="after")
    def matching_columns(self):
        if any(len(row) != len(self.columns) for row in self.rows):
            raise ValueError("Each SQL row must match the returned columns.")
        return self


class SQLResult(Contract):
    kind: Literal["sql"] = "sql"
    answer: str
    queries: list[QueryResult] = Field(min_length=1)
    database: str = ".runtime/shop.sqlite"


class ChartSpec(Contract):
    kind: Literal["bar", "line"]
    title: str
    grouping: Literal["product", "date"]
    metric: Literal["revenue", "units"]
    unit: Literal["GBP", "items"]
    labels: list[str] = Field(min_length=1, max_length=100)
    values: list[float] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def coherent_series(self):
        if len(self.labels) != len(self.values):
            raise ValueError("Chart labels and values must have equal lengths.")
        if any(value < 0 for value in self.values):
            raise ValueError("This paid-sales chart cannot contain negative values.")
        if self.kind == "line" and self.grouping != "date":
            raise ValueError("Use a line chart for dates, or a bar chart for products.")
        if self.unit != ("GBP" if self.metric == "revenue" else "items"):
            raise ValueError("The chart unit must match its metric.")
        return self


class ChartResult(Contract):
    kind: Literal["chart"] = "chart"
    answer: str
    chart: ChartSpec
    operation: str
    input_rows: int
    source_files: list[str]


class GuidanceResult(Contract):
    kind: Literal["guidance"] = "guidance"
    reply: str
    suggested_questions: list[str]


LearningResult = Annotated[ReportResult | SQLResult | ChartResult | GuidanceResult, Field(discriminator="kind")]
RESULT_ADAPTER = TypeAdapter(LearningResult)
