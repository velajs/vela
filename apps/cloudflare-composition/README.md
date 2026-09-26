# Native Cloudflare composition

One synthetic Vela app composes Browser Run, Workers AI / AI Gateway, Workers VPC,
and Images with existing DI and native bindings. There are no additional Vela
modules, browser sessions, inference wrappers or Images/VPC adapters. Source starts
at [`src/worker.ts`](src/worker.ts); Wrangler generates the binding declarations.

Each environment has one operator: `DEMO_TOKEN` authenticates all four operations
for the server-configured `DEMO_OWNER`. This deliberately small policy is suitable
for a private synthetic fixture. A real multi-user application must supply verified
identity, membership and per-operation permissions. The token is never forwarded
to Browser Run, the private service, AI, or image metadata.

| Route | Server-owned policy and limits |
| --- | --- |
| `GET /browser/screenshot` or `/browser/pdf` | Only `https://example.com/`; exact request allowlist, documents only, JavaScript disabled, no cookies/headers; 800×600 PNG or one A4 PDF page; 2 MiB output |
| `POST /ai/direct` or `/ai/gateway` | Strict `{ "prompt": "…" }`, 4 KiB wire input / 2,048 characters; fixed model, at most two SDK steps with 256 output tokens per step, zero retries, 32 KiB streamed text |
| `GET /private-item` | Fixed HTTPS Host/SNI/path through one native VPC **Service**; manual redirects, strict JSON schema, 4 KiB response, three-second deadline |
| `GET /images/thumbnail` or `/images/card` | Only `owners/<verified owner>/sample.png` in private R2; 1 MiB input, 512 KiB output; fixed 128×128 or 640×360 WebP choices, quality 75, animation disabled |

Query parameters and extra AI fields are rejected. Clients cannot select a URL,
R2 key, owner, gateway, model, output token budget or transform options. Responses
have `Cache-Control: no-store`. Native binding reachability does not establish
application authorization.

## Run locally

From the repository root, with Node 24+ and pnpm 11.11.0:

```sh
pnpm install --frozen-lockfile
pnpm --filter 'vela-cloudflare-composition^...' build
pnpm --filter vela-cloudflare-composition cf:types
pnpm --filter vela-cloudflare-composition typecheck
pnpm --filter vela-cloudflare-composition test
pnpm --filter vela-cloudflare-composition test:workers
pnpm --filter vela-cloudflare-composition build
```

`test` uses explicit native-binding doubles but the real AI SDK/provider and
HttpService. It covers unauthorized ingress, overlapping AI environments,
parameter limits, redirects, output bounds, stream failures, deadlines, cancellation
and late-response disposal. `test:workers` runs Vela/Oxc DI and request isolation
in workerd, transforms a synthetic PNG through real **local** R2/Images bindings,
and separately exercises Browser/AI/VPC with explicit doubles. Consuming response
bodies in these tests also lets Vela finish request-owned cleanup.

The test plugin sets `remoteBindings: false` and configures only locally emulated
bindings. It does not load remote-only Wrangler AI/VPC bindings. Vite also disables
remote bindings; during `vite dev` it removes Browser/AI/VPC declarations, leaving
local R2 and Images. Copy `.dev.vars.example` to `.dev.vars` and set a fresh token
before running `pnpm --filter vela-cloudflare-composition dev`. No object is seeded
by dev startup, so Images returns 404 until a local owner fixture exists. The native
test seeds and removes its own local fixture. Authenticated Browser/AI/VPC dev routes
are unavailable. Production builds retain all Wrangler declarations; the synthetic
VPC ID and bucket/gateway names are placeholders, not provisioned resources.

Both configs explicitly disable remote connections. Changing a Wrangler binding's
`remote` flag alone does not opt this app into remote development. Use the deployed
fixture acceptance command below when intentionally testing real services.

## Lifetimes and failure behavior

Browser Run uses native `quickAction()`; there is no session for the app to close.
Navigation and browser-action limits are five seconds each, plus a fifteen-second
local wait deadline. The exact `allowRequestPattern` also excludes redirected and
subresource destinations; JavaScript is disabled and no authenticated destination
is accepted. Keep this fixed trusted page if adapting the example. A URL-origin
check alone is insufficient for an arbitrary page. Contract tests verify request
options; live egress enforcement still requires platform acceptance.

