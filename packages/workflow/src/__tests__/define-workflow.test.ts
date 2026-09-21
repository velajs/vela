import { describe, expect, it } from 'vitest';

import {
  defineWorkflow,
  isWorkflowDefinition,
  workflowBindingName,
  workflowClassName,
  workflowDefaultName,
} from '../index';

describe('defineWorkflow', () => {
  it('brands a valid config with isVelaWorkflow', () => {
    const wf = defineWorkflow<{ id: string }, string>({ handler: async (ctx) => ctx.params.id });

    expect(wf.isVelaWorkflow).toBe(true);
    expect(typeof wf.handler).toBe('function');
    expect(isWorkflowDefinition(wf)).toBe(true);
  });

  it('carries an explicit name override through', () => {
    const wf = defineWorkflow({ name: 'custom-name', handler: async () => undefined });
    expect(wf.name).toBe('custom-name');
  });

  it('throws when the handler is not a function', () => {
    expect(() => defineWorkflow({ handler: 123 as unknown as () => void })).toThrow(
      /expected `handler` to be a function/,
    );
  });

  it('throws when a provided name is empty', () => {
    expect(() => defineWorkflow({ name: '', handler: async () => undefined })).toThrow(
      /`name` must not be empty/,
    );
  });
});

describe('isWorkflowDefinition', () => {
  it('rejects non-branded values', () => {
    expect(isWorkflowDefinition(undefined)).toBe(false);
    expect(isWorkflowDefinition(null)).toBe(false);
    expect(isWorkflowDefinition({})).toBe(false);
    expect(isWorkflowDefinition({ isVelaWorkflow: false })).toBe(false);
    expect(isWorkflowDefinition({ handler: () => undefined })).toBe(false);
  });
});

describe('workflow naming helpers', () => {
  it('derives the entrypoint class name', () => {
    expect(workflowClassName('orderPipeline')).toBe('OrderPipelineWorkflow');
    expect(workflowClassName('etl')).toBe('EtlWorkflow');
    expect(workflowClassName('syncInventoryLevels')).toBe('SyncInventoryLevelsWorkflow');
  });

  it('derives the WORKFLOW_* binding name', () => {
    expect(workflowBindingName('orderPipeline')).toBe('WORKFLOW_ORDER_PIPELINE');
    expect(workflowBindingName('etl')).toBe('WORKFLOW_ETL');
    expect(workflowBindingName('syncInventoryLevels')).toBe('WORKFLOW_SYNC_INVENTORY_LEVELS');
  });

  it('derives the kebab-cased default deploy name', () => {
    expect(workflowDefaultName('orderPipeline')).toBe('order-pipeline');
    expect(workflowDefaultName('etl')).toBe('etl');
    expect(workflowDefaultName('syncInventoryLevels')).toBe('sync-inventory-levels');
  });
});
