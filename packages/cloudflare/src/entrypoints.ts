import './vela-env';
/** Native workerd classes: import only from a Worker entrypoint. */
export { ENTRYPOINT_PROPS, VelaEntrypoint } from './entrypoint/vela-entrypoint';
export type {
  EntrypointRpc,
  EntrypointRpcExecutionContext,
  EntrypointRpcMethod,
  VelaEntrypointClass,
  VelaEntrypointOptions,
} from './entrypoint/vela-entrypoint';
