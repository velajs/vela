/**
 * Portable, synchronous SHA-256 (FIPS 180-4) returning a lowercase hex digest.
 *
 * Implemented straight from the published standard so this file carries no
 * runtime dependency and produces byte-for-byte identical output on every
 * target Vela supports — browsers, the Cloudflare Workers (workerd) runtime,
 * and Node. Neither built-in alternative fits the fingerprinter:
 *   - `node:crypto` (`createHash`) is absent in browsers and needs
 *     `nodejs_compat` to load in workerd.
 *   - `crypto.subtle.digest` is async, which is clumsy for folding error rows
 *     into a group key one synchronous call at a time.
 *
 * SECURITY: this is a plain, non-constant-time digest meant ONLY for
 * content-addressing and grouping keys. Never use it as a MAC, a password hash,
 * or any other authentication or security primitive.
 */

const BLOCK_BYTES = 64;

// Round constants K[0..63]: the first 32 bits of the fractional parts of the
// cube roots of the first 64 primes (FIPS 180-4 §4.2.2).
const ROUND = Uint32Array.of(
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
);

const rotr = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

const toHex8 = (word: number): string => (word >>> 0).toString(16).padStart(8, '0');

export const sha256Hex = (input: string): string => {
  const message = new TextEncoder().encode(input);
  const bitLength = message.length * 8;

  // One 0x80 marker byte, an 8-byte length trailer, zero fill in between, all
  // rounded up to whole 64-byte blocks.
  const totalBytes = (Math.floor((message.length + 8) / BLOCK_BYTES) + 1) * BLOCK_BYTES;
  const padded = new Uint8Array(totalBytes);
  padded.set(message);
  padded[message.length] = 0x80;

  const frame = new DataView(padded.buffer);
  // Big-endian 64-bit bit length in the final 8 bytes. Fingerprint inputs are
  // short strings, so the high word stays zero in practice, but compute it
  // anyway for correctness.
  frame.setUint32(totalBytes - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  frame.setUint32(totalBytes - 4, bitLength >>> 0, false);

  // Initial state H[0..7]: first 32 bits of the fractional parts of the square
  // roots of the first 8 primes (FIPS 180-4 §5.3.3).
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const schedule = new Uint32Array(64);

  for (let base = 0; base < totalBytes; base += BLOCK_BYTES) {
    for (let t = 0; t < 16; t += 1) {
      schedule[t] = frame.getUint32(base + t * 4, false);
    }
    for (let t = 16; t < 64; t += 1) {
      const x = schedule[t - 15] as number;
      const y = schedule[t - 2] as number;
      const sigma0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const sigma1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      schedule[t] =
        ((schedule[t - 16] as number) + sigma0 + (schedule[t - 7] as number) + sigma1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t += 1) {
      const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + bigSigma1 + choose + (ROUND[t] as number) + (schedule[t] as number)) >>> 0;
      const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (bigSigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return (
    toHex8(h0) +
    toHex8(h1) +
    toHex8(h2) +
    toHex8(h3) +
    toHex8(h4) +
    toHex8(h5) +
    toHex8(h6) +
    toHex8(h7)
  );
};
