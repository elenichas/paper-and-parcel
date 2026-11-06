"""Executable course examples: LCEL report, SQL/pandas agents, explicit LangGraph."""

import asyncio
import json
import time
from decimal import Decimal
from functools import lru_cache
from typing import Literal, TypedDict

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.runnables import RunnableLambda, RunnableParallel, RunnableSequence
from langchain_ollama import ChatOllama
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from pydantic import ValidationError

from shop.agent import MODEL, MODEL_CONTEXT, OLLAMA_URL, _business_tool
from shop.analysis import aggregate_sales, describe_sales_dataframe, require_october
from shop.database import describe_shop_tables, list_shop_tables, query_shop_database
from shop.guidance import redirect_to_shop
from shop.learning_schemas import ChartResult, RESULT_ADAPTER, ReportMetrics, ReportNarrative, ReportResult, SQLResult
from shop.scope import classify_scope
from shop.tools import get_profit_summary, get_sales_summary, get_stock_status, get_unpaid_invoices


FEATURES = {
    "report": {"title": "October report", "concepts": ["RunnableSequence", "RunnableParallel", "Structured output", "Pydantic"], "source": "shop/learning.py: build_report_chain"},
    "sql": {"title": "SQL agent", "concepts": ["LangChain agent", "SQLite", "Tool calling", "Pydantic"], "source": "shop/database.py + shop/learning.py: run_data_agent"},
    "chart": {"title": "Pandas charts", "concepts": ["LangChain agent", "pandas", "ChartSpec", "Pydantic"], "source": "shop/analysis.py + shop/learning.py: run_data_agent"},
}
DATA_TOOLS = {
    "sql": (list_shop_tables, describe_shop_tables, query_shop_database),
    "chart": (describe_sales_dataframe, aggregate_sales),
}
LEARNING_OUTPUT_TOKENS = 768
REPORT_PROMPT = "Write a concise report for Paper & Parcel's October 2026 sample records. Use only the supplied facts. Suggest up to three practical next steps. Unpaid invoices are not revenue. Return the required report schema."
SQL_PROMPT = """You answer read-only questions about the fictional Paper & Parcel shop using SQLite.
You MUST call list_shop_tables, describe_shop_tables for relevant tables, then
query_shop_database before answering. You may correct a query after a tool error.
No SQL execution means you cannot give a factual answer. Never write or modify data.
Money columns are INTEGER PENCE. Use SUM(quantity * unit_price_pence) / 100.0 AS revenue_gbp.
For product revenue JOIN sales s ON products.product_id = s.product_id, then GROUP BY products.name.
Costs use sales.unit_cost_pence. There are only October 2026 sales and expenses.
No records for other months means unavailable data, not zero sales. Today is 2026-11-03.
Invoices are separate from paid sales. Overdue means status='unpaid' AND due_date < '2026-11-03'.
Answer briefly using the actual query results. Use the tool interface, not SQL in your final reply.
"""
PANDAS_PROMPT = """You analyse October 2026 shop sales using pandas tools.
First inspect describe_sales_dataframe, then call aggregate_sales. For products use
group_by='product' and chart_type='bar'. For daily trends use group_by='date' and
chart_type='line'. Choose metric='revenue' for money, or 'units' for quantities.
You MUST call aggregate_sales before answering. Do not invent chart values or run
Python code: the tools perform pandas operations. Only October 2026 is available.
If another month is requested, explain the unavailable data without making a chart.
Explain the returned chart in at most two sentences using its actual values.
Do not list every data point; the frontend shows the chart and a data table.
Dates without a recorded
sale are not shown, and unpaid invoices are excluded. Use the tool-calling interface.
"""


def emit(event: dict):
    get_stream_writer()(event)


@lru_cache(maxsize=1)
def learning_model():
    return ChatOllama(model=MODEL, base_url=OLLAMA_URL, temperature=0, num_ctx=MODEL_CONTEXT, num_predict=LEARNING_OUTPUT_TOKENS, client_kwargs={"timeout": 120.0})


