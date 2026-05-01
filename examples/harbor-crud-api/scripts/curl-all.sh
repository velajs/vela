#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8788}"
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

json_value() {
  local expression="$1"
  node - "$expression" "$BODY_FILE" <<'NODE'
const fs = require('node:fs');
const [expression, file] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const value = Function('data', `return (${expression});`)(data);
process.stdout.write(String(value));
NODE
}

wait_for_server() {
  printf 'waiting for %s ...\n' "$BASE_URL"
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE_URL/api/meta/container-resource" >/dev/null 2>&1; then
      pass "server is reachable"
      return
    fi
    sleep 0.5
  done
  fail "server did not become reachable at $BASE_URL"
}

wait_for_server

unique_suffix="$(date +%s)-$$"
container_code="curl-$unique_suffix"

request GET "/api/containers/dashboard" "" -H 'x-harbor-key: harbor-secret'
expect_status 200 "controller route with class guard"
expect_json 'data.resource === "containers" && data.endpoints.includes("delete")' "dashboard body"

request POST "/api/containers" '{"code":"blocked","status":"arrived","terminal":"north","weightTons":8}' \
  -H 'content-type: application/json'
expect_status 403 "@Crud guard rejects missing key"

request POST "/api/containers" '{"code":"x","status":"arrived","terminal":"north","weightTons":-1}' \
  -H 'content-type: application/json' \
  -H 'x-harbor-key: harbor-secret'
expect_status 400 "dto.create rejects invalid payload"

request POST "/api/containers" "{\"code\":\"$container_code\",\"status\":\"arrived\",\"terminal\":\"north\",\"weightTons\":8}" \
  -H 'content-type: application/json' \
  -H 'x-harbor-key: harbor-secret'
expect_status 201 "@Crud create"
expect_json 'data.result.code === data.result.code.toUpperCase() && data.result.status === "arrived" && typeof data.result.id === "string"' "beforeCreate hook transforms code"
container_id="$(json_value 'data.result.id')"
container_code_upper="$(json_value 'data.result.code')"

request GET "/api/containers" "" -H 'x-harbor-key: harbor-secret'
expect_status 200 "@Crud list"
expect_json "Array.isArray(data.result) && data.result.some((item) => item.id === '$container_id' && item.code === '$container_code_upper' && item.inspected === true)" "afterList hook annotates results"

request GET "/api/containers/$container_id" "" -H 'x-harbor-key: harbor-secret'
expect_status 200 "@Crud read"
expect_json "data.result.id === '$container_id' && data.result.code === '$container_code_upper'" "read body"

request PATCH "/api/containers/$container_id" '{"terminal":"south"}' \
  -H 'content-type: application/json' \
  -H 'x-harbor-key: harbor-secret'
expect_status 400 "dto.update is not automatically partial"

request PATCH "/api/containers/$container_id" '{"status":"loaded","terminal":"south","weightTons":9}' \
  -H 'content-type: application/json' \
  -H 'x-harbor-key: harbor-secret'
expect_status 200 "@Crud update"
expect_json 'data.result.status === "loaded" && data.result.terminal === "south" && data.result.weightTons === 9' "update body"

request GET "/api/container-reports?terminal=south" ""
expect_status 200 "@Override list route"
expect_json 'data.override === true && data.terminal === "south" && Array.isArray(data.result)' "override body"

request GET "/api/meta/container-resource" ""
expect_status 200 "CrudService injection route"
expect_json 'data.hasMeta === true && data.hasAdapters === true' "CrudService exposes meta and adapters"

request POST "/api/berths" '{"name":"Pier 4","vessel":"MV Cypress"}' \
  -H 'content-type: application/json'
expect_status 403 "CrudModule.forResource guard rejects missing key"

request POST "/api/berths" '{"name":"Pier 4","vessel":"MV Cypress"}' \
  -H 'content-type: application/json' \
  -H 'x-harbor-key: harbor-secret'
expect_status 201 "CrudModule.forResource create"
expect_json 'data.result.name === "Pier 4" && data.result.vessel === "MV Cypress"' "berth create body"

request GET "/api/berths" "" -H 'x-harbor-key: harbor-secret'
expect_status 200 "CrudModule.forResource list"
expect_json 'Array.isArray(data.result) && data.result.some((item) => item.name === "Pier 4")' "berth list body"

request DELETE "/api/berths/not-registered" "" -H 'x-harbor-key: harbor-secret'
expect_status 404 "CrudModule.forResource only excludes delete"

request DELETE "/api/containers/$container_id" "" -H 'x-harbor-key: harbor-secret'
expect_status 200 "@Crud delete"

request GET "/api/containers/$container_id" "" -H 'x-harbor-key: harbor-secret'
expect_status 404 "deleted container is gone"

printf 'all harbor CRUD curl checks passed\n'
