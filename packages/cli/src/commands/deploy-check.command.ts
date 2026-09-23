import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Command, Option } from 'clipanion';
import { parseDeploymentConfig } from './deploy-check.config.js';
import { checkDeployment, type DeploymentIssue } from './deploy-check.plan.js';

const exec = promisify(execFile);
const MAX_INPUT_BYTES = 1024 * 1024;

async function readInput(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Input must be a regular file.');
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      // eslint-disable-next-line no-await-in-loop -- Each offset depends on the preceding partial read.
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_INPUT_BYTES) throw new Error('Deployment inputs must not exceed 1 MiB.');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

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

/** Static application deployment preflight; never invokes Wrangler or application code. */
export class DeployCheckCommand extends Command {
  static override paths = [['deploy', 'check']];
  static override usage = Command.Usage({
    category: 'Deployment',
    description: 'Check an explicit Wrangler target against a saved entrypoint snapshot.',
    details:
      'Read-only: no app bootstrap, custom build, credential loading or upload. Compares cron triggers, queue producers and consumers, and WebSocket Durable Object bindings, and rejects directly dispatched cron jobs that declare guards. Wrangler remains the deployment tool. The suggested next step runs in the Wrangler file directory. For a project the Cloudflare Vite plugin builds (a vite.config.* beside the Wrangler file that references @cloudflare/vite-plugin, or the .wrangler/deploy/config.json redirect a Vite build writes), it builds the environment with Vite and dry-runs that build with the same --env, since `wrangler deploy --config` would bundle the source with esbuild, which emits no decorator metadata.',
    examples: [
      [
        'Check staging',
        'vela deploy check --config wrangler.jsonc --env staging --entrypoints entrypoints.json',
      ],
    ],
  });

  config = Option.String('--config', {
    required: true,
    description: 'Explicit Wrangler .json/.jsonc/.toml file.',
  });
  environment = Option.String('--env', {
    required: true,
    description: 'Exact named environment in the Wrangler file.',
  });
  entrypoints = Option.String('--entrypoints', {
    required: true,
    description: 'Saved vela entrypoint list --json array.',
  });
  json = Option.Boolean('--json', false, { description: 'Emit the redacted report as JSON.' });

  async execute(): Promise<number> {
    try {
      if (!this.config.trim() || !this.entrypoints.trim())
        throw new Error('Explicit configuration and snapshot paths are required.');
      const configPath = resolve(this.config);
      const snapshotPath = resolve(this.entrypoints);
      const [config, snapshot] = await Promise.all([
        readInput(configPath),
        readInput(snapshotPath),
      ]);
      let rows: unknown;
      try {
        rows = JSON.parse(snapshot);
      } catch {
        throw new Error('Invalid entrypoint snapshot JSON.');
      }
      const plan = checkDeployment(
        parseDeploymentConfig(config, configPath),
        this.environment,
        rows,
      );
      const provenance = {
        ...(await gitProvenance(dirname(configPath))),
        checkedAt: new Date().toISOString(),
        config: { path: configPath, sha256: digest(config) },
        entrypoints: { path: snapshotPath, sha256: digest(snapshot) },
      };
      // A Vite project builds one environment into the output that plain
      // `wrangler deploy` follows; `--config` would bypass that build, and
      // Wrangler checks `--env` against the environment the build targeted.
      // `pnpm` resolves the project's own scripts and Wrangler from `cwd`.
      const cwd = dirname(configPath);
      const vite = await buildsWithVite(cwd);
      const wrangler = vite
        ? {
            build: {
              command: 'pnpm',
              args: ['build'],
              env: { CLOUDFLARE_ENV: this.environment },
              cwd,
            },
            command: 'pnpm',
            args: ['exec', 'wrangler', 'deploy', '--env', this.environment, '--dry-run'],
            cwd,
          }
        : {
            command: 'pnpm',
            args: [
              'exec',
              'wrangler',
              'deploy',
              '--config',
              configPath,
              '--env',
              this.environment,
              '--dry-run',
            ],
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
          `Deployment check: ${plan.status}\nWorker: ${plan.target.worker}\nEnvironment: ${plan.target.environment}\nConfig: ${configPath}\nCommit: ${provenance.commit ?? 'unavailable'} (${provenance.dirty === null ? 'cleanliness unknown' : provenance.dirty ? 'dirty' : 'clean'})\nConfig SHA-256: ${provenance.config.sha256}\nSnapshot SHA-256: ${provenance.entrypoints.sha256}\nBindings: ${plan.target.bindings.map((binding) => `${binding.name} (${binding.kind})`).join(', ') || '(none)'}\n`,
        );
        for (const issue of plan.errors)
          this.context.stdout.write(`Error [${issue.code}]: ${issue.message}\n`);
        for (const issue of warnings)
          this.context.stdout.write(`Warning [${issue.code}]: ${issue.message}\n`);
        // The environment name is validated to letters, digits, `_` and `-`.
        const next = vite
          ? `CLOUDFLARE_ENV=${this.environment} pnpm build && pnpm exec wrangler deploy --env ${this.environment} --dry-run`
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
