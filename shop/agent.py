"""The LangChain chat agent: local model, business records, and chart tools."""

import json
import time
from functools import lru_cache

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import StructuredTool, ToolException
from langchain_ollama import ChatOllama

from shop.analysis import aggregate_sales, describe_sales_dataframe, require_october
from shop.guidance import redirect_to_shop
from shop.learning_schemas import ChartResult
from shop.scope import SCOPE_PROMPT, classify_scope
from shop.tools import (
    get_profit_summary,
    get_sales_summary,
    get_stock_status,
    get_unpaid_invoices,
)


MODEL = "qwen3:4b-instruct"
OLLAMA_URL = "http://127.0.0.1:11434"
MODEL_CONTEXT = 8192
MODEL_MAX_TOKENS = 768
BUSINESS_FUNCTIONS = (
    get_sales_summary, get_profit_summary, get_unpaid_invoices, get_stock_status,
)
AGENT_FUNCTIONS = (*BUSINESS_FUNCTIONS, describe_sales_dataframe, aggregate_sales, redirect_to_shop)
TOOL_SOURCES = {
    "get_sales_summary": ["data/sales.csv", "data/products.csv"],
    "get_profit_summary": ["data/sales.csv", "data/products.csv", "data/expenses.csv"],
    "get_unpaid_invoices": ["data/invoices.csv"],
    "get_stock_status": ["data/products.csv", "data/sales.csv"],
    "redirect_to_shop": [],
    "describe_sales_dataframe": ["data/sales.csv", "data/products.csv"],
    "aggregate_sales": ["data/sales.csv", "data/products.csv"],
}
SYSTEM_PROMPT = """You are the business assistant for Paper & Parcel, a fictional
online stationery shop. Today in this demo is 3 November 2026. "Last month" is
October 2026, written 2026-10. The only monthly records available are October 2026.
Stock is a snapshot after October sales. Invoices are evaluated on 3 November.

Use the provided tools for ALL questions about the shop's sales, revenue, profit,
expenses, products, inventory or invoices. Never guess business figures. Choose
the appropriate tool, wait for its result, then answer using those facts. You may
call multiple tools if a question needs them. Use tool errors to explain missing
data; missing data is not zero activity. There are four business tools, two
pandas chart tools, and the redirect_to_shop guidance tool.

For a sales chart, inspect describe_sales_dataframe, then call aggregate_sales.
Only create a chart if the latest message asks for one. A plain revenue or
profit question needs a business answer, even after earlier chart requests.
Choose group_by='product' for comparisons or 'date' for daily trends; choose
metric='revenue' or 'units'. Products use chart_type='bar'; daily trends use 'line'.
The frontend draws the chart from this tool's validated data. You MUST call
aggregate_sales for a chart; a sales summary alone cannot produce a chart.
Only October 2026 sales charts are available. Do not claim to chart profit,
stock, invoices, or missing periods. If the desired chart is unclear, call
redirect_to_shop(reason='chart_clarification'). Do not invent chart values.
Explain the chart in at most two sentences; do not list every plotted value.

Stay within the shop assistant's scope. For unrelated requests (including weather,
news, travel, recipes, coding, or general trivia), call redirect_to_shop with
reason="outside_scope". Do not answer them from general knowledge or pretend to
have internet access. For payments, sending messages or changing records, call
redirect_to_shop with reason="unsupported_action". For "what can you do?", call
it with reason="capabilities". Brief greetings and thanks need no tools.
For a mixed request, answer the supported shop part using business tools and call
redirect_to_shop for the unsupported part. Never invent the unsupported answer.
Questions about a missing month still belong to the shop: call the relevant
business tool for that month and explain its missing-data result.

Sales summary: revenue and best-selling products, with separate winners by units
and revenue. Profit summary: sales revenue, cost of goods sold, operating expenses,
gross profit and final demo profit. Unpaid invoices: overdue_only=true filters for
late invoices. Stock status: low_stock_only=true filters for products to restock.

Write a concise, friendly answer in plain English, using GBP amounts with £ and
two decimal places. Say which period you used. Use short bullets when helpful.
Explain "profit" as revenue minus product costs and operating expenses. Exclude
unpaid invoices from revenue and profit. These are sample records, not live data.
Do not claim to execute payments, change stock, send invoices, or modify records.
Do not output tool-call syntax as your answer: request the tool using the
tool-calling interface instead. If redirect_to_shop is the only tool used, use its
reply as your answer. For mixed questions, explain the unsupported part briefly
alongside the verified shop answer. The app displays suggested questions itself.
For a follow-up business question, call a tool AGAIN for that question. Previous
assistant replies are conversation context, not authoritative business records.
"""

