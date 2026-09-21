# @velajs/crypto

Asynchronous authenticated encryption using Web Crypto. The portable root has
no framework runtime dependencies. Optional exports: `/vela`, `/tenant`,
`/fields`, and `/files`.

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
