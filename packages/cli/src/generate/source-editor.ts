import MagicString from 'magic-string';
import {
  parseSync,
  type CallExpression,
  type Class,
  type Comment,
  type ImportDeclaration,
  type ImportDeclarationSpecifier,
  type ModuleExportName,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  type Program,
} from 'oxc-parser';

/**
 * Structural edits of TypeScript modules: parse with Oxc, change only the
 * spans that need it with magic-string, and leave every other byte (comments,
 * formatting, other declarations) as it was. oxc-parser reports UTF-16
 * offsets, which magic-string uses too.
 */

export class SourceEditError extends Error {}

/** A single-line list longer than this is rewritten one entry per line. */
const MAX_WIDTH = 100;

/** A named import to make available: `import { name } from 'from'`. */
export interface NamedImport {
  readonly name: string;
  readonly from: string;
}

/** What an edit changed: nothing when the entry was already there. */
export interface SourceEdit {
  readonly source: string;
  readonly changed: boolean;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'type') === 'string' &&
    typeof Reflect.get(value, 'start') === 'number'
  );
}

/** Every node below `root`, depth first. */
function* walk(root: unknown): Generator<Node> {
  if (Array.isArray(root)) {
    for (const item of root) yield* walk(item);
    return;
  }
  if (!isNode(root)) return;
  yield root;
  for (const [key, value] of Object.entries(root)) {
    if (key !== 'parent' && typeof value === 'object' && value !== null) yield* walk(value);
  }
}

function parseModule(file: string, source: string): { program: Program; comments: Comment[] } {
  const result = parseSync(file, source, { sourceType: 'module', lang: 'ts' });
  if (result.errors.length > 0) {
    throw new SourceEditError(
      `Cannot parse ${file}: ${result.errors.map((error) => error.message).join('; ')}`,
    );
  }
  return { program: result.program, comments: result.comments };
}

function parse(file: string, source: string): Program {
  return parseModule(file, source).program;
}

function exportName(name: ModuleExportName): string {
  return name.type === 'Literal' ? name.value : name.name;
}

function calleeName(call: CallExpression): string | undefined {
  return call.callee.type === 'Identifier' ? call.callee.name : undefined;
}

function importDeclarations(program: Program): ImportDeclaration[] {
  return program.body.filter(
    (statement): statement is ImportDeclaration => statement.type === 'ImportDeclaration',
  );
}

/** The indentation of the line `offset` is on. */
function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? '';
}

/**
 * Make each type-only binding of `names` a value binding: drop the specifier's
 * `type` modifier, or move an `import type` declaration's to its other
 * specifiers.
 */
function importValues(
  code: MagicString,
  source: string,
  program: Program,
  names: ReadonlySet<string>,
): void {
  for (const declaration of importDeclarations(program)) {
    const wanted = declaration.specifiers.filter((specifier) => names.has(specifier.local.name));
    if (wanted.length === 0) continue;
    if (declaration.importKind === 'type') {
      if (wanted.some((specifier) => specifier.type !== 'ImportSpecifier')) {
        throw new SourceEditError(
          `${wanted.map((specifier) => specifier.local.name).join(', ')} is imported as a type ` +
            'only; import it as a value yourself.',
        );
      }
      const keyword = /^import\s+(type\s+)/.exec(source.slice(declaration.start));
      if (keyword?.[1] === undefined) continue;
      const at = declaration.start + keyword[0].length - keyword[1].length;
      code.remove(at, at + keyword[1].length);
      for (const specifier of declaration.specifiers) {
        if (!wanted.includes(specifier)) code.prependLeft(specifier.start, 'type ');
      }
      continue;
    }
    for (const specifier of wanted) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') {
        code.remove(specifier.start, specifier.imported.start);
      }
    }
  }
}

