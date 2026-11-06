"""Check new data paths and the real graph/chain without depending on LLM wording."""

import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, ToolMessage
from pydantic import ValidationError

from shop.analysis import aggregate_sales
from shop.database import ensure_database, execute_select
from shop.learning import require_october, stream_learning, validate_node
from shop.learning_schemas import ChartSpec, ReportNarrative
from shop.server import app
from shop.tools import DATA_DIR, get_profit_summary, get_sales_summary, get_stock_status, get_unpaid_invoices


class DataAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.database = ensure_database(DATA_DIR, Path(self.temporary.name) / "shop.sqlite")

    def test_sql_matches_exact_fixture_totals_and_product_order(self):
        result = execute_select(self.database, "SELECT SUM(quantity * unit_price_pence) / 100.0 AS revenue_gbp FROM sales")
        self.assertEqual(result["rows"], [[439.0]])
        filtered = execute_select(self.database, "SELECT SUM(quantity * unit_price_pence) / 100.0 FROM sales WHERE date LIKE '2026-10%'")
        self.assertEqual(filtered["rows"], [[439.0]])
        ranked = execute_select(self.database, "SELECT p.name, SUM(s.quantity * s.unit_price_pence) / 100.0 AS revenue_gbp FROM sales s JOIN products p ON s.product_id = p.product_id GROUP BY p.name ORDER BY revenue_gbp DESC")
        self.assertEqual(ranked["rows"][0], ["Weekly Planner", 144.0])
        with sqlite3.connect(self.database) as connection:
            self.assertEqual(connection.execute("SELECT typeof(unit_price_pence) FROM sales LIMIT 1").fetchone()[0], "integer")

    def test_sql_blocks_mutations_metadata_and_extra_statements(self):
        for query in ["DELETE FROM sales", "WITH x AS (SELECT 1) DELETE FROM sales", "SELECT * FROM sqlite_master", "SELECT load_extension('anything')", "SELECT * FROM sales; DROP TABLE sales", "PRAGMA table_info(sales)"]:
            with self.subTest(query=query), self.assertRaises(ValueError):
                execute_select(self.database, query)
        self.assertEqual(execute_select(self.database, "SELECT COUNT(*) FROM sales")["rows"], [[12]])

    def test_sql_limits_result_rows(self):
        result = execute_select(self.database, "SELECT a.sale_id FROM sales a CROSS JOIN sales b")
        self.assertEqual(len(result["rows"]), 100)
        self.assertTrue(result["truncated"])

    def test_source_change_rebuilds_database(self):
        source = Path(self.temporary.name) / "fixtures"
        source.mkdir()
        for path in DATA_DIR.glob("*.csv"):
            (source / path.name).write_bytes(path.read_bytes())
        changed = source / "sales.csv"
        changed.write_text(changed.read_text().replace("S001,2026-10-03,NB01,4,", "S001,2026-10-03,NB01,5,"))
        ensure_database(source, self.database)
        self.assertEqual(execute_select(self.database, "SELECT SUM(quantity) FROM sales")["rows"], [[78]])

    def test_pandas_product_and_daily_totals_match_fixtures(self):
        product = aggregate_sales("product", "revenue")
        self.assertEqual(product["chart"]["labels"][0], "Weekly Planner")
        self.assertEqual(product["chart"]["values"][0], 144.0)
        self.assertEqual(sum(product["chart"]["values"]), 439.0)
        daily = aggregate_sales("date", "revenue", "line")
        self.assertEqual(daily["chart"]["labels"], sorted(daily["chart"]["labels"]))
        self.assertEqual(len(daily["chart"]["labels"]), 12)
        self.assertEqual(sum(daily["chart"]["values"]), 439.0)
        self.assertEqual(sum(aggregate_sales("product", "units")["chart"]["values"]), 77)

    def test_chart_contract_rejects_inconsistent_values_and_code_fields(self):
        chart = aggregate_sales("product", "revenue")["chart"]
        for invalid in [{**chart, "values": [1]}, {**chart, "values": [-1] * 5}, {**chart, "kind": "line"}, {**chart, "unit": "items"}, {**chart, "code": "arbitrary()"}, {**chart, "values": [float("nan")] * 5}]:
            with self.subTest(invalid=str(invalid)[:60]), self.assertRaises(ValidationError):
                ChartSpec.model_validate(invalid)

    def test_other_chart_months_are_unavailable_not_zero(self):
        for question in ["September sales", "November revenue", "October 2025", "2026-09 sales", "Sales this month"]:
            with self.subTest(question=question), self.assertRaisesRegex(ValueError, "unavailable"):
                require_october(question)
        require_october("Show October 2026 revenue")
        require_october("May I see October revenue?")


class NarrativeModel:
    def with_structured_output(self, *args, **kwargs):
        return self

    async def ainvoke(self, *args, **kwargs):
        narrative = ReportNarrative(title="October report", summary="The records show paid revenue and profit, one stock shortage, and an overdue invoice.", next_steps=["Restock notebooks", "Review overdue invoices"])
        return {"raw": AIMessage(content=narrative.model_dump_json()), "parsed": narrative, "parsing_error": None}


class WorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_report_graph_and_parallel_branches(self):
        barrier = threading.Barrier(4, timeout=4)

        def synchronized(function):
            def wrapped(*args):
                barrier.wait()
                return function(*args)
            return wrapped

        with patch("shop.learning.classify_scope", new_callable=AsyncMock, return_value="shop"), patch("shop.learning.learning_model", return_value=NarrativeModel()), patch("shop.learning.get_sales_summary", synchronized(get_sales_summary)), patch("shop.learning.get_profit_summary", synchronized(get_profit_summary)), patch("shop.learning.get_stock_status", synchronized(get_stock_status)), patch("shop.learning.get_unpaid_invoices", synchronized(get_unpaid_invoices)):
            events = [event async for event in stream_learning("report", "Generate October report")]
        result = events[-1]["artifact"]
        self.assertEqual(result["metrics"]["revenue_gbp"], "439.00")
        self.assertEqual(result["metrics"]["profit_gbp"], "218.40")
        self.assertEqual(result["metrics"]["overdue_gbp"], "120.00")
        self.assertEqual([event["node"] for event in events if event["type"] == "graph_node" and event["state"] == "start"], ["classify", "report", "validate", "respond"])
        self.assertEqual({event["component"] for event in events if event["type"] == "chain_step"}, {"RunnableSequence", "RunnableParallel", "RunnableLambda"})
        self.assertTrue(any(event["type"] == "structured_output" for event in events))
        self.assertTrue(any(event["type"] == "validation" and event["valid"] for event in events))

    async def test_out_of_scope_takes_guidance_edge_without_analysis(self):
        with patch("shop.learning.classify_scope", new_callable=AsyncMock, return_value="outside_scope"), patch("shop.learning.build_report_chain") as chain:
            events = [event async for event in stream_learning("report", "Weather in Greece?")]
        chain.assert_not_called()
        self.assertEqual(events[-1]["artifact"]["kind"], "guidance")
        self.assertEqual([event["to"] for event in events if event["type"] == "graph_route"], ["guidance"])

    async def test_invalid_report_response_never_reaches_frontend(self):
        invalid = NarrativeModel()
        invalid.ainvoke = AsyncMock(return_value={"raw": AIMessage(content='{"not_a_report":true}'), "parsed": None, "parsing_error": "Missing report fields"})
        events = []
        with patch("shop.learning.classify_scope", new_callable=AsyncMock, return_value="shop"), patch("shop.learning.learning_model", return_value=invalid):
            with self.assertRaisesRegex(ValueError, "valid report"):
                async for event in stream_learning("report", "Generate October report"):
                    events.append(event)
        self.assertFalse(any(event["type"] == "answer" for event in events))
        self.assertTrue(any(event["type"] == "validation" and not event["valid"] for event in events))

    async def test_data_agent_result_is_traced_and_validated(self):
        class ChartAgent:
            async def astream(self, *args, **kwargs):
                call = {"name": "aggregate_sales", "args": {"group_by": "date", "metric": "revenue", "chart_type": "line"}, "id": "actual-data", "type": "tool_call"}
                yield {"model": {"messages": [AIMessage(content="", tool_calls=[call])]}}
                yield {"tools": {"messages": [ToolMessage(content=json.dumps(aggregate_sales(**call["args"])), name=call["name"], tool_call_id=call["id"])]}}
                yield {"model": {"messages": [AIMessage(content="Here is the paid-sales revenue by date.")]}}
        with patch("shop.learning.classify_scope", new_callable=AsyncMock, return_value="shop"), patch("shop.learning.data_agent", return_value=ChartAgent()):
            events = [event async for event in stream_learning("chart", "Plot daily October revenue")]
        self.assertEqual(events[-1]["artifact"]["chart"]["kind"], "line")
        self.assertEqual(events[-1]["tool_calls"][0]["name"], "aggregate_sales")
        self.assertTrue(any(event["type"] == "validation" and event["valid"] for event in events))

    async def test_final_validation_withholds_bad_chart(self):
        with patch("shop.learning.emit") as writer, self.assertRaisesRegex(ValueError, "not pass validation"):
            validate_node({"feature": "chart", "question": "Chart", "result": {"kind": "chart"}})
        self.assertTrue(any(call.args[0].get("valid") is False for call in writer.call_args_list))


class LearningAPITests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_request_validation_and_actual_graph_definition(self):
        for payload in [{"feature": "shell", "message": "Run"}, {"feature": "sql", "message": "   "}, {"feature": "chart", "message": "a" * 2001}]:
            self.assertEqual(self.client.post("/api/learning/stream", json=payload).status_code, 422)
        definition = self.client.get("/api/learning/definition").json()
        self.assertIn("validate", definition["graph"]["nodes"])
        self.assertTrue(any(edge["conditional"] for edge in definition["graph"]["edges"]))
        self.assertEqual(len(definition["tools"]["sql"]), 3)

    def test_guidance_stream_has_consistent_request_and_timestamps(self):
        with patch("shop.learning.classify_scope", new_callable=AsyncMock, return_value="outside_scope"):
            response = self.client.post("/api/learning/stream", json={"feature": "sql", "message": "Weather in Greece?"})
        events = [json.loads(block[6:]) for block in response.text.strip().split("\n\n")]
        self.assertEqual(events[0]["feature"], "sql")
        self.assertEqual(events[-1]["type"], "answer")
        self.assertEqual(events[-1]["artifact"]["kind"], "guidance")
        self.assertEqual(len({event["request_id"] for event in events}), 1)
        times = [event["elapsed_ms"] for event in events]
        self.assertEqual(times, sorted(times))


if __name__ == "__main__":
    unittest.main()
