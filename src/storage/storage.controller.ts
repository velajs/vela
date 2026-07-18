import { Controller, Get, Inject, Req } from '@velajs/vela';
import { joinStoragePath, STORAGE_SIGNED_URL_PURPOSE, verifySignedUrl } from '@velajs/vela/storage';
import type { Context } from 'hono';
import { EnvService } from '../services/env.service';
import { StorageManagerService } from './storage-manager.service';
import { decodeStorageKeyClaim, isStorageKeyWithinRoot } from './storage-key-claim';

/**
 * Presign-proxy: serves objects for HMAC-signed URLs produced by
 * `StorageService.url()`. R2 has no native presign, so a signed URL points here;
 * this route verifies the signature (+expiry) before streaming the object.
 * The FULL object key (root already applied at sign time) is carried as an
 * opaque base64url query claim. The signature is verified before the claim is
 * decoded exactly once and checked against the configured disk root.
 */
@Controller('storage')
export class StorageController {
  constructor(
    @Inject(StorageManagerService) private readonly manager: StorageManagerService,
    @Inject(EnvService) private readonly env: EnvService,
  ) {}

  @Get('/:disk')
  async download(@Req() c: Context): Promise<Response> {
    const secret = this.env.get<string>('APP_SECRET');
    if (!secret) return new Response('Storage signing is not configured', { status: 500 });

    // Verify the complete path/query capability before inspecting the disk or
    // decoding attacker-controlled claims.
    if (
      !(await verifySignedUrl(c.req.url, secret, {
        method: c.req.method,
        purpose: STORAGE_SIGNED_URL_PURPOSE,
      }))
    ) {
      return new Response('Invalid or expired URL', { status: 403 });
    }

    // Enforce the signed `method` scope: this proxy only serves reads, so a URL
    // scoped to PUT/DELETE/HEAD must NOT be honored as a GET (it would over-grant
    // read access relative to the token's intended scope). The param is part of
    // the signed payload, so it is trustworthy once the signature verifies.
    const url = new URL(c.req.url);
    if (url.searchParams.get('method') !== 'GET') {
      return new Response('URL is not scoped for reads', { status: 403 });
    }

    const disk = c.req.param('disk');
    if (!disk || !this.manager.hasDisk(disk)) return new Response('Unknown disk', { status: 404 });

    const claim = url.searchParams.get('key');
    const decoded = claim ? decodeStorageKeyClaim(claim) : undefined;
    if (!decoded) return new Response('Malformed storage key claim', { status: 400 });

    // Canonicalize after the one decode. Signed direct-driver callers cannot
    // smuggle dot segments or non-canonical aliases into the proxy contract.
    const fullPath = joinStoragePath(undefined, decoded);
    if (fullPath !== decoded) return new Response('Invalid storage key', { status: 403 });

    if (!isStorageKeyWithinRoot(fullPath, this.manager.getDiskConfig(disk).root)) {
      return new Response('Storage key is outside the configured root', { status: 403 });
    }

    try {
      const result = await this.manager.getDriver(disk).download(fullPath);
      const filename = fullPath.split('/').at(-1) || 'download';
      return new Response(result.toStream(), {
        headers: {
          'content-type': result.contentType || 'application/octet-stream',
          // Objects are untrusted user content.  The authenticated API origin
          // never renders them inline (especially HTML/SVG), even when the
          // stored Content-Type is attacker controlled.
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
}
