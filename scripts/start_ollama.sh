#!/bin/sh
# Start our local model server. Keep this running while using the demo.
set -eu

export OLLAMA_NO_CLOUD=1
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_CONTEXT_LENGTH=4096
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_MAX_LOADED_MODELS=1

exec ollama serve
