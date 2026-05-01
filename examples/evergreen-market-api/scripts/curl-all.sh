#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
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

  local -a args=(-sS -D "$HEADERS_FILE" -o "$BODY_FILE" -w "%{http_code}")

  if [[ "$method" == "HEAD" ]]; then
    args+=(-I)
  else
    args+=(-X "$method")
    if [[ -n "$body" ]]; then
      args+=(--data-raw "$body")
    fi
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

header_value() {
  local name
  name="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  awk -F':' -v wanted="$name" '
    tolower($1) == wanted {
      value = $0
      sub(/^[^:]*:[[:space:]]*/, "", value)
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' "$HEADERS_FILE"
}

expect_header_contains() {
  local name="$1"
  local needle="$2"
  local label="$3"
  local value
  value="$(header_value "$name")"
  [[ "$value" == *"$needle"* ]] || fail "$label expected header $name to contain $needle"
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
} catch (error) {
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
    if curl -fsS "$BASE_URL/api/built-ins/config" >/dev/null 2>&1; then
      pass "server is reachable"
      return
    fi
    sleep 0.5
  done
  fail "server did not become reachable at $BASE_URL"
}

wait_for_server

unique_suffix="$(date +%s)-$$"
created_name="curl mug $unique_suffix"
created_event_id="$((RANDOM + 1000))"
throttle_client="curl-client-$unique_suffix"

request GET "/api/v1/catalog/items?tag=office" ""
expect_status 200 "catalog list by tag"
expect_json 'Array.isArray(data) && data.some((item) => item.name === "Notebook" && item.secret === "margin:high")' "catalog list returns product internals"

request GET "/api/v1/catalog/items/1" ""
expect_status 200 "catalog read v1"
expect_json 'data.id === 1 && data.name === "Notebook" && data.secret === undefined' "catalog read v1 serializes public product"

request GET "/api/v2/catalog/items/1" ""
expect_status 200 "catalog read v2"
expect_json 'data.version === 2 && data.product.id === 1' "catalog read v2 versioned route"

request POST "/api/v1/catalog/items" '{"name":"blocked","price":10}' -H 'content-type: application/json'
expect_status 403 "catalog create rejects missing API key"

request POST "/api/v1/catalog/items" "{\"name\":\"$created_name\",\"price\":18,\"tags\":[\"kitchen\"]}" \
  -H 'content-type: application/json' \
  -H 'x-api-key: secret'
expect_status 201 "catalog create accepts API key"
expect_json 'data.name.startsWith("CURL MUG") && data.price === 18 && data.tags.includes("kitchen")' "catalog create validates and transforms body"
created_id="$(json_value 'data.id')"

request PUT "/api/v1/catalog/items/$created_id" '{"name":"replacement","price":22,"tags":["desk"]}' \
  -H 'content-type: application/json' \
  -H 'x-api-key: secret'
expect_status 200 "catalog replace"
expect_json 'data.id > 0 && data.name === "replacement" && data.tags.includes("desk")' "catalog replace body"

request PATCH "/api/v1/catalog/items/$created_id" '{"price":23}' \
  -H 'content-type: application/json' \
  -H 'x-api-key: secret'
expect_status 200 "catalog patch"
expect_json 'data.price === 23' "catalog patch body"

request HEAD "/api/v1/catalog/items/1" ""
expect_status 200 "catalog head"

request OPTIONS "/api/v1/catalog/items" ""
expect_status 204 "catalog options or CORS preflight"

request PATCH "/api/v1/catalog/echo-method" ""
expect_status 200 "catalog all route with PATCH"
expect_json 'data.method === "PATCH"' "catalog all route reports method"

request GET "/api/v1/catalog/redirect" ""
expect_status 302 "catalog redirect status"
expect_header_contains "location" "/api/v1/catalog/items" "catalog redirect location"

request GET "/api/v1/catalog/scoped" ""
expect_status 403 "catalog scoped route rejects missing scope"

request GET "/api/v1/catalog/scoped" "" -H 'x-scope: catalog:read'
expect_status 200 "catalog scoped route accepts scope"
expect_header_contains "x-required-scope" "catalog:read" "catalog scoped route metadata header"

request DELETE "/api/v1/catalog/items/$created_id" "" -H 'x-api-key: secret'
expect_status 204 "catalog delete"

request GET "/api/v1/catalog/items/$created_id" ""
expect_status 404 "catalog deleted item is gone"

uuid="550e8400-e29b-41d4-a716-446655440000"
request GET "/api/surface/params/7/$uuid?price=19.5&active=true&tags=a%7Cb&mode=public&required=yes" "" \
  -H 'cookie: session=abc; theme=dark' \
  -H 'cf-connecting-ip: 203.0.113.10' \
  -H 'x-request-id: req-1' \
  -H 'x-user-id: user-1'
expect_status 200 "surface params"
expect_json 'data.id === 7 && data.uuid === "550e8400-e29b-41d4-a716-446655440000" && data.price === 19.5 && data.active === true && data.tags.join(",") === "a,b" && data.mode === "public" && data.session === "abc" && data.cookies.theme === "dark" && data.ip === "203.0.113.10" && data.userId === "user-1"' "surface params body"

request GET "/api/surface/params/7/$uuid?price=x&tags=a&mode=public" ""
expect_status 400 "surface params invalid pipe"

request POST "/api/surface/body-field" '{"name":"Ada","role":"admin"}' -H 'content-type: application/json'
expect_status 200 "surface body field"
expect_json 'data.name === "Ada" && data.body.role === "admin"' "surface body field body"

request POST "/api/surface/raw" "raw-payload"
expect_status 200 "surface raw body"
expect_json 'data.byteLength === 11 && data.text === "raw-payload"' "surface raw body response"

request GET "/api/surface/response" ""
expect_status 200 "surface response decorator"
expect_header_contains "x-response-param" "set" "surface response header"

request GET "/api/surface/text" ""
expect_status 200 "surface text"
expect_body_contains "plain text response" "surface text body"

request GET "/api/surface/events" ""
expect_status 200 "surface sse"
expect_header_contains "content-type" "text/event-stream" "surface sse content type"
expect_body_contains "data: example" "surface sse body"

request GET "/api/pipeline/secure" ""
expect_status 200 "pipeline guard denied through controller filter"
expect_json 'data.filteredBy === "client-error-filter" && data.status === 403' "pipeline guard denied body"

request GET "/api/pipeline/secure" "" -H 'x-api-key: secret'
expect_status 200 "pipeline guard allowed"
expect_header_contains "x-app-interceptor" "yes" "pipeline app interceptor header"
expect_json 'data.data.ok === true' "pipeline interceptor envelope"

request GET "/api/pipeline/app-filter" ""
expect_status 200 "pipeline global filter"
expect_json 'data.filteredBy === "app-filter" && data.message === "handled globally"' "pipeline global filter body"

request GET "/api/surface/text" "" -H 'x-blocked: true'
expect_status 403 "pipeline global guard blocks request"

request GET "/api/pipeline/method-middleware" ""
expect_status 200 "pipeline method middleware"
expect_header_contains "x-route-middleware" "yes" "pipeline method middleware header"

request GET "/api/middleware" ""
expect_status 200 "consumer middleware route"
expect_header_contains "x-consumer-middleware" "yes" "consumer middleware header"
expect_header_contains "x-app-middleware" "yes" "app middleware header"

request GET "/api/built-ins/config" "" -H 'origin: https://example.test'
expect_status 200 "built-ins config with CORS"
expect_header_contains "access-control-allow-origin" "https://example.test" "CORS allow origin"
expect_json 'data.name === "evergreen-market" && data.nested === true && data.fallback === "fallback"' "built-ins config body"

request GET "/api/built-ins/manual-cache" ""
expect_status 200 "manual cache first call"
manual_first="$(json_value 'data.count')"
request GET "/api/built-ins/manual-cache" ""
expect_status 200 "manual cache second call"
manual_second="$(json_value 'data.count')"
[[ "$manual_second" -eq "$((manual_first + 1))" ]] || fail "manual cache should increment"
pass "manual cache increments"

request GET "/api/built-ins/cached" ""
expect_status 200 "cache interceptor first call"
cached_first="$(json_value 'data.count')"
request GET "/api/built-ins/cached" ""
expect_status 200 "cache interceptor second call"
cached_second="$(json_value 'data.count')"
[[ "$cached_first" == "$cached_second" ]] || fail "cache interceptor should reuse cached response"
pass "cache interceptor reuses response"

request POST "/api/built-ins/events" "{\"id\":$created_event_id,\"name\":\"Curl Event\"}" -H 'content-type: application/json'
expect_status 200 "event emitter post"
request GET "/api/built-ins/event-log" ""
expect_status 200 "event emitter log"
expect_json "data.events.some((event) => event.id === $created_event_id && event.name === \"Curl Event\")" "event emitter recorded event"

request GET "/api/built-ins/schedule" ""
expect_status 200 "schedule registry"
expect_json 'data.cron.includes("hourly") && data.interval.includes("poll")' "schedule registry body"

request GET "/api/built-ins/health" ""
expect_status 200 "health check"
expect_json 'data.status === "ok" && data.info.app.status === "up"' "health check body"

request GET "/api/built-ins/http" ""
expect_status 200 "http client"
expect_json 'data.status === 200 && data.data.ok === true' "http client body"

request GET "/api/built-ins/request-scope" ""
expect_status 200 "request scope first call"
marker_one="$(header_value "x-request-marker")"
request GET "/api/built-ins/request-scope" ""
expect_status 200 "request scope second call"
marker_two="$(header_value "x-request-marker")"
[[ -n "$marker_one" && -n "$marker_two" && "$marker_one" != "$marker_two" ]] || fail "request-scoped guard should create a new marker per request"
pass "request scope creates new marker per request"

request GET "/api/built-ins/optional" ""
expect_status 200 "optional provider"
expect_json 'data.optional === null' "optional provider body"

request GET "/api/built-ins/lifecycle" ""
expect_status 200 "lifecycle endpoint"
expect_json 'data.events.includes("module-init") && data.events.includes("app-bootstrap")' "lifecycle endpoint body"

request GET "/api/built-ins/audit" ""
expect_status 200 "audit endpoint"
expect_json 'Array.isArray(data.auditLog) && data.auditLog.length > 0' "audit endpoint body"

request GET "/api/built-ins/throttled" "" -H "x-test-client: $throttle_client"
expect_status 200 "throttled first request"
expect_header_contains "x-ratelimit-limit" "1" "throttled limit header"
request GET "/api/built-ins/throttled" "" -H "x-test-client: $throttle_client"
expect_status 429 "throttled second request"
expect_header_contains "retry-after" "" "throttled retry header exists"

request GET "/api/built-ins/unthrottled" ""
expect_status 200 "skip throttler first request"
request GET "/api/built-ins/unthrottled" ""
expect_status 200 "skip throttler second request"

request GET "/openapi.json" ""
expect_status 200 "openapi document"
expect_json 'data.openapi === "3.1.0" && data.info.title === "Evergreen Market API" && data.paths["/api/catalog/items"] !== undefined' "openapi document body"

printf '\nAll curl checks passed against %s\n' "$BASE_URL"
