import { describe, expect, it } from 'vitest';
import { MemoryFlagDriver, createTestFeatureFlags } from '../testing/index';

describe('@velajs/feature-flags/testing', () => {
  it('createTestFeatureFlags returns a real service over a memory driver', async () => {
    const { service, driver } = createTestFeatureFlags({ 'new-checkout': true });
    expect(driver).toBeInstanceOf(MemoryFlagDriver);
    expect(await service.getBooleanValue('new-checkout')).toBe(true);
  });

  it('flags flipped on the driver are observed by the service', async () => {
    const { service, driver } = createTestFeatureFlags({ 'new-checkout': true });
    driver.set('new-checkout', false);
    expect(await service.getBooleanValue('new-checkout')).toBe(false);
    driver.reset();
    // back to manifest/zero default once the stored value is gone
    expect(await service.getBooleanValue('new-checkout')).toBe(false);
  });

  it('applies a provided manifest for defaults', async () => {
    const { service } = createTestFeatureFlags({}, { manifest: { layout: 'v2' } });
    expect(await service.getStringValue('layout')).toBe('v2');
  });
});
