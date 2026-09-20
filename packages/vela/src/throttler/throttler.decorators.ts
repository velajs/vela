import { SetMetadata } from '../pipeline/reflector';
import { THROTTLE_METADATA, SKIP_THROTTLE_METADATA } from './throttler.tokens';
import type { ThrottleConfig } from './throttler.types';

export const Throttle = (config: ThrottleConfig) => SetMetadata(THROTTLE_METADATA, config);

export const SkipThrottle = () => SetMetadata(SKIP_THROTTLE_METADATA, true);
