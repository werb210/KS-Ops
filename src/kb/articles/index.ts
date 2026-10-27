// KS_OPS_KB_v1 - the starter help library, written from what the Keystone code does (October 2026). Plain English,
// short steps. Rules for every article here (and for new ones):
//   - never Keystone's internal costs or margins, only published prices;
//   - never the vendor's private phone line;
//   - anything not built is "coming soon", never described as working.
// Links to other articles use kb:<slug>. Loaded once by src/kb/seed.ts.
import type { Audience } from "../model.js";
import type { Plan } from "../../pricing.js";
import { GETTING_STARTED } from "./gettingStarted.js";
import { CLIENTS_AND_PIPELINE } from "./clientsPipeline.js";
import { LENDERS_AND_CRM } from "./lendersCrm.js";
import { COMMUNICATIONS } from "./communications.js";
import { PHONE } from "./phone.js";
import { MARKETING_AND_REPORTS } from "./marketingReports.js";
import { PLANS_AND_BILLING } from "./plansBilling.js";
import { SECURITY_AND_DATA } from "./securityData.js";

export type SeedArticle = {
  slug: string;
  title: string;
  category: string;
  audience: Audience;
  /** Empty = every plan. */
  plans: Plan[];
  summary: string;
  body: string;
};

export const STARTER_ARTICLES: SeedArticle[] = [
  ...GETTING_STARTED,
  ...CLIENTS_AND_PIPELINE,
  ...LENDERS_AND_CRM,
  ...COMMUNICATIONS,
  ...PHONE,
  ...MARKETING_AND_REPORTS,
  ...PLANS_AND_BILLING,
  ...SECURITY_AND_DATA,
];
