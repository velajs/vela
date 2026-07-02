import { Controller, Get, Inject, Req } from '@velajs/vela';
import { verifySignedUrl } from '@velajs/vela/storage';
import type { Context } from 'hono';
import { EnvService } from '../services/env.service';
import { StorageManagerService } from './storage-manager.service';

/**
 * Presign-proxy: serves objects for HMAC-signed URLs produced by
 * `StorageService.url()`. R2 has no native presign, so a signed URL points here;
 * this route verifies the signature (+expiry) before streaming the object.
 * The wildcard is the FULL object path (root already applied at sign time), so
 * it is passed straight to the driver.
 */
@Controller('storage')
export class StorageController {
  constructor(
    @Inject(StorageManagerService) private readonly manager: StorageManagerService,
    @Inject(EnvService) private readonly env: EnvService,
  ) {}

  @Get('/:disk/*')
  async download(@Req() c: Context): Promise<Response> {
    const secret = this.env.get<string>('APP_SECRET');
    if (!secret) return new Response('Storage signing is not configured', { status: 500 });

    const disk = c.req.param('disk');
    if (!disk || !this.manager.hasDisk(disk)) return new Response('Unknown disk', { status: 404 });

    if (!(await verifySignedUrl(c.req.url, secret))) {
      return new Response('Invalid or expired URL', { status: 403 });
    }

    // Enforce the signed `method` scope: this proxy only serves reads, so a URL
    // scoped to PUT/DELETE/HEAD must NOT be honored as a GET (it would over-grant
    // read access relative to the token's intended scope). The param is part of
    // the signed payload, so it is trustworthy once the signature verifies.
    const url = new URL(c.req.url);
    if ((url.searchParams.get('method') ?? 'GET') !== 'GET') {
      return new Response('URL is not scoped for reads', { status: 403 });
    }

    // The object key is everything after `/storage/:disk/` (Hono doesn't expose
    // the `*` wildcard via param()). The key already includes the disk root.
    const { pathname } = url;
    const prefix = `/storage/${disk}/`;
    const idx = pathname.indexOf(prefix);
    const fullPath = idx >= 0 ? decodeURIComponent(pathname.slice(idx + prefix.length)) : '';
    try {
      const result = await this.manager.getDriver(disk).download(fullPath);
      return new Response(result.toStream(), { headers: { 'content-type': result.contentType } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
}
