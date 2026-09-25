import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = new URL('../', import.meta.url);
const required = [
  '@velajs/vela',
  '@velajs/crud',
  '@velajs/crud-drizzle',
  '@velajs/crud-memory',
  '@velajs/crud-durable-objects',
  '@velajs/tenant',
  '@velajs/authz-cedar',
  '@velajs/crypto',
  '@velajs/storage',
];
/** Exact archives, outside the workspace; companions are recorded without modifying the release plan. */
export async function verifyEdgePackages(releaseTarballs) {
  const tarballs = { ...releaseTarballs },
    companions = await mkdtemp(join(tmpdir(), 'vela-edge-companions-'));
  for (const name of required) {
    if (tarballs[name]) continue;
    const pkg = new URL(`packages/${name.slice('@velajs/'.length)}/`, root),
      manifest = JSON.parse(await readFile(new URL('package.json', pkg), 'utf8'));
    execFileSync('pnpm', ['pack', '--pack-destination', companions], { cwd: pkg, stdio: 'pipe' });
    tarballs[name] =
      `file:${join(companions, `${name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`)}`;
  }
  const consumer = await mkdtemp(join(tmpdir(), 'vela-edge-consumer-'));
  const version = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8')).version;
  const [typescript, workers, wrangler, zod, drizzle, hono, valibot] = await Promise.all(
    [
      'node_modules/typescript/package.json',
      'node_modules/@cloudflare/workers-types/package.json',
      'node_modules/wrangler/package.json',
      'node_modules/zod/package.json',
      'node_modules/drizzle-orm/package.json',
      'node_modules/hono/package.json',
      'node_modules/valibot/package.json',
    ].map(version),
  );
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'vela-edge-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          ...Object.fromEntries(required.map((name) => [name, tarballs[name]])),
          zod,
          'drizzle-orm': drizzle,
          hono,
          valibot,
        },
        devDependencies: { typescript, '@cloudflare/workers-types': workers, wrangler },
        overrides: tarballs,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2024'],
        types: ['@cloudflare/workers-types'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['consumer.ts'],
    }),
  );
  await writeFile(
    join(consumer, 'consumer.ts'),
    `
import { defineDto, ValidationPipe } from '@velajs/vela/validation';
import { defineResource, defineStandardModel, defineCrudDatabase, createCrudDatabaseRegistry, type ContractInput, type ContractOutput } from '@velajs/crud';
import { bindCrudService } from '@velajs/crud/service';
import { hmacCursorCodec } from '@velajs/crud/query';
import { MemoryStore, transactionalMemoryAdapter } from '@velajs/crud-memory';
import { durableObjectSqliteAdapter } from '@velajs/crud-durable-objects';
import { TenantService, tenantAdmission } from '@velajs/tenant';
import { TenantModule, runInTenantScope } from '@velajs/tenant/vela';
import { D1TenantRegistryStore } from '@velajs/tenant/d1';
import { PostgresTenantRegistryStore } from '@velajs/tenant/postgres';
import { DurableObjectTenantRegistryStore } from '@velajs/tenant/durable-objects';
import { cloudflareCedar } from '@velajs/authz-cedar/cloudflare';
import { createCedarEngine } from '@velajs/authz-cedar';
import { defineVocabulary, t } from '@velajs/authz-cedar/vocabulary';
import { cedarCrudPlan } from '@velajs/authz-cedar/plan';
import { MemoryPolicyStore } from '@velajs/authz-cedar/testing';
import { CedarModule } from '@velajs/authz-cedar/vela';
import { D1PolicyStore } from '@velajs/authz-cedar/d1';
import { PostgresPolicyStore } from '@velajs/authz-cedar/postgres';
import { DurableObjectPolicyStore } from '@velajs/authz-cedar/durable-objects';
import { CryptoService, LocalKeyRing } from '@velajs/crypto';
import { SecretsStoreKeyProvider } from '@velajs/crypto/cloudflare';
import { CryptoModule } from '@velajs/crypto/vela';
import { TenantCrypto } from '@velajs/crypto/tenant';
import { fieldProtection } from '@velajs/crypto/fields';
import { encryptToR2 } from '@velajs/crypto/files';
import { createStorage } from '@velajs/storage';
import { r2Driver } from '@velajs/storage/drivers/r2';
import * as v from 'valibot';
const schema=v.object({id:v.string(),amount:v.number()});
const create=v.object({id:v.string(),amount:v.pipe(v.string(),v.transform(Number))});
const update=v.partial(schema);
const contracts={create,update,response:schema};
const model=defineStandardModel({name:'invoice',tableName:'invoices',schema,id:'client',timestamps:false,fields:{id:{type:'string'},amount:{type:'number'}},contracts});
const input:ContractInput<typeof model.contracts.create>={id:'a',amount:'1'};
const output:ContractOutput<typeof model.contracts.create>={id:'a',amount:1};
const resource=defineResource('invoices',{model,adapter:transactionalMemoryAdapter({store:new MemoryStore(),tableName:'invoices'})});
void resource.execute('create',{body:input});void output;
const serviceBinding=bindCrudService(resource,contracts);
void serviceBinding.create(input).then(result=>{const amount:number=result.data.amount;return amount;});
const store=new MemoryStore();
const database=defineCrudDatabase('main',{handle:store,resources:{invoices:{model,adapter:transactionalMemoryAdapter({store,tableName:'invoices'})}}});
const registry=createCrudDatabaseRegistry([database] as const);
const exactHandle:MemoryStore=registry.get('main').handle;void exactHandle;
// @ts-expect-error The registry retains the literal database name.
registry.get('missing');
const dto=defineDto(create);new ValidationPipe(dto);
declare const d1:D1Database, storage:DurableObjectStorage, bucket:R2Bucket, secret:SecretsStoreSecret;
const secretProvider=new SecretsStoreKeyProvider({activeKeyId:'v2',keys:{v1:secret,v2:secret},cacheTtlMs:1000});
new CryptoService(secretProvider); secretProvider.invalidate('v1');
const nativeStorage=createStorage({driver:r2Driver({bucket})});
const exactBucket:R2Bucket=nativeStorage.raw;void exactBucket;
void nativeStorage.stat('key');void nativeStorage.listMetadata();
new D1TenantRegistryStore(d1);new D1PolicyStore(d1);new DurableObjectTenantRegistryStore(storage);new DurableObjectPolicyStore(storage);
const service=new CryptoService(await LocalKeyRing.fromRaw('v1',{v1:new Uint8Array(32)}));
void encryptToR2(bucket,'key',new ReadableStream<Uint8Array>(),service.forContext({namespace:'app',purpose:'file'}));
void [hmacCursorCodec,durableObjectSqliteAdapter,TenantService,TenantModule,tenantAdmission,runInTenantScope,PostgresTenantRegistryStore,cloudflareCedar,createCedarEngine,defineVocabulary,t,cedarCrudPlan,MemoryPolicyStore,CedarModule,PostgresPolicyStore,CryptoModule,TenantCrypto,fieldProtection];
`,
  );
  const fixture = (await readFile(new URL('tests/crud/fixtures/edge-worker.ts', root), 'utf8'))
    .replace(/\.\.\/\.\.\/\.\.\/packages\/([^/]+)\/dist\/index\.js/g, '@velajs/$1')
    .replace(/\.\.\/\.\.\/\.\.\/packages\/([^/]+)\/dist\/(.*?)\/index\.js/g, '@velajs/$1/$2');
  await writeFile(join(consumer, 'worker.ts'), fixture);
  await writeFile(
    join(consumer, 'wrangler.json'),
    JSON.stringify({
      name: 'vela-edge-consumer',
      main: 'worker.ts',
      compatibility_date: '2026-09-20',
      durable_objects: { bindings: [{ name: 'OBJECTS', class_name: 'EdgeObject' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['EdgeObject'] }],
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'edge',
          database_id: '00000000-0000-0000-0000-000000000000',
        },
      ],
      r2_buckets: [{ binding: 'BUCKET', bucket_name: 'edge-files' }],
    }),
  );
  const run = (command, args) => execFileSync(command, args, { cwd: consumer, stdio: 'inherit' });
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    join(consumer, '.npm-cache'),
  ]);
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit']);
  run('npx', ['--no-install', 'wrangler', 'deploy', '--dry-run', '--outdir', 'worker-bundle']);
  // A separate process imports portable entries with the optional Vela peer absent.
  const vela = join(consumer, 'node_modules/@velajs/vela'),
    hidden = vela + '-disabled';
  await rename(vela, hidden);
  try {
    run('node', [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {CryptoService,LocalKeyRing,encodeBase64Url} from '@velajs/crypto';
    import {SecretsStoreKeyProvider} from '@velajs/crypto/cloudflare';
    import {TenantService,MemoryTenantRegistryStore} from '@velajs/tenant';
    import {defineVocabulary} from '@velajs/authz-cedar/vocabulary';
    import {MemoryPolicyStore,initializeCedar} from '@velajs/authz-cedar';
    await import('@velajs/crypto/files'); await import('@velajs/crypto/fields'); await import('@velajs/crypto/tenant');
    const service=new CryptoService(await LocalKeyRing.fromRaw('key',{key:crypto.getRandomValues(new Uint8Array(32))}));
    const context={namespace:'app',purpose:'test'};
    assert.equal(await service.decryptText(await service.encryptText('roundtrip',context),context),'roundtrip');
    const firstKey=encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    let nextKey=encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const first={get:async()=>firstKey},next={get:async()=>nextKey};
    const old=new CryptoService(new SecretsStoreKeyProvider({activeKeyId:'v1',keys:{v1:first}}));
    const oldEnvelope=await old.encryptText('rotating',context);
    const provider=new SecretsStoreKeyProvider({activeKeyId:'v2',keys:{v1:first,v2:next}});
    const rotated=new CryptoService(provider);
    assert.equal(await rotated.decryptText(oldEnvelope,context),'rotating');
    const updated=await rotated.reencrypt(oldEnvelope,context);
    const retired=new CryptoService(new SecretsStoreKeyProvider({activeKeyId:'v2',keys:{v2:next}}));
    assert.equal(await retired.decryptText(updated,context),'rotating');
    await assert.rejects(()=>retired.decryptText(oldEnvelope,context));
    nextKey=firstKey;provider.invalidate();
    await assert.rejects(()=>provider.current(),error=>error.message==='Secrets Store wrapping key could not be loaded'&&error.cause===undefined);
    const tenant=new TenantService({lookup:new MemoryTenantRegistryStore([{id:'a',name:'A',status:'active',revision:1,settings:{}}]),authorize:()=>true});
    assert.equal(await tenant.run({tenantId:'a',principal:{issuer:'test',subject:'a',principalType:'user'}},scope=>scope.requireTenantId()),'a');
    assert.ok(defineVocabulary);assert.ok(MemoryPolicyStore);assert.ok(initializeCedar);
  `,
    ]);
  } finally {
    await rename(hidden, vela);
  }
  const archives = Object.fromEntries(
    await Promise.all(
      required.map(async (name) => [
        name,
        'sha512-' +
          createHash('sha512')
            .update(await readFile(tarballs[name].slice(5)))
            .digest('base64'),
      ]),
    ),
  );
  const proof = { path: consumer, status: 'passed', archives };
  await writeFile(join(consumer, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(
    'PASS: packed edge capabilities, optional peers, declarations and Worker WASM bundle',
  );
  return proof;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2]);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  await verifyEdgePackages(
    Object.fromEntries(
      manifest.packages.map((entry) => [entry.name, `file:${join(directory, entry.filename)}`]),
    ),
  );
}
