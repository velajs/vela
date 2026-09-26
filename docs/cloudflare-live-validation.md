# Cloudflare service acceptance

Local Workers tests establish runtime and adapter behavior. Service acceptance
also needs observations from the configured Cloudflare service. Run these checks
explicitly against synthetic resources and keep the results separate from
`pnpm verify`.

Use the opt-in probes and configuration documented in the
[composition example](../apps/cloudflare-composition/README.md),
[Hyperdrive example](../apps/hyperdrive-crud/README.md), and
[retrieval guide](../packages/ai/docs/cloudflare-retrieval.md). Configure resources
before running a probe; a missing binding, endpoint or credential is a not-run
result. Local tests must not silently enable remote bindings or fall back to
cached account credentials.

Record the tested source revision, compatibility date, service configuration,
start/end time and bounded observation deadline. Keep credentials and raw data
out of the record. Report submission, downstream observation and cleanup
separately. A timeout is inconclusive about an accepted asynchronous operation;
retain its identifier for reconciliation.

## Vectorize and Hyperdrive

For retrieval, observe a submitted synthetic revision through native search,
then replace it, revoke its permission and delete it while checking the
authoritative retrieval path. Stale candidates must never restore access. Record
mutation identifiers as diagnostics; they do not establish query visibility for
every reader. Exercise restart/reconciliation separately from the initial write.

For Hyperdrive, compare overlapping authenticated operations with the database's
observed connections and committed rows. Include rollback and a caller that
cancels while work is pending. Use a cache-disabled configuration for freshness
checks. A successful local PostgreSQL/workerd run proves socket and invocation
ownership; remote pooling, routing and cache behavior require the configured
Hyperdrive service.

## Exported handler traces

Use the [native tracing interceptor](../packages/cloudflare/README.md#native-handler-tracing)
on a synthetic HTTP controller and service RPC host. Enable tracing and choose a
sampling rate that makes the small acceptance run observable. Send overlapping
requests that each await a service RPC and a binding call, and include one handler
that throws.

Inspect the exported trace trees for `vela.http.handler` and `vela.rpc.handler`.
Check that awaited child operations have the expected handler ancestry and that
overlapping invocations remain distinct. Check the fixed class/method labels and
that sampled error invocations finish. Then disable sampling and confirm handler
results and thrown errors still behave correctly.

An HTTP response or a mocked `enterSpan` callback does not establish exported
parent relationships. Response-body consumption, deferred work and disposal can
outlive the handler span. Cloudflare owns transport spans, sampling and export;
Vela does not supply manual parent IDs. See
[custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
for the native callback lifetime.

## Account events and dead letters

Use the [platform-event consumer](cloudflare-queue-events.md) with an existing
dedicated queue and Worker-build subscription. Observe a real build event, matching
its `buildUuid`, event type, source Worker, account and subscription to the
configured synthetic resources. A fabricated envelope sent directly to the
queue only tests the consumer.

In a controlled failure case, verify that successful siblings remain acknowledged
and the failing message is retried. Observe it in the configured dead-letter
queue after retry exhaustion. Record native message IDs and attempts as well as
the source build ID. Check repeated delivery against the application's idempotent
effect; the adapter itself does not deduplicate.

Review producer permissions separately: matching envelope metadata does not prove
origin. The [event schemas](https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/)
define payloads; actual subscription delivery and dead-letter routing are the
service observations required here.

## Pipelines acceptance and downstream visibility

Use a preconfigured stream whose schema matches the
[validated producer](../packages/cloudflare/README.md#validated-pipelines-producers).
Send a small batch with a unique synthetic run identifier. Record ingestion
acceptance, then query the configured downstream destination for that identifier
until a bounded deadline. Compare the observed fields with the schema's validated
output, including transforms. Record missing or duplicate records explicitly.

Verify separately that producer-invalid input rejects before invoking the native
binding. For a deliberately mismatched producer/stream schema in a disposable
fixture, inspect the service's downstream result and diagnostics rather than
treating a successful send as validation proof. Cloudflare documents that
[invalid structured events can be accepted and later dropped](https://developers.cloudflare.com/pipelines/streams/writing-to-streams/#schema-validation).

The local Pipelines binding's no-op `send()` cannot establish any of these remote
observations. Ingestion acceptance does not promise immediate query visibility,
exactly-once effects or a storage transaction. Do not automatically resubmit a
timed-out batch without the application's duplicate-handling policy.
