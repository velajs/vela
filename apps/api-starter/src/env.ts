import { InjectionToken } from "@velajs/vela";
import type { LiveRoom } from "./worker";

export interface Env {
  DB: D1Database;
  LIVE_ROOM: DurableObjectNamespace<LiveRoom>;
  BETTER_AUTH_SECRET: string;
  APP_ORIGIN: string;
  VELA_STUDIO_TOKEN?: string;
}
export const ENV = new InjectionToken<Env>("api-starter environment");
export const GATEWAY = "/rooms/:room/ws";
