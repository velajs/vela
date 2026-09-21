import { verifyFormsAndCache } from './forms-cache.mjs';
import { verifyAtomicWrites } from './atomic.mjs';

await verifyFormsAndCache();
await verifyAtomicWrites();
console.log('PASS: public HTTP form, cache isolation/invalidation and atomic audit behavior');
