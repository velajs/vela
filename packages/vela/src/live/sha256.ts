// SHA-256 (FIPS 180-4) of UTF-8 text, computed synchronously. Web Crypto's
// digest is asynchronous, while a presence tag is derived where every live
// query's tags are: synchronously, when a subscription is prepared.

const ROUND_CONSTANTS = Uint32Array.of(
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

const INITIAL_HASH = Uint32Array.of(
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
);

const encoder = new TextEncoder();

const rotateRight = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

/** The lowercase hex SHA-256 digest of `text`'s UTF-8 bytes. */
export function sha256Hex(text: string): string {
  const message = encoder.encode(text);
  // The message, a 0x80 marker and its 64-bit bit length, in whole 64-byte blocks.
  const padded = new Uint8Array(Math.ceil((message.byteLength + 9) / 64) * 64);
  padded.set(message);
  padded[message.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = message.byteLength * 8;
  view.setUint32(padded.byteLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.byteLength - 4, bitLength >>> 0);

  const hash = INITIAL_HASH.slice();
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.byteLength; offset += 64) {
    for (let t = 0; t < 16; t++) schedule[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const w15 = schedule[t - 15]!;
      const w2 = schedule[t - 2]!;
      const sigma0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const sigma1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      // A Uint32Array element stores the sum modulo 2^32.
      schedule[t] = schedule[t - 16]! + sigma0 + schedule[t - 7]! + sigma1;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let t = 0; t < 64; t++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + ROUND_CONSTANTS[t]! + schedule[t]!) | 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    hash[0] = hash[0]! + a;
    hash[1] = hash[1]! + b;
    hash[2] = hash[2]! + c;
    hash[3] = hash[3]! + d;
    hash[4] = hash[4]! + e;
    hash[5] = hash[5]! + f;
    hash[6] = hash[6]! + g;
    hash[7] = hash[7]! + h;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('');
}
