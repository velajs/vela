import { ENVELOPE_PREFIX, type TextCipher } from '../index';
export interface FieldProtectionOptions {
  fields: readonly string[];
  /** Use a distinct purpose per field, derived from an admitted tenant scope. */
  cipher: (field: string) => TextCipher;
  authorizeRead: (
    field: string,
    row: Readonly<Record<string, unknown>>,
  ) => boolean | Promise<boolean>;
}
export function fieldProtection(options: FieldProtectionOptions) {
  const fields = [...new Set(options.fields)];
  return {
    async protect(row: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
      const output = { ...row };
      for (const field of fields) {
        const value = row[field];
        if (value === undefined) continue;
        const cipher = options.cipher(field);
        if (typeof value === 'string' && value.startsWith('vela:enc:')) {
          await cipher.decryptText(value);
          output[field] = value;
          continue;
        }
        const json = JSON.stringify(value);
        if (json === undefined) throw new TypeError('Protected fields must contain JSON values');
        output[field] = await cipher.encryptText(json);
      }
      return output;
    },
    async reveal(row: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
      const output = { ...row };
      for (const field of fields) {
        if (!Object.hasOwn(row, field)) continue;
        if ((await options.authorizeRead(field, row)) !== true) {
          delete output[field];
          continue;
        }
        const value = row[field];
        if (typeof value !== 'string' || !value.startsWith(ENVELOPE_PREFIX))
          throw new TypeError('Expected a protected field');
        output[field] = JSON.parse(await options.cipher(field).decryptText(value));
      }
      return output;
    },
  };
}