def build_report_chain():
    async def prepare(request):
        emit({"type": "chain_step", "name": "Prepare October request", "component": "RunnableLambda", "state": "start", "input": request})
        prepared = {**request, "month": "2026-10"}
        emit({"type": "chain_step", "name": "Prepare October request", "component": "RunnableLambda", "state": "end", "output": prepared})
        emit({"type": "chain_step", "name": "Read independent records", "component": "RunnableParallel", "state": "start", "input": {"month": prepared["month"]}})
        return prepared

    def branch(name, function, monthly=False):
        async def read(request):
            started = time.monotonic()
            emit({"type": "chain_step", "name": name, "component": "RunnableLambda", "branch": name, "state": "start", "input": {"month": request["month"]} if monthly else {}})
            result = await asyncio.to_thread(function, request["month"]) if monthly else await asyncio.to_thread(function)
            emit({"type": "chain_step", "name": name, "component": "RunnableLambda", "branch": name, "state": "end", "output": result, "duration_ms": round((time.monotonic() - started) * 1000, 2)})
            return result
        return RunnableLambda(read, name=name)

    async def compose(records):
        evidence = {key: value for key, value in records.items() if key != "request"}
        emit({"type": "chain_step", "name": "Read independent records", "component": "RunnableParallel", "state": "end", "output": evidence})
        emit({"type": "chain_step", "name": "Compose and validate report", "component": "RunnableLambda", "state": "start", "input": evidence})
        emit({"type": "model_start", "step": 1, "attempt": 1, "purpose": "ReportNarrative structured output"})
        response = await learning_model().with_structured_output(ReportNarrative, method="json_schema", include_raw=True).ainvoke([
            {"role": "system", "content": REPORT_PROMPT},
            {"role": "user", "content": json.dumps(evidence)},
        ])
        raw = response["raw"]
        emit({"type": "model_end", "step": 1, "tool_count": 0, **{f"{key}_tokens": (raw.usage_metadata or {}).get(f"{key}_tokens") for key in ["input", "output"]}})
        emit({"type": "structured_output", "name": "ReportNarrative", "raw_output": raw.content, "parsed": response["parsed"].model_dump(mode="json") if response["parsed"] else None, "schema": ReportNarrative.model_json_schema()})
        if response.get("parsing_error") or response["parsed"] is None:
            emit({"type": "validation", "name": "ReportNarrative", "valid": False, "errors": str(response.get("parsing_error"))})
            raise ValueError("The model did not produce a valid report. Try generating it again.")
        narrative = ReportNarrative.model_validate(response["parsed"])
        metrics = ReportMetrics(
            revenue_gbp=evidence["sales"]["revenue_gbp"], profit_gbp=evidence["profit"]["profit_gbp"],
            unpaid_gbp=evidence["invoices"]["total_gbp"],
            overdue_gbp=sum((Decimal(row["amount_gbp"]) for row in evidence["invoices"]["invoices"] if row["is_overdue"]), Decimal("0.00")),
            units_sold=evidence["sales"]["units_sold"], restock_count=evidence["stock"]["restock_count"],
        )
        result = ReportResult(narrative=narrative, metrics=metrics, evidence=evidence).model_dump(mode="json")
        emit({"type": "chain_step", "name": "Compose and validate report", "component": "RunnableLambda", "state": "end", "output": result})
        return result

    parallel = RunnableParallel(
        request=RunnableLambda(lambda request: request),
        sales=branch("Sales", get_sales_summary, True), profit=branch("Profit", get_profit_summary, True),
        stock=branch("Stock", get_stock_status), invoices=branch("Invoices", get_unpaid_invoices),
    )
    return RunnableSequence(RunnableLambda(prepare, name="Prepare request"), parallel, RunnableLambda(compose, name="Compose report"))


