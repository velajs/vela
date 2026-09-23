import { Command, Option } from 'clipanion';
import { createProject } from '../new-project.js';

export class NewCommand extends Command {
  static override paths = [['new']];
  static override usage = Command.Usage({
    category: 'Project',
    description: 'Create a minimal Vela application for Cloudflare Workers.',
    details:
      'Creates a directory in the current working directory. An existing directory must be empty. Dependencies are installed separately with pnpm install.',
    examples: [['Create an API', 'vela new my-api']],
  });

  name = Option.String({ name: 'name', required: true });

  async execute(): Promise<number> {
    await createProject(this.name, process.cwd());
    this.context.stdout.write(
      `Created ${this.name}.\n\nNext steps:\n  cd ${this.name}\n  pnpm install\n  pnpm dev\n\nThen visit http://localhost:5173 or run: curl http://localhost:5173\nRun the Worker tests in workerd with: pnpm test\n`,
    );
    return 0;
  }
}
