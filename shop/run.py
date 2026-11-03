"""Start the local model if needed, then serve Paper & Parcel."""

import json
import shutil
import subprocess
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import uvicorn


ROOT = Path(__file__).resolve().parents[1]
MODEL = "qwen3:4b-instruct"


def model_names():
    with urlopen("http://127.0.0.1:11434/api/tags", timeout=2) as response:
        return [item["name"] for item in json.load(response).get("models", [])]


def main():
    owned_model = None
    log = None
    try:
        try:
            models = model_names()
        except (URLError, TimeoutError):
            if not shutil.which("ollama"):
                raise SystemExit("Ollama is missing. Install it with: brew install ollama")
            runtime = ROOT / ".runtime"
            runtime.mkdir(exist_ok=True)
            log = (runtime / "ollama.log").open("a", encoding="utf-8")
            print("Starting local Ollama. Log: .runtime/ollama.log", flush=True)
            owned_model = subprocess.Popen(
                ["sh", str(ROOT / "scripts/start_ollama.sh")], stdout=log, stderr=log,
            )
            for _ in range(30):
                if owned_model.poll() is not None:
                    raise SystemExit("Ollama could not start. See .runtime/ollama.log.")
                try:
                    models = model_names()
                    break
                except (URLError, TimeoutError):
                    time.sleep(0.5)
            else:
                raise SystemExit("Ollama did not become ready. See .runtime/ollama.log.")
        if MODEL not in models:
            print(f"Downloading {MODEL} (about 2.5 GB on first use)…", flush=True)
            subprocess.run(["ollama", "pull", MODEL], check=True)
        print("\nPaper & Parcel: http://127.0.0.1:8000\nPress Ctrl+C to stop the app.\n", flush=True)
        uvicorn.run("shop.server:app", host="127.0.0.1", port=8000, log_level="info")
    finally:
        if owned_model is not None and owned_model.poll() is None:
            owned_model.terminate()
            try:
                owned_model.wait(timeout=10)
            except subprocess.TimeoutExpired:
                owned_model.kill()
                owned_model.wait()
        if log:
            log.close()


if __name__ == "__main__":
    main()
