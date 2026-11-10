// KS_OPS_PROSPECT_MARKETING_v1 - the marketing worker, run every 30 seconds (src/workers.ts):
//   every run       campaign sends, sequence steps, the CRM timeline outbox
//   every 2 min     prospect sync from KS-Ops's own records (demo, beta, website assistant, licensees)
//   every 5 min     replies in the reply mailbox
//   every 10 min    Keystone CRM contacts from BF-Server
// The sync runs before the sends, so a sign-up or demo booking stops a sequence before its next step goes out.
// Each part logs its own failure and never stops the others.
import type { Deps } from "../deps.js";
import { runCampaigns, runSequences } from "./engine.js";
import { flushTimelineOutbox, pollReplies } from "./events.js";
import { pullCrmContacts, syncLocalSources } from "./prospects.js";

export type MarketingClock = { sync: number; replies: number; crm: number };
export const newMarketingClock = (): MarketingClock => ({ sync: 0, replies: 0, crm: 0 });

async function part(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const r = await fn();
    if (r && typeof r === "object" && Object.values(r).some((v) => typeof v === "number" && v > 0)) {
      console.log(`[workers] marketing ${name}`, JSON.stringify(r));
    }
  } catch (err) {
    console.error(`[workers] marketing ${name} failed`, err instanceof Error ? err.message : String(err));
  }
}

export async function runMarketingTick(deps: Deps, clock: MarketingClock): Promise<void> {
  const t = deps.now().getTime();
  if (t - clock.sync >= 2 * 60_000) {
    clock.sync = t;
    await part("sync", () => syncLocalSources(deps));
  }
  if (t - clock.crm >= 10 * 60_000) {
    clock.crm = t;
    await part("crm pull", () => pullCrmContacts(deps));
  }
  if (t - clock.replies >= 5 * 60_000) {
    clock.replies = t;
    await part("replies", () => pollReplies(deps));
  }
  await part("campaigns", () => runCampaigns(deps));
  await part("sequences", () => runSequences(deps));
  await part("crm timeline", () => flushTimelineOutbox(deps));
}
