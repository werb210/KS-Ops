// KS_OPS_AUTO_PROVISION_v1 - wiring: the production state-machine deps from the service's Deps.
import type { Deps } from "../deps.js";
import { dispatchWorkflow } from "./github.js";
import type { MachineDeps } from "./machine.js";
import { pgStore } from "./store.js";

export function machineDeps(deps: Pick<Deps, "db" | "fetch" | "mailer" | "now">): MachineDeps {
  return {
    db: deps.db,
    fetch: deps.fetch,
    mailer: deps.mailer,
    now: deps.now,
    store: pgStore(deps.db),
    dispatch: (file, inputs) => dispatchWorkflow(deps.fetch, file, inputs),
  };
}

/** Runs advanceRun without holding up the caller; errors are logged. */
export function kick(fn: () => Promise<unknown>): void {
  fn().catch((err) => console.error("[provisioning] advance failed", err instanceof Error ? err.message : String(err)));
}
