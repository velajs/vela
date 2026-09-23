#!/usr/bin/env node
import { Builtins, Cli } from 'clipanion';
import manifest from '../package.json' with { type: 'json' };
import {
  EntrypointListCommand,
  ModuleGraphCommand,
  OpenApiDumpCommand,
  RouteListCommand,
} from './commands/introspect.commands.js';
import { McpServeCommand } from './commands/mcp.command.js';
import { SeedCommand } from './commands/seed.command.js';
import { StudioCommand } from './commands/studio.command.js';
import { ClientGenerateCommand } from './commands/client.command.js';
import { NewCommand } from './commands/new.command.js';
import { DoctorCommand } from './commands/doctor.command.js';
import { DeployCheckCommand } from './commands/deploy-check.command.js';

const cli = new Cli({
  binaryName: 'vela',
  binaryLabel: 'Vela CLI',
  binaryVersion: manifest.version,
});

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);
cli.register(NewCommand);
cli.register(SeedCommand);
cli.register(RouteListCommand);
cli.register(ModuleGraphCommand);
cli.register(EntrypointListCommand);
cli.register(OpenApiDumpCommand);
cli.register(McpServeCommand);
cli.register(StudioCommand);
cli.register(ClientGenerateCommand);
cli.register(DoctorCommand);
cli.register(DeployCheckCommand);

void cli.runExit(process.argv.slice(2));

export { SeedCommand } from './commands/seed.command.js';
export { NewCommand } from './commands/new.command.js';
export {
  EntrypointListCommand,
  ModuleGraphCommand,
  OpenApiDumpCommand,
  RouteListCommand,
} from './commands/introspect.commands.js';
export { McpServeCommand } from './commands/mcp.command.js';
export { StudioCommand } from './commands/studio.command.js';
export { ClientGenerateCommand } from './commands/client.command.js';
export { DoctorCommand } from './commands/doctor.command.js';
export { DeployCheckCommand } from './commands/deploy-check.command.js';
export { generateClientContract } from './client-contract.js';
export type { GeneratedClientContract } from './client-contract.js';
export {
  collectRoutes,
  collectModules,
  collectEntrypoints,
  renderModuleTree,
} from './introspect.js';
export type { RouteRow, EntrypointRow } from './introspect.js';
export { renderTable } from './format.js';
export { loadConfig, defineVelaConfig, resolveConfig } from './config.js';
export type { VelaConfig, ConfigResolution, LoadedVelaConfig } from './config.js';
export { formatSeedResults } from './format.js';
