import { describe, expect, it } from 'vitest';
import {
  SourceEditError,
  addDeclaration,
  addExport,
  addToModule,
  moduleExport,
  workerRootImport,
} from './source-editor.js';

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

  it('appends on the line instead of reflowing a list with comments', () => {
    const source = `@Module({ imports: [QueueModule.forRoot({ driver: cloudflareQueues() }), /* keep me */ TodosModule] })\nclass A {}\n`;
    expect(addToModule('a.ts', source, 'imports', 'NotificationsModule').source).toBe(
      `@Module({ imports: [QueueModule.forRoot({ driver: cloudflareQueues() }), /* keep me */ TodosModule, NotificationsModule] })\nclass A {}\n`,
    );
  });

  it('adds a list on the line of the last property when that property does not start a line', () => {
    const source = `@Module({ imports: [QueueModule.forRoot({ driver: cloudflareQueues() }), TodosModule] })\nclass A {}\n`;
    const reflowed = addToModule('a.ts', source, 'imports', 'NotificationsModule').source;
    expect(addToModule('a.ts', reflowed, 'providers', 'FooService').source).toBe(
      `@Module({ imports: [\n  QueueModule.forRoot({ driver: cloudflareQueues() }),\n  TodosModule,\n  NotificationsModule,\n], providers: [FooService] })\nclass A {}\n`,
    );
  });

  it('keeps a comment trailing the last entry on that entry', () => {
    const list = `@Module({\n  imports: [\n    A, // first\n  ],\n})\nclass M {}\n`;
    expect(addToModule('m.ts', list, 'imports', 'B').source).toBe(
      `@Module({\n  imports: [\n    A, // first\n    B,\n  ],\n})\nclass M {}\n`,
    );
    const uncommaed = `@Module({\n  imports: [\n    A // first\n  ],\n})\nclass M {}\n`;
    expect(addToModule('m.ts', uncommaed, 'imports', 'B').source).toBe(
      `@Module({\n  imports: [\n    A, // first\n    B\n  ],\n})\nclass M {}\n`,
    );
    const block = `@Module({\n  imports: [\n    A /* first */ , /* after\n    the comma */\n  ],\n})\nclass M {}\n`;
    expect(addToModule('m.ts', block, 'imports', 'B').source).toBe(
      `@Module({\n  imports: [\n    A /* first */ , /* after\n    the comma */\n    B,\n  ],\n})\nclass M {}\n`,
    );
    const property = `@Module({\n  imports: [A], // deps\n})\nclass M {}\n`;
    expect(addToModule('m.ts', property, 'providers', 'S').source).toBe(
      `@Module({\n  imports: [A], // deps\n  providers: [S],\n})\nclass M {}\n`,
    );
    const uncommaedProperty = `@Module({\n  imports: [A] // deps\n})\nclass M {}\n`;
    expect(addToModule('m.ts', uncommaedProperty, 'providers', 'S').source).toBe(
      `@Module({\n  imports: [A], // deps\n  providers: [S]\n})\nclass M {}\n`,
    );
    const inline = `@Module({ imports: [A /* first */] })\nclass M {}\n`;
    expect(addToModule('m.ts', inline, 'imports', 'B').source).toBe(
      `@Module({ imports: [A /* first */, B] })\nclass M {}\n`,
    );
  });

  it('edits the module class the file exports, or the one named', () => {
    const source = `import { Module } from '@velajs/vela';

@Module({ providers: [] })
class InternalModule {}

@Module({ imports: [InternalModule] })
export class AppModule {}
`;
    const exported = addToModule('app.module.ts', source, 'providers', 'FooService').source;
    expect(exported).toContain('@Module({ providers: [] })\nclass InternalModule {}');
    expect(exported).toContain(
      '@Module({ imports: [InternalModule], providers: [FooService] })\nexport class AppModule {}',
    );
    const named = addToModule('app.module.ts', source, 'providers', 'FooService', {
      module: 'InternalModule',
    }).source;
    expect(named).toContain('@Module({ providers: [FooService] })\nclass InternalModule {}');
    const renamed = `@Module({})\nclass Root {}\n@Module({})\nclass Helper {}\nexport { Root as AppModule };\n`;
    expect(
      addToModule('app.module.ts', renamed, 'providers', 'X', { module: 'AppModule' }).source,
    ).toContain('@Module({ providers: [X] })\nclass Root {}');
    expect(() =>
      addToModule(
        'a.ts',
        `@Module({})\nexport class A {}\n@Module({})\nexport class B {}\n`,
        'providers',
        'X',
      ),
    ).toThrow(/several @Module\(\) classes \(A, B\)/);
    expect(() => addToModule('a.ts', source, 'providers', 'X', { module: 'Missing' })).toThrow(
      /no @Module\(\) class Missing/,
    );
  });

  it('edits the class a default export names, else the only module class', () => {
    const declared = `import { Module } from '@velajs/vela';

@Module({ providers: [] })
class AppModule {}

export default AppModule;
`;
    expect(
      addToModule('app.module.ts', declared, 'providers', 'X', { module: 'default' }).source,
    ).toContain('@Module({ providers: [X] })\nclass AppModule {}');
    const helper = `@Module({})\nclass Helper {}\n@Module({})\nclass Root {}\n`;
    for (const exported of ['export default Root;\n', 'export { Root as default };\n']) {
      const edited = addToModule('app.module.ts', `${helper}${exported}`, 'providers', 'X', {
        module: 'default',
      }).source;
      expect(edited).toContain('@Module({})\nclass Helper {}');
      expect(edited).toContain('@Module({ providers: [X] })\nclass Root {}');
    }
    // Exported in a way the file does not spell out: its only module class.
    const assigned = `@Module({})\nclass Root {}\nexport const AppModule = Root;\n`;
    expect(
      addToModule('app.module.ts', assigned, 'providers', 'X', { module: 'AppModule' }).source,
    ).toContain('@Module({ providers: [X] })\nclass Root {}');
    expect(() =>
      addToModule('app.module.ts', `${helper}export const AppModule = Root;\n`, 'providers', 'X', {
        module: 'AppModule',
      }),
    ).toThrow(/no @Module\(\) class AppModule/);
  });

  it('turns a type-only import of a name it registers into a value import', () => {
    const declared = addToModule(
      'app.module.ts',
      `import { Module } from '@velajs/vela';\nimport type { QueueClient, QueueModule } from '@velajs/vela/queue';\n\n@Module({})\nexport class AppModule {}\n`,
      'imports',
      'QueueModule.forRoot({ driver: cloudflareQueues() })',
      {
        imports: [
          { name: 'QueueModule', from: '@velajs/vela/queue' },
          { name: 'cloudflareQueues', from: '@velajs/cloudflare/queues' },
        ],
      },
    ).source;
    expect(declared).toContain(
      "import { type QueueClient, QueueModule } from '@velajs/vela/queue';\nimport { cloudflareQueues } from '@velajs/cloudflare/queues';",
    );
    const inline = addToModule(
      'app.module.ts',
      `import { Module, type ENV } from '@velajs/vela';\nimport { type QueueModule } from '@velajs/vela/queue';\n\n@Module({})\nexport class AppModule {}\n`,
      'imports',
      'QueueModule.registerQueue({ name: "emails" })',
      { imports: [{ name: 'QueueModule', from: '@velajs/vela/queue' }] },
    ).source;
    expect(inline).toContain(
      "import { Module, type ENV } from '@velajs/vela';\nimport { QueueModule } from '@velajs/vela/queue';",
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

  it('refuses metadata whose spread or computed key may set the list', () => {
    for (const source of [
      // A new `imports` after the spread would replace the list it holds.
      `@Module({ ...shared, controllers: [AppController] })\nclass A {}\n`,
      `@Module({ ...jobs })\nclass A {}\n`,
      `@Module({ [key]: [], controllers: [AppController] })\nclass A {}\n`,
      // A spread or computed key after the list may replace it.
      `@Module({ imports: [OpenApiModule], ...shared })\nclass A {}\n`,
      `@Module({\n  imports: [OpenApiModule],\n  ['imports']: [],\n})\nclass A {}\n`,
    ]) {
      expect(() => addToModule('a.ts', source, 'imports', 'BindingsModule'), source).toThrow(
        'a.ts: a spread or computed key in @Module() may set imports; register BindingsModule yourself.',
      );
    }
    // A list written after the spread is the one the module gets.
    expect(
      addToModule(
        'a.ts',
        `@Module({ ...shared, imports: [OpenApiModule] })\nclass A {}\n`,
        'imports',
        'BindingsModule',
      ).source,
    ).toBe(`@Module({ ...shared, imports: [OpenApiModule, BindingsModule] })\nclass A {}\n`);
  });
});

describe('moduleExport', () => {
  it('finds a class the file declares, under its name or the one it exports', () => {
    expect(moduleExport('app.module.ts', APP, 'AppModule')).toEqual({ kind: 'declared' });
    expect(
      moduleExport(
        'app.module.ts',
        '@Module({})\nclass Root {}\nexport default Root;\n',
        'default',
      ),
    ).toEqual({ kind: 'declared' });
  });

  it('follows a re-export to the relative file it names', () => {
    expect(
      moduleExport(
        'app.module.ts',
        "export { AppModule } from './core/root.module.js';\n",
        'AppModule',
      ),
    ).toEqual({ kind: 'reexported', from: { name: 'AppModule', from: './core/root.module.js' } });
    expect(
      moduleExport(
        'app.module.ts',
        "export { default as AppModule } from './root.module.js';\n",
        'AppModule',
      ),
    ).toEqual({ kind: 'reexported', from: { name: 'default', from: './root.module.js' } });
    expect(
      moduleExport(
        'app.module.ts',
        "import { Root } from './root.module.js';\nexport { Root as AppModule };\n",
        'AppModule',
      ),
    ).toEqual({ kind: 'reexported', from: { name: 'Root', from: './root.module.js' } });
    expect(
      moduleExport(
        'app.module.ts',
        "import Root from './root.module.js';\nexport default Root;\n",
        'default',
      ),
    ).toEqual({ kind: 'reexported', from: { name: 'default', from: './root.module.js' } });
  });

  it('lists the export-star sources when the file names the class nowhere', () => {
    const barrel =
      "export * from './a.module.js';\nexport * from '@velajs/vela';\nexport * as b from './b.module.js';\n";
    expect(moduleExport('index.ts', barrel, 'AppModule')).toEqual({
      kind: 'unknown',
      only: false,
      stars: [{ name: 'AppModule', from: './a.module.js' }],
    });
    expect(moduleExport('index.ts', barrel, 'default')).toEqual({
      kind: 'unknown',
      only: false,
      stars: [],
    });
    expect(
      moduleExport(
        'app.module.ts',
        '@Module({})\nclass Root {}\nexport const AppModule = Root;\n',
        'AppModule',
      ),
    ).toEqual({ kind: 'unknown', only: true, stars: [] });
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
    // The name the module file exports, whatever the entry calls it.
    expect(
      workerRootImport(
        'worker.ts',
        WORKER.replace('{ AppModule }', '{ AppModule as Root }').replace('(AppModule)', '(Root)'),
      ),
    ).toEqual({ name: 'AppModule', from: './app.module.js' });
    expect(workerRootImport('worker.ts', 'export default { fetch() {} };\n')).toBeUndefined();
  });
});

const WORKER_ENTRY = `import { createCloudflareWorker } from '@velajs/cloudflare';
import { AppModule } from './app.module.js';

export default createCloudflareWorker(AppModule);
`;

const BINDINGS = `import { ENV, Global, InjectionToken, Module, defineProvider } from '@velajs/vela';

export const DB = new InjectionToken<D1Database>('DB');

@Global()
@Module({
  providers: [defineProvider(DB, { useFactory: (env) => env.DB, inject: [ENV] })],
  exports: [DB],
})
export class BindingsModule {}
`;

describe('line endings and trailing comments', () => {
  const crlf = (text: string) => text.replaceAll('\n', '\r\n');
  const onlyCrlf = (text: string) => !/(?<!\r)\n/.test(text);

  it('keeps a CRLF file CRLF, whatever it adds', () => {
    const imported = addToModule('app.module.ts', crlf(APP), 'imports', 'NotesModule', {
      imports: [
        { name: 'NotesModule', from: './notes/notes.module.js' },
        { name: 'QueueModule', from: '@velajs/vela/queue' },
      ],
    });
    expect(onlyCrlf(imported.source)).toBe(true);
    expect(imported.source).toContain(
      "import { NotesModule } from './notes/notes.module.js';\r\nimport { QueueModule } from '@velajs/vela/queue';\r\n",
    );
    expect(imported.source).toContain('  imports: [NotesModule],\r\n');

    // A one-line list that outgrows its line is rewritten one entry per line.
    const long = crlf(`import { Module } from '@velajs/vela';

@Module({ providers: [FirstVeryLongProviderName, SecondVeryLongProviderName, ThirdProvider] })
export class AppModule {}
`);
    const reflowed = addToModule('app.module.ts', long, 'providers', 'FourthVeryLongProviderName');
    expect(onlyCrlf(reflowed.source)).toBe(true);
    expect(reflowed.source).toContain(
      '@Module({ providers: [\r\n  FirstVeryLongProviderName,\r\n  SecondVeryLongProviderName,\r\n  ThirdProvider,\r\n  FourthVeryLongProviderName,\r\n] })\r\n',
    );

    const exported = addExport('worker.ts', crlf(WORKER_ENTRY), 'Counter', './counter.js');
    expect(onlyCrlf(exported.source)).toBe(true);
    expect(exported.source).toContain(
      "import { AppModule } from './app.module.js';\r\nexport { Counter } from './counter.js';\r\n",
    );

    const declared = addDeclaration(
      'bindings.module.ts',
      crlf(BINDINGS),
      'CACHE',
      "export const CACHE = new InjectionToken<KVNamespace>('CACHE');",
    );
    expect(onlyCrlf(declared.source)).toBe(true);
    expect(declared.source).toContain(
      "export const DB = new InjectionToken<D1Database>('DB');\r\nexport const CACHE",
    );
  });

  it('keeps a line comment trailing the anchor statement on its line', () => {
    const commented = APP.replace(
      "import { AppService } from './app.service.js';",
      "import { AppService } from './app.service.js'; // the domain service",
    );
    const imported = addToModule('app.module.ts', commented, 'imports', 'NotesModule', {
      imports: [{ name: 'NotesModule', from: './notes/notes.module.js' }],
    });
    expect(imported.source).toContain(
      "import { AppService } from './app.service.js'; // the domain service\nimport { NotesModule } from './notes/notes.module.js';\n",
    );

    const entry = WORKER_ENTRY.replace(
      "import { AppModule } from './app.module.js';",
      "import { AppModule } from './app.module.js'; // the root",
    );
    expect(addExport('worker.ts', entry, 'Counter', './counter.js').source).toContain(
      "import { AppModule } from './app.module.js'; // the root\nexport { Counter } from './counter.js';\n",
    );

    const bindings = BINDINGS.replace(
      "export const DB = new InjectionToken<D1Database>('DB');",
      "export const DB = new InjectionToken<D1Database>('DB'); // the main database",
    );
    expect(
      addDeclaration(
        'bindings.module.ts',
        bindings,
        'CACHE',
        "export const CACHE = new InjectionToken<KVNamespace>('CACHE');",
      ).source,
    ).toContain(
      "export const DB = new InjectionToken<D1Database>('DB'); // the main database\nexport const CACHE = new InjectionToken<KVNamespace>('CACHE');\n",
    );
  });
});

describe('imports of the same name from another source', () => {
  it('refuses a name the file imports from elsewhere instead of treating it as imported', () => {
    const legacy = APP.replace(
      "import { AppService } from './app.service.js';",
      "import { AppService } from './app.service.js';\nimport { BindingsModule } from './legacy/bindings.module.js';",
    );
    expect(() =>
      addToModule('app.module.ts', legacy, 'imports', 'BindingsModule', {
        imports: [{ name: 'BindingsModule', from: './bindings.module.js' }],
      }),
    ).toThrow(
      new SourceEditError(
        "app.module.ts imports BindingsModule from './legacy/bindings.module.js', not from " +
          "'./bindings.module.js'; register BindingsModule yourself.",
      ),
    );
    // The same file, spelled with or without its extension, is the same import.
    const same = legacy.replace('./legacy/bindings.module.js', './bindings.module');
    expect(
      addToModule('app.module.ts', same, 'imports', 'BindingsModule', {
        imports: [{ name: 'BindingsModule', from: './bindings.module.js' }],
      }).source,
    ).toContain("import { BindingsModule } from './bindings.module';\n");
  });

  it('refuses a name the file declares itself', () => {
    const declared = `${APP}\nconst QueueModule = {};\n`;
    expect(() =>
      addToModule('app.module.ts', declared, 'imports', 'QueueModule.forRoot()', {
        imports: [{ name: 'QueueModule', from: '@velajs/vela/queue' }],
      }),
    ).toThrow(
      'app.module.ts declares QueueModule itself; register QueueModule.forRoot() yourself.',
    );
  });
});