class AgentAnswerError(RuntimeError):
    """An actionable answer failure, distinct from a model connection problem."""

def _is_small_talk(message: str) -> bool:
    """Only simple greetings may bypass both record lookup and scope guidance."""
    return message.strip().lower().strip(".!?") in {"hi", "hello", "hey", "thanks", "thank you"}


def _business_tool(function):
    """Expose a Python function and turn missing-data errors into tool results."""
    def safe_call(**kwargs):
        try:
            return function(**kwargs)
        except ValueError as error:
            raise ToolException(str(error)) from error

    wrapped = StructuredTool.from_function(function)
    wrapped.func = safe_call
    wrapped.handle_tool_error = True
    return wrapped


def agent_definition() -> dict:
    """Return the actual registered tool schemas and our app's agent settings."""
    tools = []
    for function in AGENT_FUNCTIONS:
        registered = _business_tool(function)
        tools.append({
            "name": registered.name,
            "description": registered.description,
            "input_schema": registered.args_schema.model_json_schema(),
            "source_files": TOOL_SOURCES[registered.name],
            "type": "Python function",
            "purpose": "guidance" if function is redirect_to_shop else "business_records",
        })
    return {
        "model": MODEL, "runner": "Ollama", "framework": "LangChain / LangGraph",
        "model_url": OLLAMA_URL, "context_tokens": MODEL_CONTEXT,
        "max_output_tokens": MODEL_MAX_TOKENS, "temperature": 0,
        "system_prompt": SYSTEM_PROMPT, "tools": tools,
        "scope_check": {"model": MODEL, "prompt": SCOPE_PROMPT, "output": "Structured route classification"},
    }


@lru_cache(maxsize=1)
def get_agent():
    model = ChatOllama(
        model=MODEL,
        base_url=OLLAMA_URL,
        temperature=0,
        num_ctx=MODEL_CONTEXT,
        num_predict=MODEL_MAX_TOKENS,
        client_kwargs={"timeout": 120.0},
    )
    return create_agent(
        model=model,
        tools=[_business_tool(function) for function in AGENT_FUNCTIONS],
        system_prompt=SYSTEM_PROMPT,
    )


