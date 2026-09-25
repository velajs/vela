import MagicString from 'magic-string';
import {
  parseSync,
  type BindingPattern,
  type BindingRestElement,
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

/** A module specifier as it names a file: a relative one without its script extension. */
const sameModule = (a: string, b: string): boolean => {
  const file = (specifier: string) =>
    specifier.startsWith('.') ? specifier.replace(/\.[cm]?[jt]sx?$/, '') : specifier;
  return file(a) === file(b);
};

/** The names a binding pattern declares: `B`, `{ B }`, `[B]`, `{ a: { B = x } }`, `...B`. */
function patternNames(pattern: BindingPattern | BindingRestElement): string[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'AssignmentPattern':
      return patternNames(pattern.left);
    case 'RestElement':
      return patternNames(pattern.argument);
    case 'ArrayPattern':
      return pattern.elements.flatMap((element) => (element === null ? [] : patternNames(element)));
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        patternNames(property.type === 'RestElement' ? property : property.value),
      );
  }
}

/**
 * The value names the file's top-level statements declare: classes,
 * functions, variables (destructured ones included), enums, namespaces and
 * `import X = ...` aliases.
 */
function declaredNames(program: Program): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    const node =
      (statement.type === 'ExportNamedDeclaration' ||
        statement.type === 'ExportDefaultDeclaration') &&
      statement.declaration !== null
        ? statement.declaration
        : statement;
    if (
      (node.type === 'ClassDeclaration' || node.type === 'FunctionDeclaration') &&
      node.id !== null
    ) {
      names.add(node.id.name);
    } else if (node.type === 'VariableDeclaration') {
      for (const declarator of node.declarations) {
        for (const name of patternNames(declarator.id)) names.add(name);
      }
    } else if (node.type === 'TSEnumDeclaration' || node.type === 'TSImportEqualsDeclaration') {
      names.add(node.id.name);
    } else if (node.type === 'TSModuleDeclaration' && node.id.type === 'Identifier') {
      names.add(node.id.name);
    }
  }
  return names;
}

/** What an import binds its local name to, for messages. */
function importedAs(specifier: ImportDeclarationSpecifier): string {
  if (specifier.type === 'ImportNamespaceSpecifier') return 'the module namespace';
  if (specifier.type === 'ImportDefaultSpecifier') return 'the default export';
  const imported = exportName(specifier.imported);
  return imported === 'default' ? 'the default export' : `the export ${imported}`;
}

/**
 * Throw when a name of `wanted` is bound in the file to something else: a
 * name the file declares itself, imports from another module, or imports
 * from that module as another export (`{ Other as B }`, a default or
 * namespace import) would be a different binding, so the edit fails instead
 * of treating it as imported. With `listed`, the entry is in the list
 * already and nothing is added: a name imported through a path alias or a
 * package, which only the project's build resolves, is left as the file has
 * it, since it may well name the same module.
 */
function assertImportable(
  file: string,
  entry: string,
  program: Program,
  wanted: readonly NamedImport[],
  listed: boolean,
): void {
  const bindings = new Map<
    string,
    { readonly from: string; readonly specifier: ImportDeclarationSpecifier }
  >();
  for (const declaration of importDeclarations(program)) {
    for (const specifier of declaration.specifiers) {
      bindings.set(specifier.local.name, { from: declaration.source.value, specifier });
    }
  }
  const declared = declaredNames(program);
  for (const { name, from } of wanted) {
    const current = bindings.get(name);
    if (current === undefined) {
      if (declared.has(name)) {
        throw new SourceEditError(`${file} declares ${name} itself; register ${entry} yourself.`);
      }
      continue;
    }
    if (listed && !current.from.startsWith('.')) continue;
    if (!sameModule(current.from, from)) {
      throw new SourceEditError(
        `${file} imports ${name} from '${current.from}', not from '${from}'; register ${entry} yourself.`,
      );
    }
    const { specifier } = current;
    if (specifier.type !== 'ImportSpecifier' || exportName(specifier.imported) !== name) {
      throw new SourceEditError(
        `${file} binds ${name} to ${importedAs(specifier)} of '${current.from}', not to its ` +
          `export ${name}; register ${entry} yourself.`,
      );
    }
  }
}

