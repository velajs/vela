// Shared injection vectors for the header-injection matrix. Not a test file —
// vitest only collects `*.test.ts`, so this stays a plain helper the matrix
// specs import. Vectors are written as escape sequences so the source is
// unambiguous about which code point each one carries.

/**
 * Control/newline code points that must never reach header context on ANY path.
 * CRLF is a distinct vector because a single-character check that missed the
 * pair would still be a hole.
 */
export const CONTROL_VECTORS: ReadonlyArray<{ label: string; char: string }> = [
  { label: 'CR', char: '\r' },
  { label: 'LF', char: '\n' },
  { label: 'CRLF', char: '\r\n' },
  { label: 'NUL', char: '\u0000' },
  { label: 'NEL (U+0085)', char: '\u0085' },
  { label: 'LINE SEPARATOR (U+2028)', char: '\u2028' },
  { label: 'PARAGRAPH SEPARATOR (U+2029)', char: '\u2029' },
];

/** Address fields additionally reject a comma (would smuggle a second recipient). */
export const ADDRESS_VECTORS: ReadonlyArray<{ label: string; char: string }> = [
  ...CONTROL_VECTORS,
  { label: 'comma', char: ',' },
];
