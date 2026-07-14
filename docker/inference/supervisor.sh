#!/bin/bash
# Supervisor for N llama-server processes.
#
# Watches MODELS_DIR/.interloom/inference.json every 2s. v2 shape:
#   { v: 2, instances: [{id, modelPath, ctx, port, gpus, tensorSplit?, reasoningBudget?,
#                        mmprojPath?, kvCache?, nCpuMoe?}] }
# v1 shape (no "v" key — a single object {modelPath, ctx?, mmprojPath?}) is read-compat:
# wrapped as one instance ("default") on port 8080.
#
# kvCache ("f16"|"q8_0") and nCpuMoe (rig-optimizer plan, CONTRACTS §6/§7) are optional
# per-instance launch flags: kvCache → --cache-type-k/--cache-type-v (+ -fa on for q8_0),
# nCpuMoe → --n-cpu-moe (MoE experts parked in system RAM).
#
# On change: reconciles the running process set against desired instances, diffing by
# FULL identity (id + modelPath + ctx + port + gpus + tensorSplit + reasoningBudget +
# mmprojPath + kvCache + nCpuMoe) — only instances whose definition changed are
# stopped+restarted; unchanged siblings keep running untouched. A crashed instance
# restarts alone on the next poll, independent of file changes.
#
# IL_GPU=1 (baked into the CUDA image only) makes this supervisor add "-ngl 999" plus
# GPU placement flags (CUDA_VISIBLE_DEVICES / --split-mode row --tensor-split) per
# instance; on the CPU image none of that is emitted. `ngl` is never read from
# inference.json — GPU offload is image-decided, per contract.
#
# IL_SUPERVISOR_DRYRUN=1 prints the env + command line that would be launched for each
# instance and spawns a lightweight placeholder process in its place (no real
# llama-server) — used to verify GPU flag emission on hosts without the target GPUs.

set -u

MODELS_DIR="${MODELS_DIR:-/models}"
CONFIG_FILE="${MODELS_DIR}/.interloom/inference.json"
LLAMA_BIN="/app/llama-server"
DRYRUN="${IL_SUPERVISOR_DRYRUN:-0}"
GRACE_SECS=10
POLL_SECS=2
HEARTBEAT_FILE="/tmp/supervisor-heartbeat"

declare -A PID_OF   # instance id -> pid
declare -A SIG_OF   # instance id -> last-applied identity signature (canonical JSON)
declare -A PORT_OF  # instance id -> port (for log messages after removal)

DESIRED_JSON="[]"   # last successfully-applied normalized instance list

log() {
  echo "[supervisor] $*"
}

