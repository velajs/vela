export function emptyArgs(value: unknown): Record<string, never> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length
  )
    throw new Error('Expected empty args');
  return {};
}
export function listArgs(value: unknown): { listId: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('listId' in value) ||
    typeof value.listId !== 'string'
  )
    throw new Error('Expected listId');
  return { listId: value.listId };
}
export function idRows(value: unknown): { id: string }[] {
  if (!Array.isArray(value)) throw new Error('Expected rows');
  return value.map((row: unknown) => {
    if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string')
      throw new Error('Expected row id');
    return { ...row, id: row.id };
  });
}
export function doneRows(value: unknown): { id: string; done: boolean }[] {
  if (!Array.isArray(value)) throw new Error('Expected rows');
  return value.map((row: unknown) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('id' in row) ||
      typeof row.id !== 'string' ||
      !('done' in row) ||
      typeof row.done !== 'boolean'
    )
      throw new Error('Expected todo');
    return { id: row.id, done: row.done };
  });
}
export const emptyListSchema = { args: { parse: emptyArgs }, result: { parse: idRows } };
export const todoSchema = { args: { parse: listArgs }, result: { parse: idRows } };
