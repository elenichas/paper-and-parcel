#!/bin/sh
# One command starts the app and starts Ollama too if it is not already running.
set -eu
task_project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$task_project_dir"
exec .venv/bin/python -m shop.run
