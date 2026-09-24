import MagicString from 'magic-string';
import {
  parseSync,
  type CallExpression,
  type Class,
  type ImportDeclaration,
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

function parse(file: string, source: string): Program {
  const result = parseSync(file, source, { sourceType: 'module', lang: 'ts' });
  if (result.errors.length > 0) {
    throw new SourceEditError(
      `Cannot parse ${file}: ${result.errors.map((error) => error.message).join('; ')}`,
    );
  }
  return result.program;
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

function addImports(code: MagicString, program: Program, wanted: readonly NamedImport[]): void {
  const declarations = importDeclarations(program);
  const bound = new Set(
    declarations.flatMap((declaration) =>
      declaration.specifiers.map((specifier) => specifier.local.name),
    ),
  );
  const pending = new Map<string, string[]>();
  for (const { name, from } of wanted) {
    if (bound.has(name)) continue;
    bound.add(name);
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

/** The `@Module(...)` call on the file's module class. */
function moduleDecorator(file: string, program: Program): CallExpression {
  for (const node of walk(program.body)) {
    if (node.type !== 'ClassDeclaration') continue;
    const declaration: Class = node;
    for (const decorator of declaration.decorators) {
      const call = decorator.expression;
      if (call.type === 'CallExpression' && calleeName(call) === 'Module') return call;
    }
  }
  throw new SourceEditError(`${file} declares no @Module() class.`);
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
  if (!source.slice(container.start, container.end).includes('\n')) {
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
  options: { imports?: readonly NamedImport[]; unless?: RegExp } = {},
): SourceEdit {
  const program = parse(file, source);
  const call = moduleDecorator(file, program);
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
      if (!source.slice(array.start, array.end).includes('\n') && width > MAX_WIDTH) {
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
  addImports(code, program, options.imports ?? []);
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
 * its local name and relative import source, or undefined when the entry
 * builds the Worker another way.
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
    if (declaration.specifiers.some((specifier) => specifier.local.name === root)) {
      return { name: root, from: declaration.source.value };
    }
  }
  return undefined;
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
