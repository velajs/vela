import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Command, Option } from 'clipanion';
import { loadConfig } from '../config.js';
import { collectEntrypoints } from '../introspect.js';
import { readInput } from '../project/files.js';
import { findWranglerConfig } from '../project/wrangler.js';
import { withApp } from '../with-app.js';
import { parseDeploymentConfig } from './deploy-check.config.js';
import { checkDeployment, type DeploymentIssue } from './deploy-check.plan.js';

const exec = promisify(execFile);

async function gitProvenance(cwd: string) {
  try {
    const options = { cwd, timeout: 5000, maxBuffer: 1024 * 1024 };
    const [head, status] = await Promise.all([
      exec('git', ['rev-parse', '--verify', 'HEAD'], options),
      exec(
        'git',
        [
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          'status',
          '--porcelain=v1',
          '--untracked-files=normal',
        ],
        options,
      ),
    ]);
    const commit = head.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error('Invalid git commit.');
    return { commit, dirty: status.stdout.length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The explicit Wrangler file, or the one in the working directory. */
async function wranglerFile(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) return resolve(explicit);
  const found = await findWranglerConfig(process.cwd());
  if (found.path === undefined) {
    throw new Error(
      `No Wrangler configuration found (checked ${found.candidates.join(', ')}). Pass --config <file>.`,
    );
  }
  return found.path;
}

const quote = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`;

const VITE_CONFIGS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].map(
  (extension) => `vite.config.${extension}`,
);
// The Wrangler files the Cloudflare Vite plugin reads when its `configPath` is unset.
const DEFAULT_WRANGLER_FILES = new Set(['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']);

/**
 * Whether the Cloudflare Vite plugin builds this Worker: a Vite build left the
 * redirect that plain `wrangler deploy` follows, or a Vite config beside the
 * Wrangler file references `@cloudflare/vite-plugin`. Config files are read as
 * text, never imported.
 */
async function buildsWithVite(directory: string): Promise<boolean> {
  const redirect = await stat(join(directory, '.wrangler', 'deploy', 'config.json')).then(
    (entry) => entry.isFile(),
    () => false,
  );
  if (redirect) return true;
  const configs = await Promise.all(
    VITE_CONFIGS.map((name) =>
      readInput(join(directory, name)).then(
        (text) => text.includes('@cloudflare/vite-plugin'),
        () => false,
      ),
    ),
  );
  return configs.includes(true);
}

/** Deployment preflight: compares a Wrangler target with the application's entrypoints. */
export class DeployCheckCommand extends Command {
  static override paths = [['deploy', 'check']];
  static override usage = Command.Usage({
    category: 'Deployment',
    description: 'Check a Wrangler target against the application entrypoints.',
    details:
      'Compares cron triggers, queue producers and consumers, and WebSocket Durable Object bindings of the Wrangler file in the working directory (or --config), at the top level or in the --env environment, and rejects directly dispatched cron jobs that declare guards. Without --entrypoints, the CLI builds the application from vela.config or the Worker entry with the Wrangler `vars` only (no bindings or secrets) and reads its entrypoints; with a saved `vela entrypoint list --json` snapshot, no application code is imported. Never runs a custom build, loads credentials or uploads. Wrangler remains the deployment tool. The suggested next step runs in the Wrangler file directory. For a project the Cloudflare Vite plugin builds (a vite.config.* beside the Wrangler file that references @cloudflare/vite-plugin, or the .wrangler/deploy/config.json redirect a Vite build writes), it builds the environment with Vite and dry-runs that build with the same --env, since `wrangler deploy --config` would bundle the source with esbuild, which emits no decorator metadata.',
    examples: [
      ['Check the top-level Worker', 'vela deploy check'],
      [
        'Check staging against a saved snapshot',
        'vela deploy check --config wrangler.jsonc --env staging --entrypoints entrypoints.json',
      ],
    ],
  });

  config = Option.String('--config', {
    description: 'Wrangler .json/.jsonc/.toml file (default: the one in the working directory).',
  });
  environment = Option.String('--env', {
    description: 'Named Wrangler environment (default: the top-level configuration).',
  });
  entrypoints = Option.String('--entrypoints', {
    description: 'Saved `vela entrypoint list --json` array (default: computed from the app).',
  });
  json = Option.Boolean('--json', false, { description: 'Emit the redacted report as JSON.' });

  async execute(): Promise<number> {
    try {
      if (this.config?.trim() === '' || this.entrypoints?.trim() === '')
        throw new Error('--config and --entrypoints must name files.');
      const configPath = await wranglerFile(this.config);
      const cwd = dirname(configPath);
      const config = await readInput(configPath);
      const raw = parseDeploymentConfig(config, configPath);
      let snapshot: string;
      let snapshotPath: string | null = null;
      if (this.entrypoints === undefined) {
        const loaded = await loadConfig(cwd, undefined, {
          environment: this.environment,
          wrangler: configPath,
        });
        const rows = await withApp(
          loaded,
          collectEntrypoints,
          (message) => this.context.stderr.write(`${message}\n`),
          this.context.stderr,
        );
        snapshot = JSON.stringify(rows);
      } else {
        snapshotPath = resolve(this.entrypoints);
        snapshot = await readInput(snapshotPath);
      }
      let rows: unknown;
      try {
        rows = JSON.parse(snapshot);
      } catch {
        throw new Error('Invalid entrypoint snapshot JSON.');
      }
      const plan = checkDeployment(raw, this.environment, rows);
      const provenance = {
        ...(await gitProvenance(cwd)),
        checkedAt: new Date().toISOString(),
        config: { path: configPath, sha256: digest(config) },
        entrypoints: {
          path: snapshotPath,
          ...(snapshotPath === null ? { computed: true } : {}),
          sha256: digest(snapshot),
        },
      };
      // A Vite project builds one environment into the output that plain
      // `wrangler deploy` follows; `--config` would bypass that build, and
      // Wrangler checks `--env` against the environment the build targeted.
      // `pnpm` resolves the project's own scripts and Wrangler from `cwd`.
      const vite = await buildsWithVite(cwd);
      const envArgs = this.environment === undefined ? [] : ['--env', this.environment];
      const wrangler = vite
        ? {
            build: {
              command: 'pnpm',
              args: ['build'],
              ...(this.environment === undefined
                ? {}
                : { env: { CLOUDFLARE_ENV: this.environment } }),
              cwd,
            },
            command: 'pnpm',
            args: ['exec', 'wrangler', 'deploy', ...envArgs, '--dry-run'],
            cwd,
          }
        : {
            command: 'pnpm',
            args: ['exec', 'wrangler', 'deploy', '--config', configPath, ...envArgs, '--dry-run'],
            cwd,
          };
      const file = basename(configPath);
      const warnings: DeploymentIssue[] = [...plan.warnings];
      if (vite && !DEFAULT_WRANGLER_FILES.has(file))
        warnings.push({
          code: 'vite-config-path',
          message: `The Cloudflare Vite plugin reads wrangler.json, wrangler.jsonc or wrangler.toml by default; set its configPath to ${JSON.stringify(`./${file}`)} so the build uses the checked file.`,
        });
      const result = { ...plan, warnings, provenance, nextStep: wrangler };
      if (this.json) this.context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        this.context.stdout.write(
          `Deployment check: ${plan.status}\nWorker: ${plan.target.worker}\nEnvironment: ${plan.target.environment ?? '(top level)'}\nConfig: ${configPath}\nCommit: ${provenance.commit ?? 'unavailable'} (${provenance.dirty === null ? 'cleanliness unknown' : provenance.dirty ? 'dirty' : 'clean'})\nConfig SHA-256: ${provenance.config.sha256}\nSnapshot SHA-256: ${provenance.entrypoints.sha256}${snapshotPath === null ? ' (computed from the application)' : ''}\nBindings: ${plan.target.bindings.map((binding) => `${binding.name} (${binding.kind})`).join(', ') || '(none)'}\n`,
        );
        for (const issue of plan.errors)
          this.context.stdout.write(`Error [${issue.code}]: ${issue.message}\n`);
        for (const issue of warnings)
          this.context.stdout.write(`Warning [${issue.code}]: ${issue.message}\n`);
        // The environment name is validated to letters, digits, `_` and `-`.
        const next = vite
          ? this.environment === undefined
            ? 'pnpm build && pnpm exec wrangler deploy --dry-run'
            : `CLOUDFLARE_ENV=${this.environment} pnpm build && pnpm exec wrangler deploy --env ${this.environment} --dry-run`
          : [wrangler.command, ...wrangler.args].map(quote).join(' ');
        this.context.stdout.write(`Next step (not executed): cd ${quote(cwd)} && ${next}\n`);
      }
      return plan.status === 'passed' ? 0 : 1;
    } catch (error) {
      // Filesystem errors contain paths, not file contents; parser/schema errors are sanitized above.
      const message = error instanceof Error ? error.message : 'Deployment check failed.';
      if (this.json)
        this.context.stdout.write(`${JSON.stringify({ status: 'failed', error: message })}\n`);
      else this.context.stderr.write(`${message}\n`);
      return 1;
    }
  }
}