# Normalize whatever's in the config file (v1 or v2) into a canonical v2 instances
# array, with every field defaulted so downstream comparisons/launches are uniform.
normalize_config() {
  jq -c '
    if (.v // 0) == 2 then
      .instances
    else
      [ {
          id: "default",
          modelPath: .modelPath,
          ctx: (.ctx // 4096),
          port: 8080,
          gpus: [],
          tensorSplit: null,
          reasoningBudget: (.reasoningBudget // null),
          mmprojPath: (.mmprojPath // null),
          kvCache: (.kvCache // null),
          nCpuMoe: (.nCpuMoe // null)
        } ]
    end
    | map({
        id: ((.id // (.port | tostring)) | tostring),
        modelPath: .modelPath,
        ctx: (.ctx // 4096),
        port: (.port // 8080),
        gpus: (.gpus // []),
        tensorSplit: (.tensorSplit // null),
        reasoningBudget: (.reasoningBudget // null),
        mmprojPath: (.mmprojPath // null),
        kvCache: (.kvCache // null),
        nCpuMoe: (.nCpuMoe // null)
      })
  ' <<<"$1"
}

# Build "ENV:<KEY=VAL KEY=VAL>" and "ARGS:<...>" lines for one instance (canonical JSON on stdin).
build_cmd() {
  local inst="$1"
  local modelPath ctx port gpus tensorSplit reasoningBudget mmprojPath kvCache nCpuMoe
  modelPath=$(jq -r '.modelPath' <<<"$inst")
  ctx=$(jq -r '.ctx' <<<"$inst")
  port=$(jq -r '.port' <<<"$inst")
  gpus=$(jq -c '.gpus // []' <<<"$inst")
  tensorSplit=$(jq -c '.tensorSplit // null' <<<"$inst")
  reasoningBudget=$(jq -r '.reasoningBudget // "null"' <<<"$inst")
  mmprojPath=$(jq -r '.mmprojPath // "null"' <<<"$inst")
  kvCache=$(jq -r '.kvCache // "null"' <<<"$inst")
  nCpuMoe=$(jq -r '.nCpuMoe // "null"' <<<"$inst")

  local args="-m $modelPath -c $ctx --host 0.0.0.0 --port $port --metrics --jinja --reasoning-format deepseek"
  local envs=""

  if [ "$mmprojPath" != "null" ] && [ -n "$mmprojPath" ]; then
    args="$args --mmproj $mmprojPath"
  fi

  if [ "$reasoningBudget" = "0" ]; then
    args="$args --reasoning-budget 0"
  fi

  # KV-cache quantization (rig-optimizer plan) — a single precision drives both
  # cache halves; q8_0 needs flash attention (-fa on) to be honored by llama.cpp.
  if [ "$kvCache" != "null" ] && [ -n "$kvCache" ]; then
    args="$args --cache-type-k $kvCache --cache-type-v $kvCache"
    if [ "$kvCache" = "q8_0" ]; then
      args="$args -fa on"
    fi
  fi

  # MoE expert offload to system RAM (rig-optimizer experts_cpu plan).
  if [ "$nCpuMoe" != "null" ] && [ -n "$nCpuMoe" ]; then
    args="$args --n-cpu-moe $nCpuMoe"
  fi

  # GPU placement is entirely image-decided: only emitted when IL_GPU=1 (CUDA image).
  # The CPU image never sees CUDA_VISIBLE_DEVICES / split-mode / -ngl, even if an
  # instance happens to carry a gpus list.
  if [ "${IL_GPU:-0}" = "1" ]; then
    local gpu_count idx idx_csv split_csv
    gpu_count=$(jq 'length' <<<"$gpus")

    if [ "$gpu_count" -eq 1 ]; then
      idx=$(jq -r '.[0]' <<<"$gpus")
      envs="CUDA_VISIBLE_DEVICES=$idx"
    elif [ "$gpu_count" -gt 1 ]; then
      idx_csv=$(jq -r 'join(",")' <<<"$gpus")
      envs="CUDA_VISIBLE_DEVICES=$idx_csv"
      if [ "$tensorSplit" != "null" ]; then
        split_csv=$(jq -r 'join(",")' <<<"$tensorSplit")
      else
        split_csv=$(jq -r '[range(length) | "1"] | join(",")' <<<"$gpus")
      fi
      args="$args --split-mode row --tensor-split $split_csv"
    fi

    args="$args -ngl 999"
  fi

  printf 'ENV:%s\n' "$envs"
  printf 'ARGS:%s\n' "$args"
}

start_instance() {
  local id="$1" inst="$2"
  local built env_line args_line port

  built="$(build_cmd "$inst")"
  env_line="$(printf '%s\n' "$built" | sed -n 's/^ENV://p')"
  args_line="$(printf '%s\n' "$built" | sed -n 's/^ARGS://p')"
  port="$(jq -r '.port' <<<"$inst")"

  if [ "$DRYRUN" = "1" ]; then
    echo "[dryrun] instance '$id': ${env_line:+$env_line }$LLAMA_BIN $args_line"
    # Placeholder process so the reconcile/crash-recovery loop still has a real PID
    # to track, without needing llama-server or a GPU on this host.
    sleep infinity &
    PID_OF[$id]=$!
  else
    log "Starting instance '$id': ${env_line:+$env_line }$LLAMA_BIN $args_line"
    if [ -n "$env_line" ]; then
      # shellcheck disable=SC2086
      env $env_line "$LLAMA_BIN" $args_line &
    else
      # shellcheck disable=SC2086
      "$LLAMA_BIN" $args_line &
    fi
    PID_OF[$id]=$!
    log "Instance '$id' started (pid ${PID_OF[$id]}, port $port)"
  fi

  PORT_OF[$id]="$port"
  SIG_OF[$id]="$(jq -cS . <<<"$inst")"
}

stop_instance() {
  local id="$1"
  local pid="${PID_OF[$id]:-}"

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "Stopping instance '$id' (pid $pid, port ${PORT_OF[$id]:-?})"
    kill -TERM "$pid" 2>/dev/null || true
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$GRACE_SECS" ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      log "Instance '$id' (pid $pid) did not exit in ${GRACE_SECS}s; sending SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi

  unset 'PID_OF[$id]'
  unset 'SIG_OF[$id]'
  unset 'PORT_OF[$id]'
}

stop_all() {
  local id
  for id in "${!PID_OF[@]}"; do
    stop_instance "$id"
  done
}

# Reconcile the running process set against a normalized desired instance array.
# Only instances whose canonical signature changed are stopped+restarted; unmatched
# running instances are stopped; unchanged instances are left untouched.
reconcile() {
  local normalized="$1"
  local count i inst id sig model_path

  count=$(jq 'length' <<<"$normalized")

  for i in $(seq 0 $((count - 1))); do
    inst=$(jq -c ".[$i]" <<<"$normalized")
    id=$(jq -r '.id' <<<"$inst")
    model_path=$(jq -r '.modelPath' <<<"$inst")

    if [ -z "$model_path" ] || [ "$model_path" = "null" ]; then
      log "ERROR: instance '$id' missing modelPath; skipping"
      continue
    fi
    if [ "$DRYRUN" != "1" ] && [ ! -f "$model_path" ]; then
      log "ERROR: instance '$id' model file not found: $model_path; skipping"
      continue
    fi

    sig=$(jq -cS . <<<"$inst")
    if [ "${SIG_OF[$id]:-}" != "$sig" ]; then
      log "Instance '$id' is new or changed; (re)starting"
      [ -n "${PID_OF[$id]:-}" ] && stop_instance "$id"
      start_instance "$id" "$inst"
    fi
  done

  # Stop instances that are no longer in the desired set.
  local existing_id still_desired
  for existing_id in "${!PID_OF[@]}"; do
    still_desired=$(jq --arg id "$existing_id" '[.[] | select(.id == $id)] | length' <<<"$normalized")
    if [ "$still_desired" = "0" ]; then
      log "Instance '$existing_id' removed from config"
      stop_instance "$existing_id"
    fi
  done

  DESIRED_JSON="$normalized"
}

trap 'log "Received shutdown signal"; stop_all; exit 0' TERM INT

log "Watching ${CONFIG_FILE} for model configuration..."
[ "$DRYRUN" = "1" ] && log "IL_SUPERVISOR_DRYRUN=1 — commands will be printed, not executed"

LAST_MTIME=""
LAST_HASH=""

while true; do
  if [ -f "$CONFIG_FILE" ]; then
    current_mtime="$(stat -c '%Y' "$CONFIG_FILE" 2>/dev/null || echo 0)"
    current_hash="$(md5sum "$CONFIG_FILE" 2>/dev/null | cut -d' ' -f1)"

    if [ "$current_mtime" != "$LAST_MTIME" ] || [ "$current_hash" != "$LAST_HASH" ]; then
      log "Config changed — reconciling"
      config_content="$(cat "$CONFIG_FILE")"
      jq_err=""
      if normalized="$(normalize_config "$config_content" 2>/tmp/il-jq-err)"; then
        reconcile "$normalized"
        LAST_MTIME="$current_mtime"
        LAST_HASH="$current_hash"
      else
        log "ERROR: failed to parse ${CONFIG_FILE}: $(cat /tmp/il-jq-err 2>/dev/null)"
      fi
    fi
  fi

  # Crash recovery: restart dead instances alone, independent of file changes.
  for id in "${!PID_OF[@]}"; do
    pid="${PID_OF[$id]}"
    if ! kill -0 "$pid" 2>/dev/null; then
      log "Instance '$id' (pid $pid) exited unexpectedly; restarting alone"
      unset 'PID_OF[$id]'
      inst="$(jq -c --arg id "$id" '.[] | select(.id == $id)' <<<"$DESIRED_JSON")"
      if [ -n "$inst" ]; then
        start_instance "$id" "$inst"
      else
        unset 'SIG_OF[$id]'
        unset 'PORT_OF[$id]'
      fi
    fi
  done

  touch "$HEARTBEAT_FILE" 2>/dev/null || true

  sleep "$POLL_SECS"
done
