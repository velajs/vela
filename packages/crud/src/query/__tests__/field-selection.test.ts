import { describe, expect, it } from 'vitest';
import {
  applyFieldSelection,
  applyFieldSelectionToArray,
  parseFieldSelection,
  type FieldSelection,
  type FieldSelectionConfig,
} from '../field-selection';

const testRecord = {
  id: '123',
  name: 'John Doe',
  email: 'john@example.com',
  password: 'secret123',
  role: 'admin',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-15',
};

const testRecords = [
  testRecord,
  {
    id: '456',
    name: 'Jane Smith',
    email: 'jane@example.com',
    password: 'secret456',
    role: 'user',
    createdAt: '2024-01-02',
    updatedAt: '2024-01-16',
  },
];

describe('parseFieldSelection', () => {
  it('parses comma-separated field names', () => {
    const selection = parseFieldSelection('id,name,email', {}, [
      'id',
      'name',
      'email',
      'password',
      'role',
      'createdAt',
    ]);
    expect(selection.isActive).toBe(true);
    expect(selection.fields).toHaveLength(3);
    expect(selection.fields).toEqual(expect.arrayContaining(['id', 'name', 'email']));
  });

  it('filters out blocked fields', () => {
    const config: FieldSelectionConfig = { blockedFields: ['password'] };
    const selection = parseFieldSelection('id,name,password', config, [
      'id',
      'name',
      'email',
      'password',
      'role',
    ]);
    expect(selection.fields).not.toContain('password');
    expect(selection.fields).toEqual(expect.arrayContaining(['id', 'name']));
  });

  it('only includes allowed fields when configured', () => {
    const config: FieldSelectionConfig = { allowedFields: ['id', 'name', 'email'] };
    const selection = parseFieldSelection('id,name,role,password', config, [
      'id',
      'name',
      'email',
      'password',
      'role',
    ]);
    expect(selection.fields).toEqual(expect.arrayContaining(['id', 'name']));
    expect(selection.fields).not.toContain('role');
    expect(selection.fields).not.toContain('password');
  });

  it('always includes specified fields', () => {
    const config: FieldSelectionConfig = { alwaysIncludeFields: ['id'] };
    const selection = parseFieldSelection('name,email', config, [
      'id',
      'name',
      'email',
      'password',
      'role',
    ]);
    expect(selection.fields).toEqual(expect.arrayContaining(['id', 'name', 'email']));
  });

  it('is inactive for empty / null / undefined params', () => {
    expect(parseFieldSelection('', {}, ['id', 'name']).isActive).toBe(false);
    expect(parseFieldSelection(null, {}, ['id', 'name']).isActive).toBe(false);
    expect(parseFieldSelection(undefined, {}, ['id', 'name']).isActive).toBe(false);
  });

  it('applies default fields (inactive) when no param provided', () => {
    const config: FieldSelectionConfig = {
      defaultFields: ['id', 'name'],
      alwaysIncludeFields: ['createdAt'],
    };
    const selection = parseFieldSelection(undefined, config, ['id', 'name', 'email', 'createdAt']);
    expect(selection.isActive).toBe(false);
    expect(selection.fields).toEqual(expect.arrayContaining(['id', 'name', 'createdAt']));
  });

  it('supports computed and relation fields', () => {
    const selection = parseFieldSelection(
      'id,name,fullName,posts',
      {},
      ['id', 'name', 'email'],
      ['fullName', 'age'],
      ['posts', 'profile'],
    );
    expect(selection.fields).toEqual(expect.arrayContaining(['id', 'name', 'fullName', 'posts']));
  });

  it('can disable computed fields', () => {
    const config: FieldSelectionConfig = { allowComputedFields: false };
    const selection = parseFieldSelection(
      'id,name,fullName',
      config,
      ['id', 'name'],
      ['fullName'],
      [],
    );
    expect(selection.fields).toEqual(expect.arrayContaining(['id', 'name']));
    expect(selection.fields).not.toContain('fullName');
  });

  it('can disable relation fields', () => {
    const config: FieldSelectionConfig = { allowRelationFields: false };
    const selection = parseFieldSelection('id,posts', config, ['id'], [], ['posts']);
    expect(selection.fields).toContain('id');
    expect(selection.fields).not.toContain('posts');
  });
});

describe('applyFieldSelection', () => {
  it('selects only the specified fields', () => {
    const selection: FieldSelection = { fields: ['id', 'name', 'email'], isActive: true };
    const result = applyFieldSelection(testRecord, selection);
    expect(result).toEqual({ id: '123', name: 'John Doe', email: 'john@example.com' });
    expect('password' in result).toBe(false);
  });

  it('returns all fields when selection is inactive', () => {
    const selection: FieldSelection = { fields: [], isActive: false };
    const result = applyFieldSelection(testRecord, selection);
    expect(Object.keys(result)).toHaveLength(Object.keys(testRecord).length);
    expect(result.password).toBe('secret123');
  });
});

describe('applyFieldSelectionToArray', () => {
  it('applies selection to every record', () => {
    const selection: FieldSelection = { fields: ['id', 'name'], isActive: true };
    const result = applyFieldSelectionToArray(testRecords, selection);
    expect(result).toHaveLength(2);
    expect(Object.keys(result[0])).toHaveLength(2);
    expect(result[0].name).toBe('John Doe');
    expect(result[1].name).toBe('Jane Smith');
  });
});
