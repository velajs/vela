import { spawnSync } from 'node:child_process';
import { Command, Option, UsageError } from 'clipanion';
import {
  PACKAGE_MANAGERS,
  TEMPLATES,
  createProject,
  detectPackageManager,
  packageManagerCommands,
  type PackageManager,
  type TemplateName,
} from '../new-project.js';

function oneOf<const Values extends readonly string[]>(
  values: Values,
  value: string,
  flag: string,
): Values[number] {
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new UsageError(`${flag} must be one of: ${values.join(', ')}.`);
  }
  return match;
}

export class NewCommand extends Command {
  static override paths = [['new']];
  static override usage = Command.Usage({
    category: 'Project',
    description: 'Create a Vela application for Cloudflare Workers.',
    details:
      'Creates a directory in the current working directory; an existing directory must be empty. ' +
      '`--template minimal` (default) is one controller and service; `--template api` adds a ' +
      'validated KV resource, a queue processor and a cron job. `--pm` picks the package manager ' +
      'the files and instructions use (default: the one running the command, else pnpm). ' +
      '`--install` installs dependencies and `--git` initializes a repository with a first commit.',
    examples: [
      ['Create an API', 'vela new my-api'],
      [
        'The API template with npm, installed, in Git',
        'vela new my-api --template api --pm npm --install --git',
      ],
    ],
  });

  name = Option.String({ name: 'name', required: true });
  template = Option.String('--template', 'minimal', {
    description: `Starter template: ${TEMPLATES.join(' or ')}.`,
  });
  packageManager = Option.String('--pm', {
    description: `Package manager: ${PACKAGE_MANAGERS.join(', ')}.`,
  });
  install = Option.Boolean('--install', false, { description: 'Install dependencies.' });
  git = Option.Boolean('--git', false, {
    description: 'Initialize a Git repository with an initial commit.',
  });

  async execute(): Promise<number> {
    const template: TemplateName = oneOf(TEMPLATES, this.template, '--template');
    const manager: PackageManager =
      this.packageManager === undefined
        ? detectPackageManager()
        : oneOf(PACKAGE_MANAGERS, this.packageManager, '--pm');
    const directory = await createProject(this.name, process.cwd(), {
      template,
      packageManager: manager,
    });
    const commands = packageManagerCommands(manager);
    const out = this.context.stdout;
    out.write(`Created ${this.name} from the ${template} template.\n`);

    if (this.install) {
      out.write(`\nInstalling dependencies with ${manager}…\n`);
      const status = this.#run(manager, ['install'], directory);
      if (status !== 0) {
        this.context.stderr.write(
          `${commands.install} failed in ${directory}; the project files were kept. Fix the error and run it again.\n`,
        );
        return 1;
      }
    }
    if (this.git) this.#initializeGit(directory);

    out.write(
      `\nNext steps:\n  cd ${this.name}\n${this.install ? '' : `  ${commands.install}\n`}  ${commands.run} dev\n\n` +
        `Then visit http://localhost:5173.\nRun the Worker tests in workerd with: ${commands.run} test\n`,
    );
    return 0;
  }

  #run(command: string, args: string[], cwd: string): number {
    const result = spawnSync(command, args, {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    });
    if (result.error) {
      this.context.stderr.write(`Could not run ${command}: ${result.error.message}\n`);
      return 1;
    }
    return result.status ?? 1;
  }

  #initializeGit(directory: string): void {
    const git = (args: string[]) =>
      spawnSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
    const init = git(['init', '--quiet']);
    if (init.error || init.status !== 0) {
      this.context.stderr.write(
        `Git is unavailable (${init.error?.message ?? init.stderr.trim()}); skipped repository initialization.\n`,
      );
      return;
    }
    const add = git(['add', '--all']);
    const commit =
      add.status === 0 ? git(['commit', '--quiet', '-m', 'chore: initial commit']) : add;
    if (commit.status === 0) {
      this.context.stdout.write('Initialized a Git repository with an initial commit.\n');
    } else {
      this.context.stderr.write(
        `Initialized a Git repository, but the initial commit failed: ${commit.stderr.trim()}\n`,
      );
    }
  }
}