/** Import each of `wanted` the file does not import yet ({@link assertImportable} ran). */
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
  // After the comment trailing the last import on its line, which stays with it.
  if (last) code.appendLeft(trailEnd(source, last.end), `\n${lines.join('\n')}`);
  else code.prepend(`${lines.join('\n')}\n\n`);
}

/**
 * Run `edit` on `source` with LF line breaks and give a file whose line breaks
 * are all CRLF its CRLF back, so an edit never mixes them. A file that mixes
 * them already is edited as it is.
 */
function keepingLineEnds(source: string, edit: (text: string) => SourceEdit): SourceEdit {
  if (!source.includes('\r\n') || /(?<!\r)\n/.test(source)) return edit(source);
  const edited = edit(source.replaceAll('\r\n', '\n'));
  return edited.changed
    ? { source: edited.source.replaceAll('\n', '\r\n'), changed: true }
    : { source, changed: false };
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

/** The property that sets `key` as written: the last literal one, as at runtime. */
function propertyNamed(object: ObjectExpression, key: string): ObjectProperty | undefined {
  return object.properties.findLast(
    (property): property is ObjectProperty =>
      property.type === 'Property' &&
      !property.computed &&
      ((property.key.type === 'Identifier' && property.key.name === key) ||
        (property.key.type === 'Literal' && property.key.value === key)),
  );
}

/** The offset of the first character from `from` on that is neither whitespace nor a comment. */
function skipTrivia(source: string, from: number): number {
  let offset = from;
  for (;;) {
    while (/\s/.test(source.charAt(offset))) offset++;
    if (source.startsWith('//', offset)) {
      const end = source.indexOf('\n', offset);
      offset = end === -1 ? source.length : end;
    } else if (source.startsWith('/*', offset)) {
      const end = source.indexOf('*/', offset + 2);
      offset = end === -1 ? source.length : end + 2;
    } else {
      return offset;
    }
  }
}

/**
 * The end of the comments trailing `from` on its line: through a line comment
 * to the line break, through block comments (which may run over several
 * lines) to their close.
 */
function trailEnd(source: string, from: number): number {
  let offset = from;
  let at = from;
  for (;;) {
    while (source.charAt(offset) === ' ' || source.charAt(offset) === '\t') offset++;
    if (source.startsWith('//', offset)) {
      const newline = source.indexOf('\n', offset);
      if (newline === -1) return source.length;
      return source.charAt(newline - 1) === '\r' ? newline - 1 : newline;
    }
    if (!source.startsWith('/*', offset)) return at;
    const close = source.indexOf('*/', offset + 2);
    if (close === -1) return at;
    offset = close + 2;
    at = offset;
  }
}

/**
 * Insert `text` as the last item of the comma-separated list `container`: on
 * the line of the last item when that one shares a line, else on a line of its
 * own after the comma and comment trailing the last item, so a comment keeps
 * annotating the item it follows.
 */
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
    // On the line: after the last item and the block comments trailing it there.
    let at = last.end;
    for (;;) {
      const offset = /^[ \t]*/.exec(source.slice(at))?.[0].length ?? 0;
      if (!source.startsWith('/*', at + offset)) break;
      const close = source.indexOf('*/', at + offset + 2);
      if (close === -1) break;
      at = close + 2;
    }
    code.appendLeft(at, `, ${text}`);
    return;
  }
  const indent = indentAt(source, last.start);
  const next = skipTrivia(source, last.end);
  if (source.charAt(next) === ',') {
    // A trailing comma stays trailing: the new line goes after it and its comment.
    code.appendLeft(trailEnd(source, next + 1), `\n${indent}${text},`);
    return;
  }
  // The comma goes right after the last item, which keeps its own comment.
  code.appendLeft(last.end, ',');
  code.appendLeft(trailEnd(source, last.end), `\n${indent}${text}`);
}

