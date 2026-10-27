// KS_OPS_KB_v1 - what the Keystone Maya assistants may never say, checked on every reply after the model answers
// (the prompts say the same, but a reply is never trusted to have followed them).
//   - Keystone's internal costs, margins or what Keystone pays its suppliers: the whole reply is replaced.
//   - The vendor's private phone line: removed.

export const PRIVATE_NUMBER_RE = /\(?\b587\)?[\s.\-)]*888[\s.-]*1837\b/g;

const INTERNAL_COST_RES: RegExp[] = [
  /\bmargins?\b/i,
  /\b(price|cost|our|keystone'?s?)\s+mark-?ups?\b/i,
  /\bmark-?ups?\s+(on|of)\s+(the\s+)?(price|cost|minutes?|texts?|seats?)/i,
  /\bwholesale\b/i,
  /\b(our|keystone'?s?|internal|underlying|supplier|vendor)\s+(own\s+)?(costs?|cost price|unit costs?)\b/i,
  /\bcosts? (us|keystone)\b/i,
  /\b(we|keystone) pays?\s+(twilio|openai|microsoft|azure|signnow|sendgrid|stripe|flinks|google)\b/i,
  /\b(twilio|openai|azure|signnow|sendgrid)\s+(charges|bills|costs)\b/i,
  /\bprofit\b/i,
];

export const INTERNAL_COST_REPLY =
  "I can't share Keystone's internal costs. I'm happy to go through the published prices: seats per plan, the support levels, extra storage and usage over your allowance.";

export function mentionsInternalCosts(text: string): boolean {
  return INTERNAL_COST_RES.some((re) => re.test(text));
}

/** The reply as it may be shown. `replaced` says the whole reply was swapped for the safe one. */
export function guardReply(text: string): { text: string; replaced: boolean } {
  const clean = String(text ?? "").replace(PRIVATE_NUMBER_RE, "the Keystone team").trim();
  if (mentionsInternalCosts(clean)) return { text: INTERNAL_COST_REPLY, replaced: true };
  return { text: clean, replaced: false };
}

/** "Can I talk to a person?" and the like. */
export function wantsPerson(text: string): boolean {
  return /\b(talk|speak|chat)\s+(to|with)\s+(a|an|the|some)?\s*(real\s+|actual\s+)?(person|human|agent|someone|rep|representative|sales|support|team)\b/i.test(text) ||
    /\b(real|actual)\s+(person|human)\b/i.test(text) ||
    /\b(contact|call|email)\s+(support|sales|someone|a person|a human)\b/i.test(text) ||
    /\bhuman\b/i.test(text);
}