`workers-ai-provider@4.0.0` implements AI SDK 7's provider contract. It is built
from the current request's `env.AI`; `createAi` sets the fixed model
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`. The gateway route uses the same provider
with server-owned `AI_GATEWAY_ID` and `skipCache: true`. No REST account token or
second provider package is needed. The request-bound `readSample` tool validates
its strict literal ID and captures verified ownership outside model input. No
arbitrary tool registry, messages, provider options or model overrides are exposed.

The AI deadline is twenty seconds through request reading and streamed output.
Client/request abort, downstream body cancellation, byte overflow and provider
failure abort the SDK signal; the upstream provider forwards it to `AI.run`.
**This does not confirm inference cancellation or stop billing.** The pinned
provider does not promise cancellation of a bare native SSE reader when the SDK
consumer cancels. Tests assert signal forwarding, not that remote work stopped.
Provider failures explicitly abort the owned output stream with a sanitized error:
the SDK text response would otherwise allow an empty successful body. After headers
are sent, failures terminate the stream and cannot change its HTTP status. Consumers
must treat stream failures or empty results as failed operations.

VPC requests use existing `HttpService` with a native `HttpTransport`. The VPC
Service configuration selects the actual private host/port; the fixed URL supplies
Host/SNI and path. The caller token is not sent to that service. Configure any
service-to-service credentials separately on the server when adapting the fixture.
HttpService composes request abort and timeout through reading/validation. It makes
no retries. Non-2xx/redirect response bodies are explicitly discarded.

Images consumes the R2 body once under a hard byte ceiling before giving a fresh,
bounded stream to the native transform. No unbounded `tee()` buffers are involved.
It consumes the generated WebP under a separate ceiling before returning success.
The ten-second deadline includes waiting for R2 and Images output. Native
`get()`, `quickAction()` and Images `output()` have no signal parameter here;
the app stops waiting and discards late output while its execution remains alive.
Cleanup cancels readers/bodies
without awaiting an uncooperative native cancellation. It cannot destroy an
in-progress native transform. The input cap limits encoded bytes, not total heap or
decoded pixels; only pre-existing, trusted, small PNG fixtures belong in this app's
owner namespace. An upload service needs its own format/pixel validation policy.

## Opt-in remote acceptance

The acceptance runner does not provision, deploy or enable products.
It only calls a **pre-existing deployed synthetic instance of this source**.
It does not inspect Wrangler auth, read account credentials, upload objects, change
bindings or deploy. Do not point it at production or an unrelated application.

An operator must already have a private fixture with a fresh token (at least 16
characters), one synthetic owner, native Browser/AI/Images bindings, an existing AI
Gateway, an existing R2 object `owners/<owner>/sample.png` (a small static PNG), and
an existing VPC Service reachable at the fixed Host/SNI
`catalog.internal.example`. Its `/items/sample` endpoint must return
`{"id":"sample","available":3}` and expose no private data. Configure its TLS
certificate for that Host/SNI. Use only resources already owned for this purpose.
The runner makes one unauthenticated check and at most two authorized product calls
for the selected case; Browser, AI and Images calls can incur usage.

Set `COMPOSITION_URL` to the HTTPS origin and `COMPOSITION_TOKEN` through your
shell's secure secret entry, then explicitly run one case:

```sh
COMPOSITION_REMOTE=1 pnpm --filter vela-cloudflare-composition test:remote browser
COMPOSITION_REMOTE=1 pnpm --filter vela-cloudflare-composition test:remote ai
COMPOSITION_REMOTE=1 pnpm --filter vela-cloudflare-composition test:remote vpc
COMPOSITION_REMOTE=1 pnpm --filter vela-cloudflare-composition test:remote images
```

Without opt-in/configuration the runner fails; it never reports skipped checks as
success. Redirects are rejected before the auth token could be forwarded. It checks
status, content type, no-store headers, byte ceilings, PNG/PDF/WebP signatures,
nonempty model text and the synthetic VPC schema. It never prints credentials or
model output. These HTTP assertions need the following platform observations:

| Surface | What local checks prove | Required live observations |
| --- | --- | --- |
| Browser Run | Fixed arguments, auth, byte/deadline/cancel handling with doubles | Quick Actions needs remote execution. Verify PNG/PDF render the trusted page, one PDF page, and inspect Browser Run logs for allowed egress / rejected redirected or subresource destinations before widening the policy. |
| Workers AI / Gateway | Actual SDK/provider wiring, separate bindings and gateway settings, tools, abort propagation with a double | Workers AI has no local model emulator. Verify native inference succeeds and gateway requests appear under the configured gateway/model. An HTTP response alone does not establish gateway routing, tool execution, upstream cancellation or billing behavior. |
| VPC | HttpService cancellation, response validation and fixed request with a double | Verify the pre-existing private fixture logs show the request through its VPC Service, expected Host/SNI and no user authorization header. Local fetch doubles do not exercise a Tunnel or private network. |
| Images | Actual local R2 read and WebP conversion/dimensions | Verify production output dimensions, quality, fit and animation behavior with the existing fixture. Local Images supports only a subset; it does not prove production fidelity. |

Source/API references, checked September 25, 2026: [Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/),
[screenshot](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/),
[PDF](https://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/),
[Workers AI SDK](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/),
[upstream provider](https://github.com/cloudflare/ai/tree/main/packages/workers-ai-provider),
[Workers AI development](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/),
[VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/),
[Images binding](https://developers.cloudflare.com/images/optimization/binding/),
and [Images limits](https://developers.cloudflare.com/images/get-started/limits/).
