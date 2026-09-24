import { AwsClient } from 'aws4fetch';
import { utf8ToBase64 } from '../../base64';
import type { S3DriverOptions } from './s3.types';

// --- Web-Crypto SigV4 helpers (used only for the POST-policy path; the
// request-signing path is aws4fetch). No node:crypto, no Buffer. ---

const encoder = new TextEncoder();

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return new Uint8Array(sig);
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function sigV4SigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service = 's3',
): Promise<Uint8Array> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function amzDates(): { amzDate: string; dateStamp: string } {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface PostPolicyOptions {
  expiresIn: number;
  contentType?: string;
  maxSize?: number;
  minSize?: number;
}

/**
 * Thin wrapper over aws4fetch: builds addressed URLs, sends SigV4-signed
 * requests, and mints presigned GET/PUT URLs + presigned-POST policies.
 * The single place S3 signing happens.
 */
export class S3Client {
  readonly #aws: AwsClient;
  readonly #cfg: S3DriverOptions;
  readonly #fetch: (request: Request) => Promise<Response>;

  constructor(cfg: S3DriverOptions) {
    this.#cfg = cfg;
    // Call the transport without a receiver: workerd rejects the platform
    // fetch invoked as a method of another object ("Illegal invocation").
    const transport = cfg.fetch ?? fetch;
    this.#fetch = (request) => transport(request);
    this.#aws = new AwsClient({
      accessKeyId: cfg.credentials.accessKeyId,
      secretAccessKey: cfg.credentials.secretAccessKey,
      sessionToken: cfg.credentials.sessionToken,
      region: cfg.region,
      service: 's3',
    });
  }

  get bucket(): string {
    return this.#cfg.bucket;
  }

  /** Encode each key segment but keep `/` separators. */
  #encodeKey(key: string): string {
    return key.split('/').map(encodeURIComponent).join('/');
  }

  objectUrl(key: string, query?: Record<string, string>): URL {
    const enc = this.#encodeKey(key);
    const u = new URL(this.#cfg.endpoint);
    if (this.#cfg.forcePathStyle) {
      u.pathname = `/${this.#cfg.bucket}${enc ? `/${enc}` : ''}`;
    } else {
      u.hostname = `${this.#cfg.bucket}.${u.hostname}`;
      u.pathname = `/${enc}`;
    }
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  /** The bucket-root URL used as the presigned-POST target. */
  postUrl(): string {
    const u = new URL(this.#cfg.endpoint);
    if (this.#cfg.forcePathStyle) u.pathname = `/${this.#cfg.bucket}`;
    else u.hostname = `${this.#cfg.bucket}.${u.hostname}`;
    return u.toString();
  }

  /** Send a SigV4-signed request. */
  async send(url: URL, init: RequestInit): Promise<Response> {
    const signed = await this.#aws.sign(url.toString(), init);
    return this.#fetch(signed);
  }

  /** Presign a GET or PUT URL via query signing (unsigned payload). */
  async presign(
    key: string,
    method: 'GET' | 'PUT',
    expiresIn: number,
    query?: Record<string, string>,
  ): Promise<string> {
    const url = this.objectUrl(key, { ...query, 'X-Amz-Expires': String(expiresIn) });
    const signed = await this.#aws.sign(url.toString(), {
      method,
      aws: { signQuery: true },
    });
    return signed.url;
  }

  /**
   * Presigned POST policy — enforces `content-length-range` server-side.
   * aws4fetch only signs requests, so the policy HMAC chain is hand-rolled
   * on Web Crypto (edge-safe).
   */
  async signPostPolicy(
    key: string,
    opts: PostPolicyOptions,
  ): Promise<{ url: string; fields: Record<string, string> }> {
    const { amzDate, dateStamp } = amzDates();
    const { accessKeyId, secretAccessKey, sessionToken } = this.#cfg.credentials;
    const credential = `${accessKeyId}/${dateStamp}/${this.#cfg.region}/s3/aws4_request`;
    const expiration = new Date(Date.now() + opts.expiresIn * 1000).toISOString();

    const conditions: Array<Record<string, string> | [string, string | number, number]> = [
      { bucket: this.#cfg.bucket },
      { key },
      { 'x-amz-algorithm': 'AWS4-HMAC-SHA256' },
      { 'x-amz-credential': credential },
      { 'x-amz-date': amzDate },
    ];
    if (sessionToken) conditions.push({ 'x-amz-security-token': sessionToken });
    if (opts.contentType) conditions.push({ 'content-type': opts.contentType });
    if (opts.maxSize != null || opts.minSize != null) {
      conditions.push([
        'content-length-range',
        opts.minSize ?? 0,
        opts.maxSize ?? opts.minSize ?? 0,
      ]);
    }

    const policyB64 = utf8ToBase64(JSON.stringify({ expiration, conditions }));
    const signingKey = await sigV4SigningKey(secretAccessKey, dateStamp, this.#cfg.region);
    const signature = hex(await hmac(signingKey, policyB64));

    const fields: Record<string, string> = {
      key,
      'x-amz-algorithm': 'AWS4-HMAC-SHA256',
      'x-amz-credential': credential,
      'x-amz-date': amzDate,
      policy: policyB64,
      'x-amz-signature': signature,
    };
    if (sessionToken) fields['x-amz-security-token'] = sessionToken;
    if (opts.contentType) fields['content-type'] = opts.contentType;

    return { url: this.postUrl(), fields };
  }
}
