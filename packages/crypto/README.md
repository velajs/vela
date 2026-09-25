# @velajs/crypto

Asynchronous authenticated encryption using Web Crypto. The portable root has
no framework runtime dependencies. Optional exports: `/vela`, `/tenant`,
`/fields`, `/files`, and `/cloudflare`.

```ts
import { CryptoService, LocalKeyRing } from '@velajs/crypto';
const provider = await LocalKeyRing.fromRaw('v2', { v1: previousKeyBytes, v2: activeKeyBytes });
const service = new CryptoService(provider);
const context = { namespace: 'files:production', tenantId: 'acme', purpose: 'notes', caller: { record: '42' } };
const encrypted = await service.encryptText('private text', context);
const plaintext = await service.decryptText(encrypted, context);
const rotated = await service.reencrypt(encrypted, context);
```

Keys are 32 random bytes, imported as nonextractable AES-KW `CryptoKey`s. Each
message gets a fresh AES-GCM data key and 96-bit random nonce. Versioned envelopes
authenticate their algorithm, key ID, wrapped data key, nonce, namespace, tenant,
purpose, caller context, and ciphertext. Default plaintext limit is 16 MiB;
configure `maxPlaintextBytes` (at most 64 MiB). Malformed envelopes, wrong keys,
context mismatches, and tampering fail authentication.

`KeyProvider.current/get` lets applications supply environment-owned providers.
Keep old unwrap keys during rotation; re-encrypt before retiring them. Key IDs
are stable canonical strings. `protect()` authenticates an existing envelope
before treating it as already protected; prefix matching alone never succeeds.
Envelope encryption does not replace authentication or resource authorization.

## Tenant, fields, and DI

`new TenantCrypto(service, reader, namespace).forPurpose(purpose, caller)` derives
canonical tenant authority on each operation. It rejects expired/disposed and
administrative scopes. Do not use a request header as `tenantId`. Headless
`forContext()` remains an explicit infrastructure primitive.

`fieldProtection({ fields, cipher: field => ..., authorizeRead })` exposes
`protect(row)` before persistence and `reveal(row)` after response authorization.
Values are JSON encoded. Bind each field's purpose and record identity through
its cipher, preventing ciphertext substitution across fields or rows. Unreadable
fields are omitted; authenticated plaintext is never automatically exposed by
serialization. Call these boundaries explicitly from services/hooks.

`CryptoModule.forRoot({ provider })` / `forRootAsync` and `CRYPTO_SERVICE` from
`/vela` integrate DI. Construct providers from the current environment binding.
Never cache one environment's keys in a module-level provider singleton.

## Files and R2

```ts
import { encryptToR2, decryptFromR2 } from '@velajs/crypto/files';
const cipher = tenantCrypto.forPurpose('file', { object: objectKey });
await encryptToR2(env.BUCKET, objectKey, uploadBody, cipher, { signal });
const body = await decryptFromR2(env.BUCKET, objectKey, cipher, { signal });
```

`encryptFile()` and `decryptFile()` also work with arbitrary Web byte streams.
The versioned format seals a per-file key and authenticates the header, frame
sequence, type, length, and completion count. Reordering, duplication, truncation,
tampering, trailing bytes, and wrong context fail. Chunks default to 64 KiB, with
a 1 MiB maximum. The reader retains one upstream chunk and a frame; choose a
bounded source chunk size. R2 multipart upload buffers 5 MiB per part, completes
only after encrypted EOF, and aborts on failure/cancellation (including initiation
failure cancelling the plaintext source).

Decryption yields individually authenticated chunks; only successful EOF proves
the file is complete. Consumers needing all-or-nothing publication must stage the
plaintext until EOF. Bind the object key in caller context as shown; R2 object
names alone are not cryptographic authority. An aborted upload may require R2's
normal abandoned-multipart lifecycle cleanup if the service is unavailable.

## Cloudflare Secrets Store