/**
 * Throw when a spread or computed key of `metadata` may set `key` after the
 * literal property the edit targets (or anywhere, without one): an entry added
 * there would be replaced, or would replace the list the spread holds.
 */
function assertOwnsKey(
  file: string,
  metadata: ObjectExpression,
  property: ObjectProperty | undefined,
  key: string,
  entry: string,
): void {
  const after =
    property === undefined
      ? metadata.properties
      : metadata.properties.slice(metadata.properties.indexOf(property) + 1);
  if (after.some((candidate) => candidate.type === 'SpreadElement' || candidate.computed)) {
    throw new SourceEditError(
      `${file}: a spread or computed key in @Module() may set ${key}; register ${entry} yourself.`,
    );
  }
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
  return keepingLineEnds(source, (text) => addToModuleText(file, text, key, entry, options));
}

function addToModuleText(
  file: string,
  source: string,
  key: 'imports' | 'controllers' | 'providers' | 'exports',
  entry: string,
  options: { imports?: readonly NamedImport[]; unless?: RegExp; module?: string },
): SourceEdit {
  const { program, comments } = parseModule(file, source);
  const wanted = options.imports ?? [];
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
    assertOwnsKey(file, argument, property, key, entry);
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
        // Listed under a name the file binds to another module, it is not this entry.
        assertImportable(file, entry, program, wanted, true);
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
  assertImportable(file, entry, program, wanted, false);
  addImports(code, source, program, wanted);
  return { source: code.toString(), changed: true };
}

/**
 * The name the file exports its `@Module()` class under, the class
 * {@link addToModule} edits without a `module` option: its own name when the
 * file exports it so, else another name it exports it under. A class the file
 * does not export by name cannot be imported, so it fails.
 */
export function moduleClassExport(file: string, source: string): string {
  const program = parse(file, source);
  const call = moduleDecorator(file, program, undefined, 'the binding');
  const found = moduleClasses(program).find((candidate) => candidate.call === call);
  const named = found?.exported.filter((name) => name !== 'default') ?? [];
  const name = found?.name;
  if (name !== undefined && named.includes(name)) return name;
  const [first] = named;
  if (first !== undefined) return first;
  throw new SourceEditError(
    `${file} does not export its module class ${name ?? '(anonymous)'} by name; export it ` +
      `(export class ${name ?? 'BindingsModule'}) or register the binding yourself.`,
  );
}

/**
 * The import binding the local name `name`: its module specifier and the
 * export it names (`default` for a default import, undefined for a namespace
 * import), or undefined when no import binds it.
 */
export function importBinding(
  file: string,
  source: string,
  name: string,
): { readonly from: string; readonly name: string | undefined } | undefined {
  for (const declaration of importDeclarations(parse(file, source))) {
    const specifier = declaration.specifiers.find((candidate) => candidate.local.name === name);
    if (specifier === undefined) continue;
    return {
      from: declaration.source.value,
      name:
        specifier.type === 'ImportSpecifier'
          ? exportName(specifier.imported)
          : specifier.type === 'ImportDefaultSpecifier'
            ? 'default'
            : undefined,
    };
  }
  return undefined;
}

/** The value names a module's top-level scope binds: its imports and its declarations. */
export function topLevelNames(file: string, source: string): Set<string> {
  const program = parse(file, source);
  const names = declaredNames(program);
  for (const declaration of importDeclarations(program)) {
    for (const specifier of declaration.specifiers) names.add(specifier.local.name);
  }
  return names;
}

/**
 * Whether the module declares `name` as the injection token `vela add`
 * writes for a binding of that name,
 * `export const NAME = new InjectionToken<T>('NAME')`, and nothing else.
 */
