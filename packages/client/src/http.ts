import type { Hono } from 'hono';
import type { BlankEnv, Schema } from 'hono/types';

// Keep HTTP opt-in: importing the live client does not load Hono's client.
export { hc, parseResponse, DetailedError } from 'hono/client';
export type {
  ApplyGlobalResponse,
  ClientRequestOptions,
  ClientResponse,
  InferRequestType,
  InferResponseType,
  PickResponseByStatusCode,
} from 'hono/client';
export type { StatusCode as HttpStatus } from 'hono/utils/http-status';

/** A generated HTTP contract. This imports no server code at runtime. */
export type HttpApp<Routes extends Schema> = Hono<BlankEnv, Routes>;
