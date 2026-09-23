import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The published surface is tiered: the root is the application kit, module and
 * adapter authors use `/module-kit`, framework plumbing lives on `/internal`,
 * and optional features have their own subpaths. These checks run against the
 * built package, the way a consumer resolves it.
 */
const PACKAGE_ROOT = join(__dirname, '..', '..');

interface ExportTarget {
  types: string;
  import: string;
}

interface Manifest {
  exports: Record<string, ExportTarget>;
  sideEffects: string[];
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Manifest;
const tsdownConfig = readFileSync(join(PACKAGE_ROOT, 'tsdown.config.ts'), 'utf8');

function sourceOf(target: ExportTarget): string {
  return target.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts');
}

/** Names a built declaration entry exports, types included. */
function declaredNames(target: ExportTarget): string[] {
  const declaration = readFileSync(join(PACKAGE_ROOT, target.types), 'utf8');
  const names: string[] = [];
  for (const match of declaration.matchAll(
    /^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s+[^;]+)?;/gmu,
  )) {
    for (const entry of match[1].split(',')) {
      const name = entry
        .trim()
        .replace(/^type\s+/u, '')
        .split(/\s+as\s+/u)
        .at(-1)
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

async function runtimeEntry(subpath: string): Promise<Record<string, unknown>> {
  const target = manifest.exports[subpath];
  if (!target) throw new Error(`package.json#exports has no "${subpath}"`);
  return (await import(join(PACKAGE_ROOT, target.import))) as Record<string, unknown>;
}

const APP_KIT = [
  'VelaFactory',
  'VelaApplication',
  'ENV',
  'InjectEnv',
  'Injectable',
  'Inject',
  'Optional',
  'InjectionToken',
  'forwardRef',
  'ModuleRef',
  'defineProvider',
  'Scope',
  'Module',
  'Global',
  'defineModule',
  'ConfigurableModuleBuilder',
  'Controller',
  'Get',
  'Post',
  'Body',
  'Param',
  'Query',
  'createParamDecorator',
  'applyDecorators',
  'UseGuards',
  'UsePipes',
  'UseInterceptors',
  'UseFilters',
  'Catch',
  'SetMetadata',
  'Reflector',
  'APP_GUARD',
  'APP_FILTER',
  'ParseIntPipe',
  'HttpException',
  'NotFoundException',
  'ErrorsModule',
  'VelaError',
  'ConfigModule',
  'ConfigService',
  'registerAs',
  'Logger',
  'REQUEST_CONTEXT',
  'EXECUTION_LIFETIME',
];

const MODULE_KIT = [
  'Container',
  'MetadataRegistry',
  'DiscoveryService',
  'createDiscoverableDecorator',
  'registerEntrypointKind',
  'EntrypointRegistry',
  'runInEntrypointScope',
  'PipelineRunner',
  'invokeScheduledJob',
  'assertFactoryInject',
  'describeToken',
  'defineMetadata',
  'getMetadata',
  'METADATA_KEYS',
  'registerRouteContributor',
  'getRequestContainer',
  'setTrustedRequestIdentity',
  'resolveErrorReporter',
  'lazyProvider',
  'stableHash',
];

const FEATURES: Record<string, string[]> = {
  './cache': ['CacheModule', 'ResponseCacheModule', 'CacheResponse', 'Cacheable'],
  './throttler': ['ThrottlerModule', 'ThrottlerGuard', 'Throttle', 'SkipThrottle'],
  './schedule': ['ScheduleModule', 'ScheduleRegistry', 'Cron', 'Interval', 'parseCron'],
  './events': ['EventEmitterModule', 'EventEmitter', 'OnEvent', 'defineEvent', 'EventDispatcher'],
  './health': ['HealthModule', 'HealthCheckService', 'HealthIndicatorService'],
  './security': ['SecurityModule', 'Secret', 'CorsModule', 'signUrl', 'NONCE_STORE'],
  './logging': ['LoggingModule', 'ApplicationLogger', 'APP_LOGGER', 'loggerForScope'],
  './openapi': ['createOpenApiDocument', 'Endpoint', 'defineEndpoint', 'ApiDoc', 'ApiResponse'],
  './dispatch': ['InternalDispatcher', 'SignedInvocation', 'INVOCATION_SIGNING_SECRET'],
  './http-client': ['HttpModule', 'HttpService', 'HttpRequestException'],
  './validation': ['ValidationPipe', 'defineDto', 'parseSchema'],
  './websocket': ['WebSocketModule', 'WebSocketGateway', 'SubscribeMessage', 'WsException'],
};

describe('public surface tiers', () => {
  it('keeps the application kit on the root entry', async () => {
    const root = await runtimeEntry('.');
    expect(APP_KIT.filter((name) => !(name in root))).toEqual([]);
  });

  it('moves module-author seams to @velajs/vela/module-kit', async () => {
    const root = await runtimeEntry('.');
    const moduleKit = await runtimeEntry('./module-kit');
    expect(MODULE_KIT.filter((name) => !(name in moduleKit))).toEqual([]);
    expect(MODULE_KIT.filter((name) => name in root)).toEqual([]);
  });

  it('moves framework plumbing to @velajs/vela/internal', async () => {
    const root = await runtimeEntry('.');
    const internal = await runtimeEntry('./internal');
    const plumbing = [
      'bootstrap',
      'RouteManager',
      'ModuleLoader',
      'ComponentManager',
      'ConfigStore',
    ];
    expect(plumbing.filter((name) => !(name in internal))).toEqual([]);
    expect(plumbing.filter((name) => name in root)).toEqual([]);
  });

  it('serves each optional feature from its own subpath only', async () => {
    const root = await runtimeEntry('.');
    for (const [subpath, names] of Object.entries(FEATURES)) {
      const feature = await runtimeEntry(subpath);
      expect({ subpath, missing: names.filter((name) => !(name in feature)) }).toEqual({
        subpath,
        missing: [],
      });
      expect({ subpath, onRoot: names.filter((name) => name in root) }).toEqual({
        subpath,
        onRoot: [],
      });
    }
  });

  it('exports every name, types included, from exactly one entry', () => {
    const homes = new Map<string, string[]>();
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      for (const name of declaredNames(target)) {
        homes.set(name, [...(homes.get(name) ?? []), subpath]);
      }
    }
    expect(homes.size).toBeGreaterThan(400);
    const duplicates = [...homes].filter(([, subpaths]) => subpaths.length > 1);
    expect(duplicates).toEqual([]);
  });

  it('builds, and declares the side effects of, every public entry', () => {
    const missingBuild: string[] = [];
    const sideEffectMismatch: string[] = [];
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const source = sourceOf(target);
      if (!tsdownConfig.includes(`'${source}'`)) missingBuild.push(`${subpath}: tsdown ${source}`);
      if (!existsSync(join(PACKAGE_ROOT, target.import))) missingBuild.push(target.import);
      if (!existsSync(join(PACKAGE_ROOT, target.types))) missingBuild.push(target.types);
      // An entry that installs the Reflect polyfill must be declared
      // side-effectful, or bundlers drop the polyfill import with it.
      const installsPolyfill = /^import '\.{1,2}\/metadata';$/mu.test(
        readFileSync(join(PACKAGE_ROOT, source), 'utf8'),
      );
      if (installsPolyfill !== manifest.sideEffects.includes(target.import)) {
        sideEffectMismatch.push(`${subpath} (polyfill: ${installsPolyfill})`);
      }
    }
    expect(missingBuild).toEqual([]);
    expect(sideEffectMismatch).toEqual([]);
  });

  it('keeps the Reflect polyfill import in every built entry that declares it', () => {
    // The build must not tree-shake the bare `import './metadata'`: without it
    // an application importing only this entry never installs Reflect.metadata,
    // and constructor parameter types emitted by its compiler are lost.
    const dropped = Object.entries(manifest.exports)
      .filter(([, target]) =>
        /^import '\.{1,2}\/metadata';$/mu.test(
          readFileSync(join(PACKAGE_ROOT, sourceOf(target)), 'utf8'),
        ),
      )
      .filter(
        ([, target]) =>
          !/^import(?:\s*\{[^}]*\}\s*from)?\s*"(?:\.\/|\.\.\/)metadata\.js";$/mu.test(
            readFileSync(join(PACKAGE_ROOT, target.import), 'utf8'),
          ),
      )
      .map(([subpath]) => subpath);
    expect(dropped).toEqual([]);
  });

  it('installs the Reflect polyfill from every entry that ships decorated classes', () => {
    const withoutDecorators = new Set([
      './observability',
      './storage',
      './streaming',
      './websocket-node',
    ]);
    const missing = Object.entries(manifest.exports)
      .filter(([subpath]) => !withoutDecorators.has(subpath))
      .filter(
        ([, target]) =>
          !/^import '\.{1,2}\/metadata';$/mu.test(
            readFileSync(join(PACKAGE_ROOT, sourceOf(target)), 'utf8'),
          ),
      )
      .map(([subpath]) => subpath);
    expect(missing).toEqual([]);
  });
});
