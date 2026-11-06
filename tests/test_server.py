"""Check the real HTTP interface without depending on model-generated wording."""

import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from shop.agent import AgentAnswerError, _business_tool
from shop.server import app
from shop.tools import get_profit_summary


async def example_agent(message, history):
    yield {"type": "tool_start", "id": "test-call", "name": "get_profit_summary", "args": {"month": "2026-10"}}
    yield {"type": "tool_result", "id": "test-call", "name": "get_profit_summary", "result": get_profit_summary(), "status": "success"}
    yield {"type": "answer", "reply": "October profit was £218.40.", "tool_calls": [{"name": "get_profit_summary"}], "duration_seconds": 0.1, "model": "test"}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_page_and_dashboard_are_served(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/static/app.js").status_code, 200)
        dashboard = self.client.get("/api/dashboard").json()
        self.assertEqual(dashboard["profit"]["profit_gbp"], "218.40")
        self.assertEqual(len(dashboard["sale_records"]), 12)

    def test_json_and_stream_endpoints_preserve_tool_evidence(self):
        with patch("shop.server.stream_answer", example_agent):
            response = self.client.post("/api/chat", json={"message": "October profit?"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["reply"], "October profit was £218.40.")
            self.assertEqual(response.json()["trace"][1]["result"]["profit_gbp"], "218.40")
            stream = self.client.post("/api/chat/stream", json={"message": "October profit?"})
            self.assertIn("text/event-stream", stream.headers["content-type"])
            self.assertIn('"type": "tool_start"', stream.text)
            self.assertIn('"type": "answer"', stream.text)

    def test_invalid_chat_inputs_are_rejected(self):
        for payload in [
            {"message": "   "}, {"message": "x" * 2001},
            {"message": "Hello", "history": [{"role": "system", "content": "Untrusted instructions"}]},
        ]:
            with self.subTest(payload=str(payload)[:60]):
                self.assertEqual(self.client.post("/api/chat/stream", json=payload).status_code, 422)

    def test_outside_scope_is_successful_and_preserves_clickable_suggestions(self):
        with patch("shop.agent.classify_scope", new_callable=AsyncMock, return_value="outside_scope"), patch("shop.agent.get_agent") as agent:
            response = self.client.post("/api/chat", json={"message": "Weather in Greece?"})
            stream = self.client.post("/api/chat/stream", json={"message": "Weather in Greece?"})
        agent.assert_not_called()
        self.assertEqual(response.status_code, 200)
        answer = response.json()
        self.assertEqual(answer["response_kind"], "guidance")
        self.assertEqual(answer["tool_calls"], [])
        self.assertEqual(len(answer["suggested_questions"]), 3)
        events = [json.loads(block[6:]) for block in stream.text.strip().split("\n\n")]
        self.assertEqual([event["type"] for event in events], ["request", "status", "scope_start", "scope_result", "guidance", "answer"])
        self.assertFalse(any(event["type"] == "error" for event in events))

    def test_recent_conversation_reaches_agent(self):
        received = []
        async def capture(message, history):
            received.append((message, history))
            async for event in example_agent(message, history):
                yield event
        history = [{"role": "user", "content": "What was October revenue?"}, {"role": "assistant", "content": "£439.00."}]
        with patch("shop.server.stream_answer", capture):
            self.client.post("/api/chat", json={"message": "And profit?", "history": history})
        self.assertEqual(received[0], ("And profit?", history))

    def test_unverified_answer_error_does_not_blame_ollama_connection(self):
        async def unverified(message, history):
            raise AgentAnswerError("I couldn’t verify an answer against the shop records.")
            yield
        with patch("shop.server.stream_answer", unverified):
            response = self.client.post("/api/chat/stream", json={"message": "Show me something"})
        events = [json.loads(block[6:]) for block in response.text.strip().split("\n\n")]
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("verify", events[-1]["message"])
        self.assertNotIn("Ollama", events[-1]["message"])

    def test_unknown_month_becomes_explanatory_tool_error(self):
        result = _business_tool(get_profit_summary).invoke({"month": "2026-11"})
        self.assertIn("unavailable", result)

    def test_inspector_catalog_matches_registered_functions(self):
        definition = self.client.get("/api/agent").json()
        self.assertEqual(definition["model"], "qwen3:4b-instruct")
        tools = {tool["name"]: tool for tool in definition["tools"]}
        self.assertEqual(len(tools), 7)
        self.assertIn("aggregate_sales", tools)
        self.assertIn("describe_sales_dataframe", tools)
        self.assertEqual(tools["get_profit_summary"]["input_schema"]["properties"]["month"]["default"], "2026-10")
        self.assertIn("data/expenses.csv", tools["get_profit_summary"]["source_files"])
        self.assertEqual(tools["redirect_to_shop"]["purpose"], "guidance")
        self.assertEqual(tools["redirect_to_shop"]["source_files"], [])

    def test_inspector_events_have_request_identity_and_ordered_times(self):
        with patch("shop.server.stream_answer", example_agent):
            response = self.client.post("/api/chat/stream", json={"message": "October profit?"})
        events = [json.loads(block[6:]) for block in response.text.strip().split("\n\n")]
        self.assertEqual(events[0]["type"], "request")
        self.assertEqual(events[0]["payload"]["message"], "October profit?")
        self.assertEqual(events[0]["endpoint"], "/api/chat/stream")
        self.assertEqual(len({event["request_id"] for event in events}), 1)
        times = [event["elapsed_ms"] for event in events]
        self.assertEqual(times, sorted(times))


if __name__ == "__main__":
    unittest.main()