/** Whether `specifier` of `declaration` binds a type only. */
const typeOnly = (declaration: ImportDeclaration, specifier: ImportDeclarationSpecifier) =>
  declaration.importKind === 'type' ||
  (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type');

function addImports(
  code: MagicString,
  source: string,
  program: Program,
  wanted: readonly NamedImport[],
): void {
  const declarations = importDeclarations(program);
  const bound = new Map<string, boolean>();
  for (const declaration of declarations) {
    for (const specifier of declaration.specifiers) {
      bound.set(specifier.local.name, typeOnly(declaration, specifier));
    }
  }
  // A name imported as a type only becomes a value import in place: a second
  // import of the same name would not compile.
  importValues(
    code,
    source,
    program,
    new Set(wanted.map(({ name }) => name).filter((name) => bound.get(name) === true)),
  );
  const pending = new Map<string, string[]>();
  for (const { name, from } of wanted) {
    if (bound.has(name)) continue;
    bound.set(name, false);
    const existing = declarations.find(
      (declaration) =>
        declaration.source.value === from &&
        declaration.importKind !== 'type' &&
        declaration.specifiers.some((specifier) => specifier.type === 'ImportSpecifier'),
    );
    const last = existing?.specifiers.findLast((specifier) => specifier.type === 'ImportSpecifier');
    if (last) code.appendLeft(last.end, `, ${name}`);
    else pending.set(from, [...(pending.get(from) ?? []), name]);
  }
  const lines = [...pending].map(
    ([from, names]) => `import { ${names.join(', ')} } from '${from}';`,
  );
  if (lines.length === 0) return;
  const last = declarations.at(-1);
  if (last) code.appendLeft(last.end, `\n${lines.join('\n')}`);
  else code.prepend(`${lines.join('\n')}\n\n`);
}

interface ModuleClass {
  readonly name: string | undefined;
  /** The names the file exports the class under (`default` included). */
  readonly exported: readonly string[];
  readonly call: CallExpression;
}

/**
 * Every `@Module()` class of the file, with the names it is exported under:
 * `export class`, `export default class`, `export default AppModule;` and
 * local `export { AppModule as default }` lists.
 */
function moduleClasses(program: Program): ModuleClass[] {
  const exportedAs = new Map<string, string[]>();
  const exportedClasses = new Map<Class, string[]>();
  const exportAs = (local: string, exported: string) =>
    exportedAs.set(local, [...(exportedAs.get(local) ?? []), exported]);
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration?.type === 'ClassDeclaration' && statement.declaration.id) {
        exportedClasses.set(statement.declaration, [statement.declaration.id.name]);
      }
      if (statement.source !== null) continue;
      for (const specifier of statement.specifiers) {
        exportAs(exportName(specifier.local), exportName(specifier.exported));
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      if (statement.declaration.type === 'ClassDeclaration') {
        exportedClasses.set(statement.declaration, ['default']);
      } else if (statement.declaration.type === 'Identifier') {
        exportAs(statement.declaration.name, 'default');
      }
    }
  }
  const classes: ModuleClass[] = [];
  for (const node of walk(program.body)) {
    if (node.type !== 'ClassDeclaration') continue;
    const declaration: Class = node;
    const call = declaration.decorators
      .map((decorator) => decorator.expression)
      .find(
        (expression): expression is CallExpression =>
          expression.type === 'CallExpression' && calleeName(expression) === 'Module',
      );
    if (call === undefined) continue;
    const name = declaration.id?.name;
    classes.push({
      name,
      exported: [
        ...(exportedClasses.get(declaration) ?? []),
        ...(name === undefined ? [] : (exportedAs.get(name) ?? [])),
      ],
      call,
    });
  }
  return classes;
}

/**
 * How `file` exports the `@Module()` class `name`: it declares it (under that
 * name, or exports it so), it re-exports it from a relative file
 * (`export { AppModule } from './root.module.js'`, or an imported binding it
 * exports), or neither: then `only` tells whether the file declares a single
 * module class, and `stars` lists the relative `export * from` sources that may
 * provide it.
 */
export type ModuleExport =
  | { readonly kind: 'declared' }
  | { readonly kind: 'reexported'; readonly from: NamedImport }
  | { readonly kind: 'unknown'; readonly only: boolean; readonly stars: readonly NamedImport[] };

export function moduleExport(file: string, source: string, name: string): ModuleExport {
  const program = parse(file, source);
  const classes = moduleClasses(program);
  if (classes.some((candidate) => candidate.name === name || candidate.exported.includes(name))) {
    return { kind: 'declared' };
  }
  const imported = new Map<string, NamedImport>();
  for (const declaration of importDeclarations(program)) {
    if (declaration.importKind === 'type' || !declaration.source.value.startsWith('.')) continue;
    for (const specifier of declaration.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') continue;
      imported.set(specifier.local.name, {
        name: specifier.type === 'ImportSpecifier' ? exportName(specifier.imported) : 'default',
        from: declaration.source.value,
      });
    }
  }
  const stars: NamedImport[] = [];
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type') {
      const specifier = statement.specifiers.find(
        (candidate) => exportName(candidate.exported) === name,
      );
      if (specifier === undefined) continue;
      const local = exportName(specifier.local);
      const from =
        statement.source === null
          ? imported.get(local)
          : statement.source.value.startsWith('.')
            ? { name: local, from: statement.source.value }
            : undefined;
      if (from !== undefined) return { kind: 'reexported', from };
    } else if (
      statement.type === 'ExportDefaultDeclaration' &&
      name === 'default' &&
      statement.declaration.type === 'Identifier'
    ) {
      const from = imported.get(statement.declaration.name);
      if (from !== undefined) return { kind: 'reexported', from };
    } else if (
      statement.type === 'ExportAllDeclaration' &&
      statement.exported === null &&
      statement.exportKind !== 'type' &&
      name !== 'default' &&
      statement.source.value.startsWith('.')
    ) {
      stars.push({ name, from: statement.source.value });
    }
  }
  return { kind: 'unknown', only: classes.length === 1, stars };
}

