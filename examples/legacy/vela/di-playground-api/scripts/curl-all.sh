#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8789}"
TMP_DIR="$(mktemp -d)"
BODY_FILE="$TMP_DIR/body"
HEADERS_FILE="$TMP_DIR/headers"
STATUS=""

trap 'rm -rf "$TMP_DIR"' EXIT

pass() {
  printf 'ok - %s\n' "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  printf 'last status: %s\n' "$STATUS" >&2
  printf 'last headers:\n' >&2
  sed 's/^/  /' "$HEADERS_FILE" >&2 || true
  printf 'last body:\n' >&2
  sed 's/^/  /' "$BODY_FILE" >&2 || true
  exit 1
}

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  shift 3 || true

  : > "$BODY_FILE"
  : > "$HEADERS_FILE"

  local -a args=(-sS -D "$HEADERS_FILE" -o "$BODY_FILE" -w "%{http_code}" -X "$method")
  if [[ -n "$body" ]]; then
    args+=(--data-raw "$body")
  fi
  args+=("$@")

  STATUS="$(curl "${args[@]}" "$BASE_URL$path")"
}

expect_status() {
  local expected="$1"
  local label="$2"
  [[ "$STATUS" == "$expected" ]] || fail "$label expected HTTP $expected"
  pass "$label"
}

expect_body_contains() {
  local needle="$1"
  local label="$2"
  grep -Fq "$needle" "$BODY_FILE" || fail "$label expected body to contain $needle"
  pass "$label"
}

expect_json() {
  local expression="$1"
  local label="$2"
  node - "$expression" "$BODY_FILE" <<'NODE'
const fs = require('node:fs');
const [expression, file] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
let data;
try {
  data = JSON.parse(text);
} catch {
  console.error(`Body is not JSON: ${text}`);
  process.exit(1);
}

let ok = false;
try {
  ok = Boolean(Function('data', `return (${expression});`)(data));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (!ok) {
  console.error(`Expression failed: ${expression}`);
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}
NODE
  pass "$label"
}

wait_for_server() {
  printf 'waiting for %s ...\n' "$BASE_URL"
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE_URL/api/playground/global" >/dev/null 2>&1; then
      pass "server is reachable"
      return
    fi
    sleep 0.5
  done
  fail "server did not become reachable at $BASE_URL"
}

wait_for_server

request GET "/api/playground/global" ""
expect_status 200 "@Global module"
expect_json 'data.message === "global-ready"' "global body"

request GET "/api/playground/dynamic" ""
expect_status 200 "dynamic module"
expect_json 'data.audit === "dynamic-audit-ready"' "dynamic body"

request GET "/api/playground/forward-ref" ""
expect_status 200 "ForwardRef and forwardRef"
expect_json 'data.provider === "alpha:beta:alpha-linked" && data.module.a === "from-module-a" && data.module.b === "from-module-b" && data.manual === true' "forward ref body"

request GET "/api/playground/module-ref" ""
expect_status 200 "ModuleRef"
expect_json 'data.singletonCount === 3 && data.sameSingleton === true && data.freshCount === 1 && data.freshIsSingleton === false' "ModuleRef body"

request GET "/api/playground/container" ""
expect_status 200 "Container direct usage"
expect_json 'data.ping === "sandbox-tool-ready"' "Container body"

request GET "/api/playground/mixin/admin" ""
expect_status 403 "mixin guard rejects wrong role"

request GET "/api/playground/mixin/admin" "" -H 'x-role: admin'
expect_status 200 "mixin guard accepts admin"
expect_json 'data.role === "admin"' "mixin admin body"

request GET "/api/playground/mixin/maintainer" "" -H 'x-role: maintainer'
expect_status 200 "second mixin guard accepts maintainer"

request POST "/api/playground/zod" '{"name":"probe-a","count":2}' -H 'content-type: application/json'
expect_status 200 "ZodValidationPipe"
expect_json 'data.parsed.name === "probe-a" && data.parsed.count === 2' "Zod body"

request GET "/api/playground/runtime" ""
expect_status 200 "Hono adapter helpers"
expect_json 'data.runtime === "node" && data.hasEnvironment === true' "runtime body"

request GET "/api/playground/logger" ""
expect_status 200 "Logger"
expect_json 'data.logLevel === 2 && data.captured === 1 && data.hasContext === true' "logger body"

request GET "/api/playground/stream" ""
expect_status 200 "streaming subpath"
expect_body_contains $'alpha\nomega' "stream body"

printf 'all DI playground curl checks passed\n'
