"""Run the real agent from the terminal: python -m shop.demo_agent [question]."""

import argparse
import asyncio
import json

from shop.agent import stream_answer


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("question", nargs="?", default="What was our October profit?")
    question = parser.parse_args().question
    print(f"You: {question}", flush=True)
    async for event in stream_answer(question):
        if event["type"] == "tool_start":
            print(f"Calling {event['name']}({json.dumps(event['args'])})", flush=True)
        elif event["type"] == "tool_result":
            print(f"Result: {json.dumps(event['result'])}", flush=True)
        elif event["type"] == "answer":
            print(f"Assistant: {event['reply']}", flush=True)
            print(f"Completed in {event['duration_seconds']}s", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