/**
 * The `@Module(...)` call to edit: of the class named `name` (declared or
 * exported under it) or, when the file names none so, of its only module
 * class; without `name`, of the file's only module class, else of the only
 * exported one.
 */
function moduleDecorator(
  file: string,
  program: Program,
  name: string | undefined,
  entry: string,
): CallExpression {
  const classes = moduleClasses(program);
  const [only] = classes;
  if (name !== undefined) {
    const named = classes.find(
      (candidate) => candidate.name === name || candidate.exported.includes(name),
    );
    if (named !== undefined) return named.call;
    // Exported some other way (`export const AppModule = Root`): the only candidate.
    if (classes.length === 1 && only !== undefined) return only.call;
    throw new SourceEditError(`${file} declares no @Module() class ${name}.`);
  }
  if (only === undefined) throw new SourceEditError(`${file} declares no @Module() class.`);
  if (classes.length === 1) return only.call;
  const exported = classes.filter((candidate) => candidate.exported.length > 0);
  const [single] = exported;
  if (exported.length === 1 && single !== undefined) return single.call;
  const listed = exported.length > 1 ? exported : classes;
  throw new SourceEditError(
    `${file} declares several @Module() classes (${listed.map((candidate) => candidate.name ?? '(anonymous)').join(', ')}); register ${entry} yourself.`,
  );
}

function propertyNamed(object: ObjectExpression, key: string): ObjectProperty | undefined {
  return object.properties.find(
    (property): property is ObjectProperty =>
      property.type === 'Property' &&
      !property.computed &&
      ((property.key.type === 'Identifier' && property.key.name === key) ||
        (property.key.type === 'Literal' && property.key.value === key)),
  );
}

/** Insert `text` as the last item of a comma-separated list closed at `close`. */
function appendItem(
  code: MagicString,
  source: string,
  container: { start: number; end: number },
  last: { start: number; end: number } | undefined,
  text: string,
): void {
  if (!last) {
    code.appendLeft(container.start + 1, text);
    return;
  }
  // One entry per line only where the last one starts its own line.
  const lineStart = source.lastIndexOf('\n', last.start - 1) + 1;
  if (
    !source.slice(container.start, container.end).includes('\n') ||
    source.slice(lineStart, last.start).trim() !== ''
  ) {
    code.appendLeft(last.end, `, ${text}`);
    return;
  }
  const indent = indentAt(source, last.start);
  const comma = /^\s*,/.exec(source.slice(last.end, container.end - 1));
  if (comma) code.appendLeft(last.end + comma[0].length, `\n${indent}${text},`);
  else code.appendLeft(last.end, `,\n${indent}${text}`);
}

/**
 * Add `entry` (source text such as `NotesController` or
 * `QueueModule.registerQueue({ name: 'emails' })`) to the `key` list of the
 * file's `@Module()` metadata and import what it names. An entry already
 * listed, or any element `unless` matches, leaves the file unchanged.
 */
export function addToModule(
  file: string,
  source: string,
  key: 'imports' | 'controllers' | 'providers' | 'exports',
  entry: string,
  options: {
    imports?: readonly NamedImport[];
    unless?: RegExp;
    /** The module class to edit, by its declared or exported name. */
    module?: string;
  } = {},
): SourceEdit {
  const { program, comments } = parseModule(file, source);
  const call = moduleDecorator(file, program, options.module, entry);
  const code = new MagicString(source);
  const [argument] = call.arguments;
  if (argument === undefined) {
    // `@Module()` → `@Module({ key: [entry] })`
    code.appendLeft(call.end - 1, `{ ${key}: [${entry}] }`);
  } else if (argument.type !== 'ObjectExpression') {
    throw new SourceEditError(
      `${file}: @Module() takes a computed argument; register ${entry} yourself.`,
    );
  } else {
    const property = propertyNamed(argument, key);
    if (property === undefined) {
      const last = argument.properties.at(-1);
      if (last) appendItem(code, source, argument, last, `${key}: [${entry}]`);
      else code.overwrite(argument.start, argument.end, `{ ${key}: [${entry}] }`);
    } else if (property.value.type !== 'ArrayExpression') {
      throw new SourceEditError(
        `${file}: @Module({ ${key} }) is not an array literal; register ${entry} yourself.`,
      );
    } else {
      const array = property.value;
      const elements = array.elements.filter((element) => element !== null);
      const texts = elements.map((element) => source.slice(element.start, element.end));
      if (texts.includes(entry) || texts.some((text) => options.unless?.test(text))) {
        return { source, changed: false };
      }
      const lineStart = source.lastIndexOf('\n', array.start) + 1;
      const lineEnd = source.indexOf('\n', array.end);
      const width = (lineEnd === -1 ? source.length : lineEnd) - lineStart + entry.length + 2;
      const commented = comments.some(
        (comment) => comment.start >= array.start && comment.end <= array.end,
      );
      if (!source.slice(array.start, array.end).includes('\n') && width > MAX_WIDTH && !commented) {
        // A single-line list that would outgrow the line: one entry per line.
        const indent = indentAt(source, array.start);
        const unit = /\n([ \t]+)\S/.exec(source)?.[1] ?? '  ';
        code.overwrite(
          array.start,
          array.end,
          `[\n${[...texts, entry].map((text) => `${indent}${unit}${text},\n`).join('')}${indent}]`,
        );
      } else {
        appendItem(code, source, array, elements.at(-1), entry);
      }
    }
  }
  addImports(code, source, program, options.imports ?? []);
  return { source: code.toString(), changed: true };
}

