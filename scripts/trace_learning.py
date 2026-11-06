"""Run a learning workflow with its real observable events printed as JSON."""

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shop.learning import stream_learning


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("feature", choices=["report", "sql", "chart"])
    parser.add_argument("question")
    args = parser.parse_args()
    async for event in stream_learning(args.feature, args.question):
        print(json.dumps(event, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
