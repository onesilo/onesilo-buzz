#!/usr/bin/env bash
#
# Build a real onesilo-node, run it, drive the real agent at it, tear it down.
#
# The node is configured memory-only: compute off, LAN off, no tunnel. That
# keeps the test hermetic (no Ollama, no model pull, no network) and means a
# failure is a memory-contract failure rather than an environment one. The
# node still listens on the LAN port because the memory API rides it — that is
# the node's documented behaviour when capabilities.memory is on, not a
# misconfiguration here.
#
# Everything lives in a temp dir that is removed on exit, so the test never
# touches ~/.onesilo-node.
#
#   NODE_REPO=../onesilo-node ./scripts/e2e.sh
#
set -euo pipefail

NODE_REPO="${NODE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../onesilo-node" 2>/dev/null && pwd || true)}"
MEM_PORT="${MEM_PORT:-8765}"
ADMIN_PORT="${ADMIN_PORT:-8766}"

if [ -z "$NODE_REPO" ] || [ ! -d "$NODE_REPO" ]; then
  echo "onesilo-node checkout not found. Set NODE_REPO=/path/to/onesilo-node" >&2
  exit 2
fi

# Explicit template: a bare `mktemp -d` is a GNU extension and fails on
# BSD/macOS, which is where most of this gets developed.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/onesilo-e2e.XXXXXX")"
NODE_PID=""

cleanup() {
  if [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    # Kill the process group, not just the node. The node supervises
    # children (it can run `ollama serve` itself), and killing only the
    # parent orphans them — they keep the port bound, so the next run fails
    # to start for a reason that has nothing to do with the next run.
    # Falls back to the bare pid if the group is unavailable.
    kill -- "-$NODE_PID" 2>/dev/null || kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> building onesilo-node ($NODE_REPO)"
( cd "$NODE_REPO" && make build >/dev/null )
NODE_BIN="$NODE_REPO/bin/onesilo-node"
"$NODE_BIN" -version

mkdir -p "$WORK/data"
cat > "$WORK/config.toml" <<TOML
mode = "local"
data_dir = "$WORK/data"

[capabilities]
compute = false
memory = true

[lan]
enabled = false
port = $MEM_PORT

[tunnel]
mode = "off"

[admin]
port = $ADMIN_PORT
TOML

echo "==> starting node"
# Own process group so cleanup can take the whole tree down. setsid where
# available; without it the kill falls back to the single pid.
if command -v setsid >/dev/null 2>&1; then
  setsid "$NODE_BIN" -config "$WORK/config.toml" > "$WORK/node.log" 2>&1 &
else
  "$NODE_BIN" -config "$WORK/config.toml" > "$WORK/node.log" 2>&1 &
fi
NODE_PID=$!

# Wait for readiness rather than sleeping a guessed interval: a slow start
# would otherwise read as a memory failure.
for i in $(seq 1 50); do
  if curl -fsS -m 1 "http://127.0.0.1:$MEM_PORT/healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "node exited during startup:" >&2; cat "$WORK/node.log" >&2; exit 1
  fi
  sleep 0.2
done
if ! curl -fsS -m 1 "http://127.0.0.1:$MEM_PORT/healthz" >/dev/null 2>&1; then
  echo "node never became healthy:" >&2; cat "$WORK/node.log" >&2; exit 1
fi

# The node mints this on first run; the memory API authenticates with it.
NODE_KEY="$(cat "$WORK/data/node.key")"
echo "==> node up on :$MEM_PORT"

set +e
NODE_URL="http://127.0.0.1:$MEM_PORT" NODE_KEY="$NODE_KEY" \
  npx tsx e2e/buzz-node.e2e.ts
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  echo
  echo "==> node log (last 40 lines)"
  tail -40 "$WORK/node.log"
fi

exit $STATUS
