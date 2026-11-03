"""Step 2: send a message from Python to the AI model running on this Mac."""

import argparse
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MODEL = "qwen3:4b-instruct"
CHAT_URL = "http://127.0.0.1:11434/api/chat"
SYSTEM_PROMPT = (
    "You are the friendly assistant for Paper & Parcel, a fictional online "
    "stationery shop selling notebooks, planners, pens, stickers, and cards. "
    "Keep replies short and clear. You do not have access to the shop's "
    "records or tools yet, so never invent sales, stock, or financial figures."
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "message",
        nargs="?",
        default="Introduce yourself and say what this shop sells in one short sentence.",
    )
    args = parser.parse_args()

    # This JSON is the message we send to Ollama's local HTTP API.
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": args.message},
        ],
        "stream": False,
        "options": {"num_ctx": 4096, "num_predict": 256, "temperature": 0},
        "keep_alive": "5m",
    }
    request = Request(
        CHAT_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    print(f"Local model: {MODEL}", flush=True)
    print(f"You: {args.message}", flush=True)
    try:
        with urlopen(request, timeout=180) as response:
            result = json.load(response)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(f"Ollama returned HTTP {error.code}: {detail}", file=sys.stderr)
        return 1
    except (URLError, TimeoutError) as error:
        print(
            f"Could not reach the local model: {error}. "
            "Start it with: sh scripts/start_ollama.sh",
            file=sys.stderr,
        )
        return 1

    if result.get("done_reason") == "length":
        print("The response reached its token limit before finishing.", file=sys.stderr)
        return 1
    reply = result["message"]["content"].strip()
    if not reply:
        print("The model returned an empty reply.", file=sys.stderr)
        return 1
    print(f"Assistant: {reply}")
    print(f"Request completed in {result['total_duration'] / 1_000_000_000:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