@lru_cache(maxsize=2)
def data_agent(feature: Literal["sql", "chart"]):
    return create_agent(learning_model(), tools=[_business_tool(function) for function in DATA_TOOLS[feature]], system_prompt=SQL_PROMPT if feature == "sql" else PANDAS_PROMPT)


async def run_data_agent(feature: str, question: str) -> tuple[dict, list]:
    messages = [{"role": "user", "content": question}]
    calls, results = [], []
    step = 0
    target = "query_shop_database" if feature == "sql" else "aggregate_sales"
    final = ""
    for attempt in range(2):
        pending = set()
        step += 1
        emit({"type": "model_start", "step": step, "attempt": attempt + 1})
        async for update in data_agent(feature).astream({"messages": messages}, config={"recursion_limit": 16}, stream_mode="updates"):
            for node, state in update.items():
                if not isinstance(state, dict):
                    continue
                for message in state.get("messages", []):
                    if isinstance(message, AIMessage):
                        emit({"type": "model_end", "step": step, "tool_count": len(message.tool_calls), "input_tokens": (message.usage_metadata or {}).get("input_tokens"), "output_tokens": (message.usage_metadata or {}).get("output_tokens")})
                        for call in message.tool_calls:
                            pending.add(call["id"])
                            entry = {"id": call["id"], "name": call["name"], "args": call["args"]}
                            calls.append(entry)
                            emit({"type": "tool_start", **entry})
                        if not message.tool_calls and message.content:
                            final = message.text
                    elif isinstance(message, ToolMessage):
                        pending.discard(message.tool_call_id)
                        try:
                            result = json.loads(message.content)
                        except (json.JSONDecodeError, TypeError):
                            result = {"message": message.content}
                        emit({"type": "tool_result", "id": message.tool_call_id, "name": message.name, "status": message.status, "result": result})
                        if message.name == target and message.status != "error":
                            results.append(result)
                if node == "tools" and not pending:
                    step += 1
                    emit({"type": "model_start", "step": step, "attempt": attempt + 1})
        if results:
            break
        if attempt == 0:
            emit({"type": "status", "phase": "verification", "message": f"Asking the agent to call {target} before answering…"})
            messages.append({"role": "user", "content": f"You have not completed the analysis. Use {target} and answer from its result. Original request: {question}"})
    if not results:
        raise ValueError("The agent did not complete a data lookup. Try one of the example questions.")
    if feature == "sql":
        artifact = SQLResult(answer=final or "The database returned the following records.", queries=results).model_dump(mode="json")
    else:
        last = results[-1]
        artifact = ChartResult(answer=final or "The chart shows the returned October sales data.", **last).model_dump(mode="json")
    return artifact, calls


class LearningState(TypedDict, total=False):
    feature: str
    question: str
    route: str
    result: dict
    validated: dict
    tool_calls: list
    started: float


def node_start(name, state):
    emit({"type": "graph_node", "node": name, "state": "start", "component": "StateGraph", "input": {"feature": state["feature"], "question": state["question"]}})


def node_end(name):
    emit({"type": "graph_node", "node": name, "state": "end", "component": "StateGraph"})


async def classify_node(state):
    node_start("classify", state)
    emit({"type": "scope_start", "model": MODEL})
    route = await classify_scope(state["question"], [])
    emit({"type": "scope_result", "route": route})
    node_end("classify")
    return {"route": route}


def choose_path(state):
    target = state["feature"] if state["route"] in {"shop", "chart"} else "guidance"
    emit({"type": "graph_route", "from": "classify", "to": target, "reason": state["route"]})
    return target


async def report_node(state):
    node_start("report", state)
    require_october(state["question"])
    emit({"type": "chain_step", "name": "October report", "component": "RunnableSequence", "state": "start"})
    result = await build_report_chain().ainvoke({"question": state["question"]})
    emit({"type": "chain_step", "name": "October report", "component": "RunnableSequence", "state": "end"})
    node_end("report")
    return {"result": result, "tool_calls": []}


