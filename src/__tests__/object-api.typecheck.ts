import type { FeatureFlagDriver } from '../drivers/driver';
import type { FeatureFlagsService } from '../feature-flags.service';
import type { FlagEvaluationDetails } from '../feature-flags.types';

function parseTheme(value: unknown): { theme: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('theme' in value) ||
    typeof value.theme !== 'string'
  ) {
    throw new TypeError('theme must be a string');
  }
  return { theme: value.theme };
}

/** Compile-only checks; never execute invalid call examples. */
export function checkObjectFlagTypes(flags: FeatureFlagsService, driver: FeatureFlagDriver): void {
  const result: Promise<{ theme: string }> = flags.getObjectValue('layout', parseTheme, {
    theme: 'light',
  });
  const details: Promise<FlagEvaluationDetails<{ theme: string }>> = flags.getObjectDetails(
    'layout',
    parseTheme,
    { theme: 'light' },
  );
  const raw: Promise<unknown> = driver.getObject('layout', {});
  void [result, details, raw];

  // @ts-expect-error A raw driver cannot promise a caller-selected payload type.
  driver.getObject<{ theme: string }>('layout', {});
  // @ts-expect-error Object evaluations require a runtime parser and valid fallback.
  flags.getObjectValue<{ theme: string }>('layout', { theme: 'light' });
  // @ts-expect-error The fallback cannot widen the parser's result type.
  flags.getObjectValue('layout', parseTheme, { theme: 1 });
  // @ts-expect-error An explicit result generic cannot contradict the parser result.
  flags.getObjectValue<{ count: number }>('layout', parseTheme, { count: 1 });
}
