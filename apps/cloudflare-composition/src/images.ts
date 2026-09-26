import { z } from 'zod';
import {
  deadline,
  discard,
  privateHeaders,
  readBytes,
  RequestFailure,
  waitForResponse,
} from './bounds';

export const imageVariant = z.enum(['thumbnail', 'card']);
export const transforms = {
  thumbnail: { width: 128, height: 128, fit: 'cover' },
  card: { width: 640, height: 360, fit: 'contain' },
} satisfies Record<z.infer<typeof imageVariant>, ImageTransform>;

export async function renderImage(
  env: Cloudflare.Env,
  owner: string,
  variant: string,
  request: Request,
): Promise<Response> {
  const selected = imageVariant.parse(variant);
  const operation = deadline(request.signal, 10_000);
  let source: Response | undefined;
  let input: ReadableStream<Uint8Array> | undefined;
  try {
    operation.signal.throwIfAborted();
    // Identity comes from verified server policy, never from a path/key/owner parameter.
    // Immutable fixture key; this endpoint neither uploads nor overwrites objects.
    source = await waitForResponse(
      env.MEDIA.get(`owners/${owner}/sample.png`).then((object) =>
        object
          ? new Response(object.body, { headers: { 'content-length': String(object.size) } })
          : new Response(null, { status: 404 }),
      ),
      operation.signal,
    );
    if (source.status === 404) throw new RequestFailure(404, 'Image not found');
    if (Number(source.headers.get('content-length')) > 1024 * 1024)
      throw new RequestFailure(413, 'Input image too large');
    const bytes = await readBytes(source.body, 1024 * 1024, operation.signal);
    operation.signal.throwIfAborted();
    // Buffer once under a hard cap instead of teeing an unbounded R2 stream. The
    // owned source is consumed before Images runs. The native pipeline is explicit.
    input = new Response(bytes).body!;
    const response = await waitForResponse(
      env.IMAGES.input(input)
        .transform(transforms[selected])
        .output({ format: 'image/webp', quality: 75, anim: false })
        .then((result) => result.response()),
      operation.signal,
    );
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/webp') {
      discard(response.body);
      throw new RequestFailure(502, 'Image conversion failed');
    }
    const output = await readBytes(response.body, 512 * 1024, operation.signal);
    return new Response(output, { headers: { ...privateHeaders, 'content-type': 'image/webp' } });
  } finally {
    if (source && !source.bodyUsed) discard(source.body);
    if (input && !input.locked) discard(input);
    operation.dispose();
  }
}
