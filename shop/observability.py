"""The same observable events go to the terminal, a local JSONL file, and the UI."""

import json
import logging
import os
from functools import lru_cache
from logging.handlers import RotatingFileHandler
from pathlib import Path


@lru_cache(maxsize=1)
def trace_logger():
    logger = logging.getLogger("paperparcel.trace")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        console = logging.StreamHandler()
        console.setFormatter(logging.Formatter("[shop trace] %(message)s"))
        logger.addHandler(console)
        directory = Path(__file__).resolve().parents[1] / ".runtime"
        directory.mkdir(exist_ok=True)
        file = RotatingFileHandler(directory / "events.jsonl", maxBytes=2_000_000, backupCount=2, encoding="utf-8")
        file.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(file)
    return logger


def log_event(event: dict):
    if os.environ.get("SHOP_TRACE", "1") != "0":
        trace_logger().info(json.dumps(event, ensure_ascii=False, default=str))
