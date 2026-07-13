import { readFile, writeFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const skillUrl = new URL('../.agents/skills/vela/SKILL.md', import.meta.url);
const skill = await readFile(skillUrl, 'utf8');
const updated = skill.replace(/^\s*version:.*$/m, `  version: "${packageJson.version}"`);

if (updated === skill) {
  throw new Error('Could not find the Vela skill version field.');
}

await writeFile(skillUrl, updated);
