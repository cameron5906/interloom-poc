#!/bin/sh
# Supervisor for llama-server.
# Polls MODELS_DIR/.interloom/inference.json every 2s.
# On change: kills existing llama-server and restarts with new config.
# If no config file exists yet, waits silently (health endpoint returns 503
# which compose healthcheck will report as unhealthy until model is activated).

set -e

MODELS_DIR="${MODELS_DIR:-/models}"
CONFIG_FILE="${MODELS_DIR}/.interloom/inference.json"
LLAMA_BIN="/app/llama-server"

LLAMA_PID=""
LAST_HASH=""
LAST_MTIME=""

log() {
  echo "[supervisor] $*"
}

# Extract a JSON string field value (portable, no jq required)
json_field() {
  local json="$1"
  local field="$2"
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
}

json_num() {
  local json="$1"
  local field="$2"
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" | head -n1
}

stop_llama() {
  if [ -n "$LLAMA_PID" ]; then
    if kill -0 "$LLAMA_PID" 2>/dev/null; then
      log "Stopping llama-server (pid $LLAMA_PID)"
      kill -TERM "$LLAMA_PID" 2>/dev/null || true
      # Wait up to 10s for graceful stop
      local waited=0
      while kill -0 "$LLAMA_PID" 2>/dev/null && [ $waited -lt 10 ]; do
        sleep 1
        waited=$((waited + 1))
      done
      kill -KILL "$LLAMA_PID" 2>/dev/null || true
    fi
    LLAMA_PID=""
  fi
}

start_llama() {
  local config="$1"
  local model_path
  local ctx
  local ngl
  local mmproj_path

  model_path="$(json_field "$config" "modelPath")"
  ctx="$(json_num "$config" "ctx")"
  ngl="$(json_num "$config" "ngl")"
  mmproj_path="$(json_field "$config" "mmprojPath")"

  ctx="${ctx:-4096}"

  if [ -z "$model_path" ]; then
    log "ERROR: modelPath missing in inference.json"
    return 1
  fi

  if [ ! -f "$model_path" ]; then
    log "ERROR: model file not found: $model_path"
    return 1
  fi

  local args="-m $model_path -c $ctx --host 0.0.0.0 --port 8080 --metrics --jinja"

  # Add GPU layers flag only when ngl is set (CUDA image)
  if [ -n "$ngl" ]; then
    args="$args -ngl $ngl"
  fi

  if [ -n "$mmproj_path" ] && [ -f "$mmproj_path" ]; then
    args="$args --mmproj $mmproj_path"
  fi

  log "Starting llama-server: $LLAMA_BIN $args"
  # shellcheck disable=SC2086
  $LLAMA_BIN $args &
  LLAMA_PID=$!
  log "llama-server started (pid $LLAMA_PID)"
}

get_file_hash() {
  # md5sum is available on alpine
  md5sum "$1" 2>/dev/null | cut -d' ' -f1
}

get_mtime() {
  stat -c '%Y' "$1" 2>/dev/null || echo "0"
}

# Trap signals to ensure clean shutdown
trap 'log "Received shutdown signal"; stop_llama; exit 0' TERM INT

log "Watching ${CONFIG_FILE} for model configuration..."

while true; do
  if [ -f "$CONFIG_FILE" ]; then
    current_mtime="$(get_mtime "$CONFIG_FILE")"
    current_hash="$(get_file_hash "$CONFIG_FILE")"

    if [ "$current_mtime" != "$LAST_MTIME" ] || [ "$current_hash" != "$LAST_HASH" ]; then
      log "Config changed — reloading"
      stop_llama

      config="$(cat "$CONFIG_FILE")"
      if start_llama "$config"; then
        LAST_MTIME="$current_mtime"
        LAST_HASH="$current_hash"
      else
        log "Failed to start llama-server; will retry on next config change"
        LAST_MTIME=""
        LAST_HASH=""
      fi
    fi

    # Restart if llama-server died unexpectedly
    if [ -n "$LLAMA_PID" ] && ! kill -0 "$LLAMA_PID" 2>/dev/null; then
      log "llama-server (pid $LLAMA_PID) exited unexpectedly; will restart on next poll"
      LLAMA_PID=""
      LAST_MTIME=""
      LAST_HASH=""
    fi
  fi

  sleep 2
done