export function declaresBindingToken(file: string, source: string, name: string): boolean {
  const program = parse(file, source);
  return program.body.some((statement) => {
    if (statement.type !== 'ExportNamedDeclaration') return false;
    const declaration = statement.declaration;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') return false;
    const [declarator, ...others] = declaration.declarations;
    const init = declarator?.init;
    const [argument, ...rest] = init?.type === 'NewExpression' ? init.arguments : [];
    return (
      others.length === 0 &&
      declarator?.id.type === 'Identifier' &&
      declarator.id.name === name &&
      init?.type === 'NewExpression' &&
      init.callee.type === 'Identifier' &&
      init.callee.name === 'InjectionToken' &&
      rest.length === 0 &&
      argument?.type === 'Literal' &&
      argument.value === name
    );
  });
}

/** Add `export { name } from 'from';` to a module (the Worker entry), unless it exports `name`. */
export function addExport(file: string, source: string, name: string, from: string): SourceEdit {
  return keepingLineEnds(source, (text) => addExportText(file, text, name, from));
}

function addExportText(file: string, source: string, name: string, from: string): SourceEdit {
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
  if (anchor) code.appendLeft(trailEnd(source, anchor.end), `\n${line}`);
  else code.prepend(`${line}\n`);
  return { source: code.toString(), changed: true };
}

/** The `@velajs/cloudflare` factories that take the application's root module first. */
const ROOT_FACTORIES = new Set(['createCloudflareWorker', 'defineCloudflareApp']);

/**
 * The root module the Worker entry passes to `createCloudflareWorker(...)` or
 * `defineCloudflareApp(...)`: the name its file exports it under (`default`
 * for a default import) and the relative import source, or undefined when the
 * entry builds the Worker another way.
 */
export function workerRootImport(file: string, source: string): NamedImport | undefined {
  const program = parse(file, source);
  let root: string | undefined;
  for (const node of walk(program.body)) {
    if (node.type !== 'CallExpression' || !ROOT_FACTORIES.has(calleeName(node) ?? '')) continue;
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

/** How the Worker entry builds its application, as {@link workerApp} reads it. */
export interface WorkerApp {
  /** The `@velajs/cloudflare` factory the entry calls with the root module. */
  readonly factory: 'createCloudflareWorker' | 'defineCloudflareApp';
  /** Whether the call passes options (runtime adapters, a global prefix, ...). */
  readonly options: boolean;
  /** The top-level `const` bound to `defineCloudflareApp(...)`, such as `app`. */
  readonly binding?: string;
}

/** Whether `statement` declares the top-level `const` or `let` binding `name`. */
function declaresBinding(statement: Program['body'][number], name: string): boolean {
  const declaration =
    statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
  return (
    declaration?.type === 'VariableDeclaration' &&
    declaration.declarations.some(
      (declarator) => declarator.id.type === 'Identifier' && declarator.id.name === name,
    )
  );
}

/**
 * How the Worker entry builds its application: the factory it calls, whether
 * it passes options, and the top-level `const` it binds the app to
 * (`const app = defineCloudflareApp(AppModule, options)`), or undefined when
 * it calls neither factory.
 */
export function workerApp(file: string, source: string): WorkerApp | undefined {
  const program = parse(file, source);
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const declarator of declaration.declarations) {
      const init = declarator.init;
      if (
        declarator.id.type === 'Identifier' &&
        init?.type === 'CallExpression' &&
        calleeName(init) === 'defineCloudflareApp'
      ) {
        return {
          factory: 'defineCloudflareApp',
          options: init.arguments.length > 1,
          binding: declarator.id.name,
        };
      }
    }
  }
  for (const node of walk(program.body)) {
    if (node.type !== 'CallExpression') continue;
    const factory = calleeName(node);
    if (factory === 'createCloudflareWorker' || factory === 'defineCloudflareApp') {
      return { factory, options: node.arguments.length > 1 };
    }
  }
  return undefined;
}