async def sql_node(state):
    node_start("sql", state)
    result, calls = await run_data_agent("sql", state["question"])
    node_end("sql")
    return {"result": result, "tool_calls": calls}


async def chart_node(state):
    node_start("chart", state)
    require_october(state["question"])
    result, calls = await run_data_agent("chart", state["question"])
    node_end("chart")
    return {"result": result, "tool_calls": calls}


def guidance_node(state):
    node_start("guidance", state)
    reason = state["route"] if state["route"] in {"outside_scope", "unsupported_action", "chart_clarification"} else "capabilities"
    result = {"kind": "guidance", **{key: value for key, value in redirect_to_shop(reason).items() if key != "reason"}}
    node_end("guidance")
    return {"result": result, "tool_calls": []}


def validate_node(state):
    node_start("validate", state)
    try:
        validated = RESULT_ADAPTER.validate_python(state["result"]).model_dump(mode="json")
    except ValidationError as error:
        emit({"type": "validation", "name": "LearningResult", "valid": False, "errors": error.errors(include_input=False, include_context=False)})
        raise ValueError("The result did not pass validation and was not displayed.") from error
    emit({"type": "validation", "name": "LearningResult", "valid": True, "input": state["result"], "output": validated, "schema": RESULT_ADAPTER.json_schema()})
    node_end("validate")
    return {"validated": validated}


def respond_node(state):
    node_start("respond", state)
    result = state["validated"]
    reply = result["narrative"]["summary"] if result["kind"] == "report" else result.get("answer", result.get("reply", ""))
    node_end("respond")
    emit({"type": "answer", "reply": reply, "artifact": result, "feature": state["feature"], "model": MODEL, "tool_calls": state.get("tool_calls", []), "duration_seconds": round(time.monotonic() - state["started"], 1)})
    return {}


@lru_cache(maxsize=1)
def learning_graph():
    builder = StateGraph(LearningState)
    for name, function in {"classify": classify_node, "report": report_node, "sql": sql_node, "chart": chart_node, "guidance": guidance_node, "validate": validate_node, "respond": respond_node}.items():
        builder.add_node(name, function)
    builder.add_edge(START, "classify")
    builder.add_conditional_edges("classify", choose_path, {name: name for name in ["report", "sql", "chart", "guidance"]})
    for name in ["report", "sql", "chart", "guidance"]:
        builder.add_edge(name, "validate")
    builder.add_edge("validate", "respond")
    builder.add_edge("respond", END)
    return builder.compile()


async def stream_learning(feature: str, question: str):
    async for event in learning_graph().astream({"feature": feature, "question": question, "started": time.monotonic()}, stream_mode="custom"):
        yield event


def learning_definition():
    graph = learning_graph().get_graph()
    return {
        "features": FEATURES,
        "model_settings": {"model": MODEL, "runner": "Ollama", "framework": "LangChain + LangGraph", "model_url": OLLAMA_URL, "context_tokens": MODEL_CONTEXT, "max_output_tokens": LEARNING_OUTPUT_TOKENS, "temperature": 0},
        "system_prompts": {"report": REPORT_PROMPT, "sql": SQL_PROMPT, "chart": PANDAS_PROMPT},
        "graph": {"nodes": list(graph.nodes), "edges": [{"source": edge.source, "target": edge.target, "conditional": edge.conditional} for edge in graph.edges]},
        "result_schema": RESULT_ADAPTER.json_schema(),
        "tools": {feature: [{"name": registered.name, "description": registered.description, "input_schema": registered.args_schema.model_json_schema(), "source_files": [".runtime/shop.sqlite"] if feature == "sql" else ["data/sales.csv", "data/products.csv"], "type": "Python function"} for registered in [_business_tool(function) for function in functions]] for feature, functions in DATA_TOOLS.items()},
    }