/** Add `export { name } from 'from';` to a module (the Worker entry), unless it exports `name`. */
export function addExport(file: string, source: string, name: string, from: string): SourceEdit {
  const program = parse(file, source);
  for (const node of walk(program.body)) {
    if (
      (node.type === 'ExportSpecifier' && exportName(node.exported) === name) ||
      (node.type === 'ClassDeclaration' && node.id?.name === name)
    ) {
      return { source, changed: false };
    }
  }
  const code = new MagicString(source);
  const line = `export { ${name} } from '${from}';`;
  const anchor = program.body.findLast(
    (statement) =>
      statement.type === 'ImportDeclaration' ||
      (statement.type === 'ExportNamedDeclaration' && statement.source !== null),
  );
  if (anchor) code.appendLeft(anchor.end, `\n${line}`);
  else code.prepend(`${line}\n`);
  return { source: code.toString(), changed: true };
}

/**
 * The root module the Worker entry passes to `createCloudflareWorker(...)`:
 * the name its file exports it under (`default` for a default import) and the
 * relative import source, or undefined when the entry builds the Worker
 * another way.
 */
export function workerRootImport(file: string, source: string): NamedImport | undefined {
  const program = parse(file, source);
  let root: string | undefined;
  for (const node of walk(program.body)) {
    if (node.type !== 'CallExpression' || calleeName(node) !== 'createCloudflareWorker') continue;
    const [argument] = node.arguments;
    if (argument?.type === 'Identifier') root = argument.name;
    break;
  }
  if (root === undefined) return undefined;
  for (const declaration of importDeclarations(program)) {
    if (!declaration.source.value.startsWith('.')) continue;
    const specifier = declaration.specifiers.find((candidate) => candidate.local.name === root);
    if (specifier === undefined || specifier.type === 'ImportNamespaceSpecifier') continue;
    const name = specifier.type === 'ImportSpecifier' ? exportName(specifier.imported) : 'default';
    return { name, from: declaration.source.value };
  }
  return undefined;
}

/** Whether the module calls `object.method(...)` for one of `methods`, such as `QueueModule.forRoot()`. */
export function callsMethod(
  file: string,
  source: string,
  object: string,
  methods: readonly string[],
): boolean {
  for (const node of walk(parse(file, source).body)) {
    if (node.type !== 'CallExpression') continue;
    const callee = node.callee;
    if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object.type === 'Identifier' &&
      callee.object.name === object &&
      callee.property.type === 'Identifier' &&
      methods.includes(callee.property.name)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Add a top-level statement declaring `name` (such as
 * `export const DB = new InjectionToken<D1Database>('DB');`) after the file's
 * last exported variable, else after its imports, unless `name` is declared.
 */
export function addDeclaration(
  file: string,
  source: string,
  name: string,
  statement: string,
): SourceEdit {
  const program = parse(file, source);
  const declares = (node: Node | null): boolean =>
    node?.type === 'VariableDeclaration' &&
    node.declarations.some(
      (declarator) => declarator.id.type === 'Identifier' && declarator.id.name === name,
    );
  if (
    program.body.some(
      (node) =>
        declares(node) || (node.type === 'ExportNamedDeclaration' && declares(node.declaration)),
    )
  ) {
    return { source, changed: false };
  }
  const code = new MagicString(source);
  const anchor =
    program.body.findLast(
      (node) =>
        node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration',
    ) ?? importDeclarations(program).at(-1);
  if (anchor) code.appendLeft(anchor.end, `\n${statement}`);
  else code.prepend(`${statement}\n`);
  return { source: code.toString(), changed: true };
}
