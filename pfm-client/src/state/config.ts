import type { Env } from "../transport/names";

export interface Config {
  mode: "mock" | "relay" | "airlock" | "pubsub";
  env: Env;
  partner: string;
  relayUrl: string;
}

// Default: the Cloud Run mock FIU backend (sahamati-labs, asia-south1). Mock mode needs no network.
export const DEFAULTS: Config = { mode: "relay", env: "sandbox", partner: "pfm", relayUrl: "https://pfm-fiu-backend-334610188311.asia-south1.run.app" };

/** Memory-only secrets: never persisted, dropped when the app closes. */
export interface Secrets {
  token: string;
  bundleText: string;
  accessKey: string;
}