async def stream_answer(message: str, history: list[dict] | None = None):
    """Yield model decisions, actual tool results, and the final answer for the UI."""
    started = time.monotonic()
    yield {"type": "scope_start", "model": MODEL}
    route = await classify_scope(message, history or [])
    yield {"type": "scope_result", "route": route}
    if route in {"outside_scope", "unsupported_action", "capabilities", "chart_clarification"}:
        guidance = redirect_to_shop(route)
        yield {"type": "guidance", "name": "redirect_to_shop", "source": "application", **guidance}
        yield {
            "type": "answer", "reply": guidance["reply"], "tool_calls": [],
            "duration_seconds": round(time.monotonic() - started, 1), "model": MODEL,
            "suggested_questions": guidance["suggested_questions"], "response_kind": "guidance",
        }
        return
    if route == "chart":
        # Reuse the same period guard as the Learning Lab. A missing period
        # must never silently become a chart of October's data.
        try:
            require_october(message)
        except ValueError as error:
            guidance = redirect_to_shop("chart_clarification")
            yield {"type": "guidance", "name": "redirect_to_shop", "source": "application", **guidance}
            yield {"type": "answer", "reply": str(error), "tool_calls": [], "duration_seconds": round(time.monotonic() - started, 1), "model": MODEL, "suggested_questions": guidance["suggested_questions"], "response_kind": "guidance"}
            return
    messages = list(history or []) + [{"role": "user", "content": message}]
    calls = []
    records_checked = False
    guidance = None
    chart_data = None
    final_answer = ""
    model_step = 0
    pending_tools = set()
    for attempt in range(2):
        final_answer = ""
        model_step += 1
        yield {"type": "model_start", "step": model_step, "attempt": attempt + 1}
        async for update in get_agent().astream(
            {"messages": messages},
            config={"recursion_limit": 12},
            stream_mode="updates",
        ):
            for node_name, state in update.items():
                if not isinstance(state, dict):
                    continue
                for item in state.get("messages", []):
                    if isinstance(item, AIMessage):
                        usage = item.usage_metadata or {}
                        yield {
                            "type": "model_end", "step": model_step,
                            "tool_count": len(item.tool_calls),
                            "input_tokens": usage.get("input_tokens"),
                            "output_tokens": usage.get("output_tokens"),
                        }
                        for call in item.tool_calls:
                            pending_tools.add(call["id"])
                            entry = {"id": call["id"], "name": call["name"], "args": call["args"]}
                            calls.append(entry)
                            yield {"type": "tool_start", **entry}
                        if not item.tool_calls and item.content:
                            final_answer = item.text
                    elif isinstance(item, ToolMessage):
                        pending_tools.discard(item.tool_call_id)
                        if item.name in {
                            "get_sales_summary", "get_profit_summary",
                            "get_unpaid_invoices", "get_stock_status",
                            "aggregate_sales",
                        }:
                            records_checked = True
                        try:
                            result = json.loads(item.content)
                        except (json.JSONDecodeError, TypeError):
                            result = {"message": item.content}
                        if item.name == "redirect_to_shop" and item.status != "error":
                            guidance = result
                        if item.name == "aggregate_sales" and item.status != "error":
                            chart_data = result
                        yield {
                            "type": "tool_result", "id": item.tool_call_id,
                            "name": item.name, "result": result,
                            "status": item.status,
                        }
                # Parallel tools can arrive as separate updates. The model runs
                # again only after every result from its last request arrives.
                if node_name == "tools" and not pending_tools:
                    model_step += 1
                    yield {"type": "model_start", "step": model_step, "attempt": attempt + 1}
        if (chart_data if route == "chart" else records_checked) or guidance or _is_small_talk(message):
            break
        if attempt == 0:
            yield {"type": "status", "phase": "verification", "message": "Checking which shop tools can help with this request…"}
            messages.append({
                "role": "user",
                "content": (
                    f"Verify this question: {message}\n"
                    + ("A chart requires describe_sales_dataframe and aggregate_sales. Call them now; the browser needs their actual chart data. " if route == "chart" else "") +
                    "You MUST call the relevant tool before answering. For shop "
                    "questions, use a business tool (including for missing months). "
                    "For unrelated questions, call redirect_to_shop instead of "
                    "looking up shop records. No tool has been called for this "
                    "question yet. Do not invent products, amounts or external facts."
                ),
            })
    else:
        if route == "chart":
            guidance = redirect_to_shop("chart_clarification")
            guidance["reply"] = "I couldn’t generate that chart. Please choose one of these supported sales charts."
        else:
            raise AgentAnswerError("I couldn’t verify an answer against the shop records. Try asking about October sales, profit, stock, or unpaid invoices.")

    # A scope redirect is a successful result. Use our wording so a model cannot
    # replace it with a fabricated forecast or an unhelpful generic refusal.
    guidance_only = bool(guidance and not chart_data and (not records_checked or route == "chart"))
    if guidance_only:
        final_answer = guidance["reply"]
    if chart_data and not final_answer.strip():
        final_answer = "Here is the chart calculated from October’s paid sales records."
    if not final_answer.strip():
        raise AgentAnswerError("The model did not finish an answer. Please try asking one shop question at a time.")
    artifact = ChartResult(answer=final_answer, **chart_data).model_dump(mode="json") if chart_data else None
    if artifact:
        yield {"type": "validation", "name": "ChartResult", "valid": True, "output": artifact, "schema": ChartResult.model_json_schema()}
    yield {
        "type": "answer", "reply": final_answer, "tool_calls": calls,
        "duration_seconds": round(time.monotonic() - started, 1), "model": MODEL,
        "suggested_questions": guidance["suggested_questions"] if guidance else [],
        "response_kind": "guidance" if guidance_only else "answer",
        **({"artifact": artifact, "response_kind": "chart"} if artifact else {}),
    }