`SecretsStoreKeyProvider` from `@velajs/crypto/cloudflare` implements the existing
`KeyProvider` using native secret bindings. The subpath and portable root work
without Vela. Secrets Store supplies key material; AES-KW wrap/unwrap still runs
locally in Web Crypto. This is not a remote KMS and does not implement remote
wrap/unwrap or non-exportable hardware keys.

Each bound secret must contain exactly 32 random bytes encoded as canonical,
unpadded base64url (43 characters), without whitespace or a JSON wrapper.
The provider imports a nonextractable AES-KW key and clears its decoded temporary
byte array; JavaScript strings returned by the binding cannot be zeroed.
Key IDs use 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`, starting with a
letter or digit. IDs are copied from configuration and never change in a provider.
Do not use mutable aliases such as `current` as envelope key IDs.

```ts
import { CryptoService } from '@velajs/crypto';
import { SecretsStoreKeyProvider, type SecretsStoreSecret } from '@velajs/crypto/cloudflare';

interface Env {
  KEY_2026_08: SecretsStoreSecret;
  KEY_2026_09: SecretsStoreSecret;
}

// Cache by the native environment object, never one process-global service.
const services = new WeakMap<Env, CryptoService>();
function cryptoFor(env: Env): CryptoService {
  let service = services.get(env);
  if (!service) {
    service = new CryptoService(new SecretsStoreKeyProvider({
      activeKeyId: 'key-2026-09',
      keys: { 'key-2026-08': env.KEY_2026_08, 'key-2026-09': env.KEY_2026_09 },
      // Optional: reuse imported keys for one minute. Default 0 re-reads every operation.
      cacheTtlMs: 60_000,
    }));
    services.set(env, service);
  }
  return service;
}

export default {
  async fetch(_request: Request, env: Env) {
    const service = cryptoFor(env);
    const context = { namespace: 'documents:production', purpose: 'content' };
    const encrypted = await service.encryptText('synthetic text', context);
    return new Response(encrypted);
  },
};
```

Configure a separate binding per key version with `secrets_store_secrets`:

```jsonc
{
  "secrets_store_secrets": [
    { "binding": "KEY_2026_08", "store_id": "<STORE_ID>", "secret_name": "document-key-2026-08" },
    { "binding": "KEY_2026_09", "store_id": "<STORE_ID>", "secret_name": "document-key-2026-09" }
  ]
}
```

Reads start on `current()`/`get()` during an operation, not in the constructor.
For Vela, construct this provider in `CryptoModule.forRootAsync({ inject: [ENV],
useFactory: env => ({ provider: new SecretsStoreKeyProvider(...) }) })` using a
typed environment token. Keep asynchronous reads out of synchronous `registerAs`
configuration factories. Applications that need eager validation can await
`provider.current()` during their supported asynchronous initialization.

Concurrent reads of one ID share a pending load. Completed keys are reused only
within `cacheTtlMs`; expiry or `provider.invalidate(id)` re-reads on the next
operation. `invalidate()` evicts all keys. In-flight operations may finish with
their original key; invalidation does not cancel them. No stale key is served if
a refresh fails, and failed loads can retry. A positive TTL delays detection of
secret deletion/changes until expiry or invalidation; it is not an immediate
revocation mechanism. Errors contain a fixed message with no original binding
error or cause, secret value, key bytes, or ID.

Rotate by adding a new secret under a new immutable ID and constructing a new
provider whose active ID selects it. Keep old bindings until their ciphertext
has been re-encrypted. Never update an existing key secret in place: an instance
remembers each successfully observed material fingerprint across invalidation and
rejects reassignment to different bytes. That check is local to the instance;
it cannot detect changes that happened before startup or in other isolates.
Enforce immutable versioned secrets in deployment and key-management policy.
Unknown decryption IDs return `undefined`, so envelope authentication fails.

Cloudflare supports local Secrets Store values separate from production. See
[Workers bindings and local setup](https://developers.cloudflare.com/secrets-store/integrations/workers/).
The package's `test:workers` command exercises its built exports, native local
Secrets Store bindings and Web Crypto in workerd without Node compatibility.
