import { describe, expect, it } from 'vitest';
import { SourceEditError, addExport, addToModule, workerRootImport } from './source-editor.js';

const APP = `import { Module } from '@velajs/vela';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

// Registers the controller and service — café comments keep their offsets.
@Module({
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`;

describe('addToModule', () => {
  it('appends to an existing multi-line list and imports the entry', () => {
    const edit = addToModule('app.module.ts', APP, 'controllers', 'NotesController', {
      imports: [{ name: 'NotesController', from: './notes/notes.controller.js' }],
    });
    expect(edit.changed).toBe(true);
    expect(edit.source).toBe(`import { Module } from '@velajs/vela';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { NotesController } from './notes/notes.controller.js';

// Registers the controller and service — café comments keep their offsets.
@Module({
  controllers: [AppController, NotesController],
  providers: [AppService],
})
export class AppModule {}
`);
  });

  it('adds a missing list after the last property, keeping trailing commas', () => {
    const edit = addToModule('app.module.ts', APP, 'imports', 'NotesModule', {
      imports: [{ name: 'NotesModule', from: './notes/notes.module.js' }],
    });
    expect(edit.source).toContain(`  providers: [AppService],
  imports: [NotesModule],
})`);
  });

  it('extends multi-line arrays with their own indentation and an existing import', () => {
    const source = `import { Module } from '@velajs/vela';
import { QueueModule } from '@velajs/vela/queue';

@Module({
  imports: [
    QueueModule.forRoot({ driver: inline() }),
  ],
})
export class AppModule {}
`;
    const edit = addToModule(
      'app.module.ts',
      source,
      'imports',
      "QueueModule.registerQueue({ name: 'emails', binding: 'EMAILS_QUEUE' })",
      { imports: [{ name: 'QueueModule', from: '@velajs/vela/queue' }] },
    );
    expect(edit.source).toBe(`import { Module } from '@velajs/vela';
import { QueueModule } from '@velajs/vela/queue';

@Module({
  imports: [
    QueueModule.forRoot({ driver: inline() }),
    QueueModule.registerQueue({ name: 'emails', binding: 'EMAILS_QUEUE' }),
  ],
})
export class AppModule {}
`);
  });

  it('fills an empty or argument-less @Module and merges named imports', () => {
    const empty = addToModule(
      'notes.module.ts',
      `import { Module } from '@velajs/vela';\n\n@Module({})\nexport class NotesModule {}\n`,
      'providers',
      'NotesService',
      { imports: [{ name: 'NotesService', from: './notes.service.js' }] },
    );
    expect(empty.source).toBe(
      `import { Module } from '@velajs/vela';\nimport { NotesService } from './notes.service.js';\n\n@Module({ providers: [NotesService] })\nexport class NotesModule {}\n`,
    );
    const bare = addToModule(
      'm.ts',
      `import { Module } from '@velajs/vela';\n@Module()\nexport class M {}\n`,
      'imports',
      'QueueModule.forRoot({ driver: cloudflareQueues() })',
      {
        imports: [
          { name: 'Injectable', from: '@velajs/vela' },
          { name: 'QueueModule', from: '@velajs/vela/queue' },
          { name: 'cloudflareQueues', from: '@velajs/cloudflare/queues' },
        ],
      },
    );
    expect(bare.source).toBe(
      `import { Module, Injectable } from '@velajs/vela';\nimport { QueueModule } from '@velajs/vela/queue';\nimport { cloudflareQueues } from '@velajs/cloudflare/queues';\n@Module({ imports: [QueueModule.forRoot({ driver: cloudflareQueues() })] })\nexport class M {}\n`,
    );
  });

  it('rewrites a single-line list one entry per line once it outgrows the line', () => {
    const source = `@Module({ imports: [QueueModule.forRoot({ driver: cloudflareQueues() }), TodosModule] })\nclass A {}\n`;
    expect(addToModule('a.ts', source, 'imports', 'NotificationsModule').source).toBe(
      `@Module({ imports: [\n  QueueModule.forRoot({ driver: cloudflareQueues() }),\n  TodosModule,\n  NotificationsModule,\n] })\nclass A {}\n`,
    );
  });

  it('leaves the file alone when the entry, or a matching one, is listed', () => {
    expect(addToModule('app.module.ts', APP, 'providers', 'AppService')).toEqual({
      source: APP,
      changed: false,
    });
    const source = `@Module({ imports: [QueueModule.forRootAsync({ useFactory: f })] })\nclass A {}\n`;
    expect(
      addToModule('a.ts', source, 'imports', 'QueueModule.forRoot({})', {
        unless: /^QueueModule\.forRoot(?:Async)?\(/,
      }).changed,
    ).toBe(false);
  });

  it('refuses computed metadata and files without a module class', () => {
    expect(() => addToModule('a.ts', `@Module(metadata)\nclass A {}\n`, 'providers', 'X')).toThrow(
      SourceEditError,
    );
    expect(() =>
      addToModule('a.ts', `@Module({ providers: shared })\nclass A {}\n`, 'providers', 'X'),
    ).toThrow(/not an array literal/);
    expect(() => addToModule('a.ts', `export class A {}\n`, 'providers', 'X')).toThrow(
      /no @Module\(\) class/,
    );
    expect(() => addToModule('a.ts', `@Module({ providers: [ }\n`, 'providers', 'X')).toThrow(
      /Cannot parse a.ts/,
    );
  });
});

describe('Worker entry edits', () => {
  const WORKER = `import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

export default createCloudflareWorker(AppModule);
`;

  it('exports a Durable Object class once', () => {
    const edit = addExport('worker.ts', WORKER, 'Counter', './counter/counter.durable-object.js');
    expect(edit.source).toBe(`import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';
export { Counter } from './counter/counter.durable-object.js';

export default createCloudflareWorker(AppModule);
`);
    expect(addExport('worker.ts', edit.source, 'Counter', './elsewhere.js').changed).toBe(false);
  });

  it('finds the root module createCloudflareWorker() receives', () => {
    expect(workerRootImport('worker.ts', WORKER)).toEqual({
      name: 'AppModule',
      from: './app.module.js',
    });
    expect(workerRootImport('worker.ts', 'export default { fetch() {} };\n')).toBeUndefined();
  });
});
