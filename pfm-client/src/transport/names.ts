/**
 * Queue resource names — derived, never configured, mirroring
 * terraform/modules/partner and requester/src/config.ts so they cannot drift.
 *
 * prod is deliberately not offered: this app is a sandbox/preprod client until
 * the FIU-backend relay exists (see README → "Transport").
 */
export type Env = "sandbox" | "preprod";

const PROJECTS: Record<Env, string> = { sandbox: "sahamati-cs-sandbox", preprod: "sahamati-cs-preprod" };
const REGION = "asia-south1";
const KEYRING = "sahamati-cs-release";

export interface ResourceNames {
  env: Env;
  partner: string;
  requestTopic: string;
  replySubscription: string;
  /** We hold ENCRYPT on this. */
  requestKek: string;
  /** We hold DECRYPT on this. */
  replyKek: string;
  /** VP audience: a presentation captured for one workload must not replay into another. */
  audience: string;
}

export function resolveNames(env: Env, partner: string): ResourceNames {
  const project = PROJECTS[env];
  if (!project) throw new Error(`unknown env "${String(env)}"`);
  if (!/^[a-z][a-z0-9-]{1,28}$/.test(partner)) throw new Error("partner id must be lowercase letters, digits, hyphens");
  const key = (n: string) => `projects/${project}/locations/${REGION}/keyRings/${KEYRING}/cryptoKeys/${n}`;
  return {
    env,
    partner,
    requestTopic: `projects/${project}/topics/cs-${partner}-requests`,
    replySubscription: `projects/${project}/subscriptions/cs-${partner}-replies-sub`,
    requestKek: key(`kek-${partner}`),
    replyKek: key(`kek-${partner}-out`),
    audience: `urn:sahamati:cs-workload:${env}:${partner}`,
  };
}
