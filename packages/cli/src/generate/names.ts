/** The spellings of one generated name. */
export interface Names {
  /** `todo-items`: files, directories and routes. */
  readonly kebab: string;
  /** `TodoItems`: classes. */
  readonly pascal: string;
  /** `todoItems`: variables. */
  readonly camel: string;
  /** `TODO_ITEMS`: constants and Wrangler bindings. */
  readonly constant: string;
}

const NAME = /^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;

/** Split `todoItems`, `TodoItems`, `todo-items` or `todo_items` into its words. */
export function names(input: string): Names {
  if (!NAME.test(input) || input.length > 64) {
    throw new Error(
      `Invalid name ${JSON.stringify(input)}: use letters and digits, words separated by ` +
        'dashes, underscores or capitals (notes, todo-items, TodoItems), starting with a letter.',
    );
  }
  const words = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((word) => word.toLowerCase());
  const capitalized = words.map((word) => word[0]?.toUpperCase() + word.slice(1));
  return {
    kebab: words.join('-'),
    pascal: capitalized.join(''),
    camel: (words[0] ?? '') + capitalized.slice(1).join(''),
    constant: words.join('_').toUpperCase(),
  };
}

/** A best-effort English singular of the last word: `notes` → `note`, `categories` → `category`. */
export function singular(input: Names): Names {
  const { kebab } = input;
  const word = kebab.split('-').at(-1) ?? kebab;
  let single = word;
  if (/[^aeiou]ies$/.test(word)) single = `${word.slice(0, -3)}y`;
  else if (/(?:ss|x|ch|sh)es$/.test(word)) single = word.slice(0, -2);
  else if (/[^s]s$/.test(word) && word.length > 3) single = word.slice(0, -1);
  return names(`${kebab.slice(0, kebab.length - word.length)}${single}`);
}
