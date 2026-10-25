// KS_OPS_AUTO_PROVISION_v1 - prints what automatic provisioning (or teardown) would do for a company code, without
// calling Azure, GitHub or KS-Ops. Usage: npm run provision:plan -- <company_code> [provision|teardown] [region]
import { describePlan, DEFAULT_REGION, type RunKind } from "../src/provisioning/steps.js";

const [code, kindArg, region] = process.argv.slice(2);
if (!code || !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(code) || code.includes("--")) {
  console.error("Usage: npm run provision:plan -- <company_code> [provision|teardown] [region]");
  process.exit(2);
}
const kind: RunKind = kindArg === "teardown" ? "teardown" : "provision";
console.log(`Dry run: ${kind} of "${code}" (nothing is changed)\n`);
describePlan(kind, code, region || DEFAULT_REGION).forEach((line, i) => console.log(`${String(i + 1).padStart(2)}. ${line}`));
