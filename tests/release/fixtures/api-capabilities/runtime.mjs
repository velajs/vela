import { verifyRequestDatabases } from './request-databases.mjs';
import { verifyFormsAndCache } from './forms-cache.mjs';
import { verifyAtomicWrites } from './atomic.mjs';
import { verifyTransportAndStreams } from './transport-streams.mjs';
import { verifyTransactionalHistory } from './history.mjs';

await verifyFormsAndCache();
await verifyAtomicWrites();
await verifyTransportAndStreams();
await verifyTransactionalHistory();
await verifyRequestDatabases();
console.log(
  'PASS: public forms, streams, telemetry, cache isolation, transactional audit/history and request databases',
);
