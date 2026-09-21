import { copyFile, mkdir } from 'node:fs/promises';
const source = new URL('cedar_wasm_bg.wasm', import.meta.resolve('@cedar-policy/cedar-wasm/web'));
await mkdir(new URL('../dist/cloudflare/', import.meta.url), { recursive: true });
await copyFile(source, new URL('../dist/cloudflare/cedar.wasm', import.meta.url));
