import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createZodDto } from '../validation/index.js';

describe('createZodDto — polish', () => {
  it('exposes schema as a static property (existing contract)', () => {
    const schema = z.object({ name: z.string() });
    const Dto = createZodDto(schema);
    expect(Dto.schema).toBe(schema);
  });

  it('constructor accepts initial values and Object.assigns them', () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const Dto = createZodDto(schema);

    const instance = new Dto({ name: 'Alice', age: 30 });
    expect((instance as { name: string }).name).toBe('Alice');
    expect((instance as { age: number }).age).toBe(30);
  });

  it('constructor with no args produces an empty instance', () => {
    const schema = z.object({ name: z.string() });
    const Dto = createZodDto(schema);

    const instance = new Dto();
    expect(instance).toBeDefined();
    expect(Object.keys(instance as object)).toEqual([]);
  });

  it('supports an optional name to customize the class name', () => {
    const schema = z.object({ name: z.string() });
    const Dto = createZodDto(schema, { name: 'CreateUserDto' });
    expect(Dto.name).toBe('CreateUserDto');
  });

  it('defaults the class name when no option is passed', () => {
    const schema = z.object({ name: z.string() });
    const Dto = createZodDto(schema);
    // Any non-empty name is fine — just verify we don't regress to ''
    expect(typeof Dto.name).toBe('string');
    expect(Dto.name.length).toBeGreaterThan(0);
  });

  it('still supports `class X extends createZodDto(schema) {}` pattern', () => {
    const schema = z.object({ name: z.string() });
    class CreateUserDto extends createZodDto(schema) {}

    expect(CreateUserDto.schema).toBe(schema);
    const parsed = CreateUserDto.schema.parse({ name: 'Alice' });
    expect(parsed).toEqual({ name: 'Alice' });
  });
});
