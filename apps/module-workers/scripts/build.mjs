import { build } from 'esbuild';
import { transform } from '@swc/core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const name of ['api', 'catalog', 'accounts', 'jobs']) {
  const result = await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `dist/${name}.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2024',
    metafile: true,
    external: ['cloudflare:*', 'node:*'],
    plugins: [
      {
        name: 'decorators',
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, async (args) => ({
            loader: 'js',
            contents: (
              await transform(await readFile(args.path, 'utf8'), {
                filename: args.path,
                swcrc: false,
                jsc: {
                  target: 'es2022',
                  parser: { syntax: 'typescript', decorators: true },
                  transform: { legacyDecorator: true, decoratorMetadata: true },
                },
              })
            ).code,
          }));
        },
      },
    ],
  });
  await writeFile(`dist/${name}.meta.json`, JSON.stringify(result.metafile));
}
