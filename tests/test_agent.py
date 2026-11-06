"""Regression checks: an unverified business answer must never reach the user."""

import json
import unittest
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, ToolMessage

from shop.agent import stream_answer
from shop.analysis import aggregate_sales
from shop.guidance import redirect_to_shop
from shop.tools import get_sales_summary
from shop.scope import ScopeDecision, classify_scope


class FakeGraph:
    def __init__(self, verify_on_retry):
        self.attempts = 0
        self.verify_on_retry = verify_on_retry

    async def astream(self, *args, **kwargs):
        self.attempts += 1
        if self.attempts == 1 or not self.verify_on_retry:
            yield {"model": {"messages": [AIMessage(content="A fictional calendar earned £1,250.00.")]}}
            return
        call = {"name": "get_sales_summary", "args": {"month": "2026-10"}, "id": "verified-call", "type": "tool_call"}
        yield {"model": {"messages": [AIMessage(content="", tool_calls=[call])]}}
        yield {"tools": {"messages": [ToolMessage(
            content=json.dumps(get_sales_summary()), name="get_sales_summary", tool_call_id="verified-call",
        )]}}
        yield {"model": {"messages": [AIMessage(content="Weekly Planner earned £144.00 in October.")]}}


class AgentVerificationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Business-agent unit tests never call the real scope model.
        scope = patch("shop.agent.classify_scope", new_callable=AsyncMock, return_value="shop")
        self.scope = scope.start()
        self.addCleanup(scope.stop)

    async def test_plain_revenue_question_cannot_inherit_chart_route(self):
        for route in ["chart", "chart_clarification"]:
            model = AsyncMock()
            model.ainvoke.return_value = ScopeDecision(route=route)
            with patch("shop.scope.get_scope_model", return_value=model):
                self.assertEqual(await classify_scope("What was our October revenue?", []), "shop")
                self.assertEqual(await classify_scope("Show October revenue by product as a bar chart.", []), route)

    async def test_scope_check_redirects_before_business_agent_runs(self):
        history = [{"role": "user", "content": "October profit?"}, {"role": "assistant", "content": "£218.40."}]
        for route in ["outside_scope", "unsupported_action", "capabilities"]:
            self.scope.return_value = route
            with patch("shop.agent.get_agent") as agent:
                events = [event async for event in stream_answer("What is the weather in Greece?", history)]
            agent.assert_not_called()
            self.assertEqual(events[0]["type"], "scope_start")
            self.assertEqual(events[1], {"type": "scope_result", "route": route})
            self.assertEqual(events[2]["type"], "guidance")
            self.assertEqual(events[-1]["response_kind"], "guidance")
            self.assertEqual(events[-1]["tool_calls"], [])
            self.assertEqual(len(events[-1]["suggested_questions"]), 3)
            self.scope.assert_awaited_with("What is the weather in Greece?", history)

    async def test_vague_chart_request_offers_choices_without_unverified_model_reply(self):
        self.scope.return_value = "chart_clarification"
        history = [{"role": "user", "content": "October revenue and profit?"}, {"role": "assistant", "content": "Revenue £439; profit £218.40."}]
        with patch("shop.agent.get_agent") as agent:
            events = [event async for event in stream_answer("create a graph to show me", history)]
        agent.assert_not_called()
        answer = events[-1]
        self.assertEqual(answer["response_kind"], "guidance")
        self.assertIn("What would you like", answer["reply"])
        self.assertEqual(len(answer["suggested_questions"]), 3)
        self.assertTrue(all("October" in question for question in answer["suggested_questions"]))

    async def test_chart_request_returns_actual_validated_pandas_values(self):
        self.scope.return_value = "chart"
        class ChartGraph:
            async def astream(self, *args, **kwargs):
                call = {"name": "aggregate_sales", "args": {"group_by": "product", "metric": "revenue", "chart_type": "bar"}, "id": "chart", "type": "tool_call"}
                yield {"model": {"messages": [AIMessage(content="", tool_calls=[call])]}}
                yield {"tools": {"messages": [ToolMessage(content=json.dumps(aggregate_sales(**call["args"])), name=call["name"], tool_call_id=call["id"])]}}
                yield {"model": {"messages": [AIMessage(content="October revenue by product.")]}}
        with patch("shop.agent.get_agent", return_value=ChartGraph()):
            events = [event async for event in stream_answer("Show October revenue by product as a bar chart.")]
        answer = events[-1]
        self.assertEqual(answer["response_kind"], "chart")
        self.assertEqual(sum(answer["artifact"]["chart"]["values"]), 439.0)
        self.assertEqual(answer["artifact"]["chart"]["labels"][0], "Weekly Planner")
        self.assertTrue(any(event["type"] == "validation" and event["valid"] for event in events))

    async def test_chart_request_without_chart_tool_result_returns_choices(self):
        self.scope.return_value = "chart"
        with patch("shop.agent.get_agent", return_value=FakeGraph(verify_on_retry=True)):
            events = [event async for event in stream_answer("Show October revenue by product as a bar chart.")]
        answer = events[-1]
        self.assertEqual(answer["response_kind"], "guidance")
        self.assertNotIn("artifact", answer)
        self.assertIn("couldn’t generate", answer["reply"])
        self.assertEqual(len(answer["suggested_questions"]), 3)

    async def test_chart_missing_period_does_not_plot_october(self):
        self.scope.return_value = "chart"
        with patch("shop.agent.get_agent") as agent:
            events = [event async for event in stream_answer("Show September revenue by product as a bar chart.")]
        agent.assert_not_called()
        self.assertNotIn("artifact", events[-1])
        self.assertIn("unavailable", events[-1]["reply"])

    async def test_unrelated_question_after_shop_history_returns_guidance(self):
        class ScopeGraph:
            async def astream(self, *args, **kwargs):
                call = {"name": "redirect_to_shop", "args": {"reason": "outside_scope"}, "id": "scope", "type": "tool_call"}
                yield {"model": {"messages": [AIMessage(content="", tool_calls=[call])]}}
                yield {"tools": {"messages": [ToolMessage(
                    content=json.dumps(redirect_to_shop("outside_scope")), name=call["name"], tool_call_id=call["id"],
                )]}}
                # Even an unhelpful final draft is replaced with the app's guidance.
                yield {"model": {"messages": [AIMessage(content="It is sunny in Greece.")]}}
        history = [{"role": "user", "content": "October profit?"}, {"role": "assistant", "content": "£218.40."}]
        with patch("shop.agent.get_agent", return_value=ScopeGraph()):
            events = [event async for event in stream_answer("What is the weather in Greece?", history)]
        answer = events[-1]
        self.assertEqual(answer["type"], "answer")
        self.assertEqual(answer["response_kind"], "guidance")
        self.assertIn("can’t look up weather", answer["reply"])
        self.assertEqual(len(answer["suggested_questions"]), 3)
        self.assertNotIn("sunny", json.dumps(events))
        self.assertEqual([call["name"] for call in answer["tool_calls"]], ["redirect_to_shop"])
        self.assertFalse(any(event.get("phase") == "verification" for event in events))

    async def test_general_knowledge_without_a_tool_is_withheld(self):
        graph = FakeGraph(verify_on_retry=False)
        with patch("shop.agent.get_agent", return_value=graph):
            with self.assertRaisesRegex(RuntimeError, "verify"):
                _ = [event async for event in stream_answer("Tell me a recipe for dinner.")]
        self.assertEqual(graph.attempts, 2)

    async def test_missing_month_remains_a_business_tool_error(self):
        class MissingMonthGraph:
            async def astream(self, *args, **kwargs):
                call = {"name": "get_sales_summary", "args": {"month": "2026-09"}, "id": "missing", "type": "tool_call"}
                yield {"model": {"messages": [AIMessage(content="", tool_calls=[call])]}}
                yield {"tools": {"messages": [ToolMessage(
                    content="September records are unavailable.", name=call["name"], tool_call_id=call["id"], status="error",
                )]}}
                yield {"model": {"messages": [AIMessage(content="September records are unavailable; only October is available.")]}}
        with patch("shop.agent.get_agent", return_value=MissingMonthGraph()):
            events = [event async for event in stream_answer("September revenue?")]
        self.assertIn("September records are unavailable", events[-1]["reply"])
        self.assertEqual(events[-1]["response_kind"], "answer")
        self.assertFalse(any(event.get("phase") == "verification" for event in events))

    async def test_unsupported_actions_offer_questions_instead(self):
        class ActionGraph:
            async def astream(self, *args, **kwargs):
                call = {"name": "redirect_to_shop", "args": {"reason": "unsupported_action"}, "id": "action", "type": "tool_call"}
                yield {"model": {"messages": [AIMessage(content="", tool_calls=[call])]}}
                yield {"tools": {"messages": [ToolMessage(
                    content=json.dumps(redirect_to_shop("unsupported_action")), name=call["name"], tool_call_id=call["id"],
                )]}}
                yield {"model": {"messages": [AIMessage(content="Done, I sent the invoice.")]}}
        with patch("shop.agent.get_agent", return_value=ActionGraph()):
            events = [event async for event in stream_answer("Send Studio Fern a reminder.")]
        self.assertIn("can’t make payments, send invoices, or change the data", events[-1]["reply"])
        self.assertNotIn("Done", events[-1]["reply"])

    async def test_unverified_draft_is_replaced_by_a_tool_backed_answer(self):
        graph = FakeGraph(verify_on_retry=True)
        with patch("shop.agent.get_agent", return_value=graph):
            events = [event async for event in stream_answer("Which product earned the most revenue?")]
        answers = [event["reply"] for event in events if event["type"] == "answer"]
        self.assertEqual(answers, ["Weekly Planner earned £144.00 in October."])
        self.assertEqual(graph.attempts, 2)
        self.assertTrue(any(event["type"] == "tool_result" for event in events))
        self.assertNotIn("1,250", json.dumps(events))
        model_starts = [event for event in events if event["type"] == "model_start"]
        self.assertEqual([event["step"] for event in model_starts], [1, 2, 3])

    async def test_unverified_answer_is_withheld_if_retry_also_skips_tools(self):
        graph = FakeGraph(verify_on_retry=False)
        events = []
        with patch("shop.agent.get_agent", return_value=graph):
            with self.assertRaisesRegex(RuntimeError, "verify"):
                async for event in stream_answer("Which product earned the most revenue?"):
                    events.append(event)
        self.assertFalse(any(event["type"] == "answer" for event in events))
        self.assertEqual(graph.attempts, 2)

    async def test_parallel_tool_updates_count_as_one_following_model_call(self):
        class ParallelToolGraph:
            async def astream(self, *args, **kwargs):
                calls = [
                    {"name": "get_sales_summary", "args": {}, "id": "one", "type": "tool_call"},
                    {"name": "get_stock_status", "args": {}, "id": "two", "type": "tool_call"},
                ]
                yield {"model": {"messages": [AIMessage(content="", tool_calls=calls)]}}
                for call in calls:
                    yield {"tools": {"messages": [ToolMessage(
                        content='{"checked": true}', name=call["name"], tool_call_id=call["id"],
                    )]}}
                yield {"model": {"messages": [AIMessage(content="The tools returned their records.")]}}
        with patch("shop.agent.get_agent", return_value=ParallelToolGraph()):
            events = [event async for event in stream_answer("Check sales and stock.")]
        starts = [event for event in events if event["type"] == "model_start"]
        self.assertEqual([event["step"] for event in starts], [1, 2])
        self.assertEqual(len([event for event in events if event["type"] == "tool_result"]), 2)


if __name__ == "__main__":
    unittest.main()
