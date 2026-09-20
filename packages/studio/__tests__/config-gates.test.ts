import { describe, expect, it } from 'vitest';
import { deriveWriteGates, resolveStudioConfig } from '../src';
import type { EditableFlags, StudioEnvConfig } from '../src';
import type { StudioWriteGates } from '@velajs/studio-protocol';

const ALL_OFF: EditableFlags = {
  data: false,
  schema: false,
  identity: false,
  ops: false,
  timeTravel: false,
  transfer: false,
};

describe('deriveWriteGates — one-to-one, no over-grant', () => {
  it('maps every category to exactly its own gate', () => {
    // The pairing under test: each EditableFlags key -> its StudioWriteGates key.
    const pairs: Array<[keyof EditableFlags, keyof StudioWriteGates]> = [
      ['data', 'dataEditable'],
      ['schema', 'schemaEditable'],
      ['identity', 'runAsIdentity'],
      ['ops', 'opsEditable'],
      ['timeTravel', 'timeTravelRestore'],
      ['transfer', 'transferImport'],
    ];
    for (const [flag, gate] of pairs) {
      const gates = deriveWriteGates({ ...ALL_OFF, [flag]: true });
      // The named gate opens...
      expect(gates[gate]).toBe(true);
      // ...and NOTHING else does (no capability leaks into another).
      for (const other of Object.keys(gates) as Array<keyof StudioWriteGates>) {
        if (other !== gate) expect(gates[other]).toBe(false);
      }
    }
  });

  it('all-off derives all gates closed', () => {
    expect(deriveWriteGates(ALL_OFF)).toEqual({
      dataEditable: false,
      schemaEditable: false,
      opsEditable: false,
      runAsIdentity: false,
      timeTravelRestore: false,
      transferImport: false,
    });
  });

  it('time-travel and transfer are independent of data (the fixed over-grant)', () => {
    const dataOnly = deriveWriteGates({ ...ALL_OFF, data: true });
    expect(dataOnly.timeTravelRestore).toBe(false);
    expect(dataOnly.transferImport).toBe(false);
  });
});

describe('resolveStudioConfig — env + options for the two new categories', () => {
  it('reads timeTravel/transfer from env', () => {
    const env: StudioEnvConfig = { timeTravel: true, transfer: true };
    const cfg = resolveStudioConfig(env, { token: 't' });
    expect(cfg.editable.timeTravel).toBe(true);
    expect(cfg.editable.transfer).toBe(true);
  });

  it('module options override env for the new categories', () => {
    const env: StudioEnvConfig = { timeTravel: true, transfer: true };
    const cfg = resolveStudioConfig(env, { token: 't', editable: { timeTravel: false } });
    expect(cfg.editable.timeTravel).toBe(false);
    expect(cfg.editable.transfer).toBe(true);
  });

  it('defaults the new categories closed when neither env nor options set them', () => {
    const cfg = resolveStudioConfig({}, { token: 't' });
    expect(cfg.editable.timeTravel).toBe(false);
    expect(cfg.editable.transfer).toBe(false);
  });
});
