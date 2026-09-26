import { z } from 'zod';
import {
  deadline,
  discard,
  privateHeaders,
  readBytes,
  RequestFailure,
  waitForResponse,
} from './bounds';

export const browserFormat = z.enum(['screenshot', 'pdf']);
// Server-owned destination allowlist: exactly this public, trusted, credential-free page.
// Requests to redirects and subresources must also match the exact pattern. No cookies,
// application auth headers, client HTML, JavaScript, URL or viewport options are forwarded.
export const browserOptions = {
  url: 'https://example.com/',
  allowRequestPattern: ['^https://example\\.com/$'],
  allowResourceTypes: ['document'],
  setJavaScriptEnabled: false,
  gotoOptions: { waitUntil: 'load', timeout: 5000 },
  actionTimeout: 5000,
  viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  cacheTTL: 0,
} satisfies BrowserRunCommonOptions;

export async function renderPage(
  env: Cloudflare.Env,
  format: string,
  request: Request,
): Promise<Response> {
  const selected = browserFormat.parse(format);
  const operation = deadline(request.signal, 15_000);
  try {
    operation.signal.throwIfAborted();
    const pending =
      selected === 'screenshot'
        ? env.BROWSER.quickAction('screenshot', {
            ...browserOptions,
            screenshotOptions: { type: 'png', fullPage: false },
          })
        : env.BROWSER.quickAction('pdf', {
            ...browserOptions,
            pdfOptions: { format: 'a4', timeout: 5000, pageRanges: '1', printBackground: true },
          });
    const response = await waitForResponse(pending, operation.signal);
    const type = selected === 'screenshot' ? 'image/png' : 'application/pdf';
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== type) {
      discard(response.body);
      throw new RequestFailure(502, 'Browser rendering failed');
    }
    const bytes = await readBytes(response.body, 2 * 1024 * 1024, operation.signal);
    return new Response(bytes, { headers: { ...privateHeaders, 'content-type': type } });
  } finally {
    operation.dispose();
  }
}
