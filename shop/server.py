"""FastAPI backend and local web app. Run with: python -m shop.server."""

import asyncio
import csv
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from shop.agent import MODEL, OLLAMA_URL, AgentAnswerError, agent_definition, stream_answer
from shop.learning import learning_definition, stream_learning
from shop.observability import log_event
from shop.tools import (
    DATA_DIR, get_profit_summary, get_sales_summary, get_stock_status, get_unpaid_invoices,
)


ROOT = Path(__file__).resolve().parents[1]
app = FastAPI(title="Paper & Parcel", description="A local LangChain business assistant.")
app.mount("/static", StaticFiles(directory=ROOT / "web"), name="static")
model_lock = asyncio.Semaphore(1)
logger = logging.getLogger(__name__)


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=6)

    @field_validator("message")
    @classmethod
    def nonblank_message(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Please enter a question.")
        return value


class LearningRequest(ChatRequest):
    feature: Literal["report", "sql", "chart"]


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(ROOT / "web" / "index.html")


@app.get("/api/dashboard")
def dashboard():
    sales = get_sales_summary()
    products = {row["product_id"]: row["name"] for row in sales["products"]}
    with (DATA_DIR / "sales.csv").open(newline="", encoding="utf-8") as file:
        records = list(csv.DictReader(file))
    for row in records:
        row["product_name"] = products[row["product_id"]]
        row["quantity"] = int(row["quantity"])
    return {
        "shop_name": "Paper & Parcel", "month": "2026-10",
        "demo_date": "2026-11-03", "sales": sales,
        "profit": get_profit_summary(), "invoices": get_unpaid_invoices(),
        "stock": get_stock_status(), "sale_records": records,
    }


@app.get("/api/agent")
def agent_setup():
    """Learning view: the app's actual model settings, instructions, and tool schemas."""
    return {**agent_definition(), "learning": learning_definition()}


@app.get("/api/learning/definition")
def learning_setup():
    return learning_definition()


@app.get("/api/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
            response = await client.get(f"{OLLAMA_URL}/api/tags")
            response.raise_for_status()
        models = [row["name"] for row in response.json().get("models", [])]
        ready = MODEL in models
        return {
            "status": "ready" if ready else "model_missing", "model": MODEL,
            "local": True, "message": "Local model ready" if ready else f"Run ollama pull {MODEL}",
        }
    except (httpx.HTTPError, ValueError):
        return {
            "status": "offline", "model": MODEL, "local": True,
            "message": "Start Ollama with: sh scripts/start_ollama.sh",
        }


def _history(request: ChatRequest) -> list[dict]:
    # Keep context small enough for this Mac; each request owns its own history.
    history = [turn.model_dump() for turn in request.history]
    while sum(len(turn["content"]) for turn in history) > 8000:
        history.pop(0)
    return history


async def _events(request: ChatRequest, endpoint: str = "/api/chat/stream"):
    started = time.monotonic()
    request_id = uuid.uuid4().hex[:12]
    history = _history(request)

    def stamped(event):
        result = {
            **event, "request_id": request_id,
            "elapsed_ms": round((time.monotonic() - started) * 1000, 1),
        }
        log_event(result)
        return result

    yield stamped({
        "type": "request", "method": "POST", "endpoint": endpoint, "model": MODEL,
        "payload": {"message": request.message, "history": history},
    })
    yield stamped({"type": "status", "message": "Thinking about your question…"})
    try:
        async with asyncio.timeout(150):
            if model_lock.locked():
                yield stamped({"type": "status", "phase": "queue", "message": "Waiting for the local model…"})
            async with model_lock:
                async for event in stream_answer(request.message, history):
                    yield stamped(event)
    except (httpx.ConnectError, ConnectionError):
        yield stamped({"type": "error", "message": "The local model is offline. Start Ollama and try again."})
    except TimeoutError:
        yield stamped({"type": "error", "message": "The local model took too long. Try a shorter question."})
    except AgentAnswerError as error:
        yield stamped({"type": "error", "message": str(error)})
    except asyncio.CancelledError:
        stamped({"type": "cancelled", "message": "Client disconnected."})
        raise
    except Exception:
        logger.exception("Agent request failed")
        yield stamped({
            "type": "error",
            "message": "The assistant couldn't finish this request. Try one shorter question, or check that Ollama is running.",
        })


@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest):
    async def encoded_events():
        async for event in _events(request):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    return StreamingResponse(
        encoded_events(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/chat")
async def chat(request: ChatRequest):
    """Non-streaming version, useful for learning and API clients."""
    trace = []
    async for event in _events(request, endpoint="/api/chat"):
        if event["type"] in ("tool_start", "tool_result"):
            trace.append(event)
        elif event["type"] == "answer":
            return {**event, "trace": trace}
        elif event["type"] == "error":
            raise HTTPException(status_code=503, detail=event["message"])
    raise HTTPException(status_code=503, detail="No answer received.")


async def _learning_events(request: LearningRequest):
    started = time.monotonic()
    request_id = uuid.uuid4().hex[:12]

    def stamped(event):
        result = {**event, "request_id": request_id, "elapsed_ms": round((time.monotonic() - started) * 1000, 1)}
        log_event(result)
        return result

    yield stamped({"type": "request", "method": "POST", "endpoint": "/api/learning/stream", "model": MODEL, "feature": request.feature, "payload": {"message": request.message, "feature": request.feature}})
    try:
        async with asyncio.timeout(180):
            if model_lock.locked():
                yield stamped({"type": "status", "phase": "queue", "message": "Waiting for the local model…"})
            async with model_lock:
                async for event in stream_learning(request.feature, request.message):
                    yield stamped(event)
    except asyncio.CancelledError:
        stamped({"type": "cancelled", "message": "Client disconnected."})
        raise
    except (httpx.ConnectError, ConnectionError):
        yield stamped({"type": "error", "message": "The local model is offline. Start Ollama and try again."})
    except TimeoutError:
        yield stamped({"type": "error", "message": "This analysis took too long. Try one shorter question."})
    except ValueError as error:
        yield stamped({"type": "error", "message": str(error)})
    except Exception:
        logger.exception("Learning workflow failed")
        yield stamped({"type": "error", "message": "The analysis could not finish. Check the trace and try an example question."})


@app.post("/api/learning/stream")
async def learning_stream(request: LearningRequest):
    async def encoded_events():
        async for event in _learning_events(request):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    return StreamingResponse(encoded_events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("shop.server:app", host="127.0.0.1", port=8000)