/**
 * The app a Worker entry imports and default-exports the Worker of
 * (`import { app } from './app.js'; export default app.worker;`): the name its
 * module exports it under (`default` for a default import) and the relative
 * import source, or undefined.
 */
export function importedWorkerApp(file: string, source: string): NamedImport | undefined {
  const program = parse(file, source);
  const statement = program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  const expression =
    statement?.type === 'ExportDefaultDeclaration' ? statement.declaration : undefined;
  if (
    expression?.type !== 'MemberExpression' ||
    expression.computed ||
    expression.object.type !== 'Identifier' ||
    expression.property.type !== 'Identifier' ||
    expression.property.name !== 'worker'
  ) {
    return undefined;
  }
  const local = expression.object.name;
  for (const declaration of importDeclarations(program)) {
    if (!declaration.source.value.startsWith('.')) continue;
    const specifier = declaration.specifiers.find((candidate) => candidate.local.name === local);
    if (specifier === undefined || specifier.type === 'ImportNamespaceSpecifier') continue;
    const name = specifier.type === 'ImportSpecifier' ? exportName(specifier.imported) : 'default';
    return { name, from: declaration.source.value };
  }
  return undefined;
}

/** What {@link addWorkerDeclaration} declares in the Worker entry. */
export interface WorkerDeclaration {
  /** The top-level binding the declaration uses, such as the app: it goes after it. */
  readonly after: string;
  /** The name it declares. */
  readonly name: string;
  /** The statement, with its leading comment. */
  readonly declaration: string;
  readonly imports: readonly NamedImport[];
}

/**
 * Declare a statement that uses a top-level binding of the Worker entry, such
 * as `export class Counter extends VelaDurableObject(app, CounterHost) {}`:
 * before the default export when it follows the binding (keeping the default
 * export's leading comments with it), else right after the binding.
 */
export function addWorkerDeclaration(
  file: string,
  source: string,
  { after, name, declaration, imports }: WorkerDeclaration,
): SourceEdit {
  const { program, comments } = parseModule(file, source);
  for (const node of walk(program.body)) {
    if (
      (node.type === 'ClassDeclaration' && node.id?.name === name) ||
      (node.type === 'ExportSpecifier' && exportName(node.exported) === name) ||
      (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name)
    ) {
      throw new SourceEditError(`${file} already declares ${name}; choose another name.`);
    }
  }
  const index = program.body.findIndex((statement) => declaresBinding(statement, after));
  const binding = program.body[index];
  if (binding === undefined) throw new SourceEditError(`${file} does not declare ${after}.`);
  const code = new MagicString(source);
  const exported = program.body.findIndex(
    (statement) => statement.type === 'ExportDefaultDeclaration',
  );
  const defaultExport = exported > index ? program.body[exported] : undefined;
  if (defaultExport) {
    const lineStart = (offset: number): number => source.lastIndexOf('\n', offset - 1) + 1;
    const startsLine = (offset: number): boolean =>
      source.slice(lineStart(offset), offset).trim() === '';
    let at = defaultExport.start;
    // Comments on their own lines right above the default export stay with it.
    for (const comment of comments.toReversed()) {
      if (comment.end > at) continue;
      if (source.slice(comment.end, at).trim() !== '' || !startsLine(comment.start)) break;
      at = comment.start;
    }
    if (startsLine(at)) at = lineStart(at);
    code.appendLeft(at, `${declaration}\n\n`);
  } else {
    code.appendLeft(binding.end, `\n\n${declaration}`);
  }
  addImports(code, source, program, imports);
  return { source: code.toString(), changed: true };
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
  return keepingLineEnds(source, (text) => addDeclarationText(file, text, name, statement));
}

function addDeclarationText(
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
  if (anchor) code.appendLeft(trailEnd(source, anchor.end), `\n${statement}`);
  else code.prepend(`${statement}\n`);
  return { source: code.toString(), changed: true };
}
