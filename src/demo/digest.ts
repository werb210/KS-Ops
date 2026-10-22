// What a prospect did in the demo, worked out from the progress events the demo server sent. Used for the sales emails
// and kept on the sign-up (digest) after the events themselves are deleted.
import { DEMO_STEPS } from "./config.js";

export type DemoEvent = { type: string; step: string | null; data: Record<string, any>; at: Date | string };

export type Digest = {
  events: number;
  first_at: string | null;
  last_at: string | null;
  active_seconds: number;
  elapsed_seconds: number;
  steps_completed: string[];
  steps_skipped: string[];
  last_step: string | null;
  tour_skipped: boolean;
  used_phone: boolean;
  phone_device: string | null;
  used_screen: boolean;
  documents_uploaded: string[];
  decisions: Array<{ document: string; decision: string; fraud_status: string | null }>;
  doctored: "rejected" | "accepted" | "not_reviewed" | "not_uploaded";
  call: "completed" | "answered" | "declined" | "rang" | "not_reached";
  assistant_questions: number;
  lenders: string[];
  submitted: boolean;
  package_downloaded: boolean;
  clicks: string[];
};

const STEP_ORDER = DEMO_STEPS.map(([k]) => k);
const MAX_GAP_SECONDS = 300;

export function digestEvents(input: DemoEvent[]): Digest {
  const events = [...input].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const completed = new Set<string>();
  const skipped = new Set<string>();
  const uploaded: string[] = [];
  const decisions = new Map<string, { document: string; decision: string; fraud_status: string | null }>();
  const clicks: string[] = [];
  let lastStep: string | null = null;
  let tourSkipped = false, usedPhone = false, usedScreen = false, submitted = false, downloaded = false;
  let phoneDevice: string | null = null;
  let call: Digest["call"] = "not_reached";
  let questions = 0;
  let lenders: string[] = [];
  let heartbeat = 0;
  let gaps = 0;
  let prev: number | null = null;
  let doctoredUploaded = false;
  let doctoredDecision: string | null = null;

  for (const e of events) {
    const t = new Date(e.at).getTime();
    if (prev != null) gaps += Math.min(MAX_GAP_SECONDS, Math.max(0, (t - prev) / 1000));
    prev = t;
    const d = e.data ?? {};
    const step = e.step && STEP_ORDER.includes(e.step) ? e.step : null;
    // The furthest step any action happened on.
    if (step) {
      if (lastStep == null || STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf(lastStep)) lastStep = step;
    }
    switch (e.type) {
      case "step_completed": if (step) { completed.add(step); skipped.delete(step); } break;
      case "step_skipped": if (step && !completed.has(step)) skipped.add(step); break;
      case "tour_skipped": tourSkipped = true; break;
      case "tour_resumed": tourSkipped = false; break;
      case "borrower_joined":
        if (d.via === "screen") usedScreen = true;
        else { usedPhone = true; if (typeof d.device === "string") phoneDevice = d.device; }
        break;
      case "document_uploaded":
        if (typeof d.document === "string" && !uploaded.includes(d.document)) uploaded.push(d.document);
        if (d.fraud_status === "red") doctoredUploaded = true;
        break;
      case "document_decision":
        if (typeof d.document === "string") decisions.set(d.document, { document: d.document, decision: String(d.decision), fraud_status: d.fraud_status ?? null });
        if (d.fraud_status === "red") doctoredDecision = String(d.decision);
        break;
      case "call_rang": if (call === "not_reached") call = "rang"; break;
      case "call_answered": if (call !== "completed") call = "answered"; break;
      case "call_declined": if (call !== "completed") call = "declined"; break;
      case "call_completed": call = "completed"; completed.add("call"); break;
      case "financials_reviewed": completed.add("financials"); break;
      case "credit_summary_built": completed.add("credit_summary"); break;
      case "assistant_question": questions++; break;
      case "lenders_selected": lenders = Array.isArray(d.lenders) ? d.lenders.map(String) : lenders; break;
      case "submitted":
        submitted = true; completed.add("lenders"); completed.add("submit"); lastStep = "submit";
        if (Array.isArray(d.lenders)) lenders = d.lenders.map(String);
        break;
      case "package_downloaded": downloaded = true; break;
      case "heartbeat": heartbeat += Math.max(0, Math.min(120, Number(d.seconds) || 0)); break;
      case "click": if (typeof d.name === "string" && !clicks.includes(d.name)) clicks.push(d.name); break;
      default: break;
    }
  }
  for (const s of completed) skipped.delete(s);
  const first = events[0] ? new Date(events[0].at) : null;
  const last = events.length ? new Date(events[events.length - 1]!.at) : null;
  return {
    events: events.length,
    first_at: first?.toISOString() ?? null,
    last_at: last?.toISOString() ?? null,
    // Heartbeats (sent each minute the portal is on screen) when there are any; otherwise the time between events,
    // counting at most five minutes for any one gap.
    active_seconds: Math.round(heartbeat > 0 ? Math.max(heartbeat, 0) : gaps),
    elapsed_seconds: first && last ? Math.round((last.getTime() - first.getTime()) / 1000) : 0,
    steps_completed: STEP_ORDER.filter((s) => completed.has(s)),
    steps_skipped: STEP_ORDER.filter((s) => skipped.has(s)),
    last_step: lastStep,
    tour_skipped: tourSkipped,
    used_phone: usedPhone,
    phone_device: phoneDevice,
    used_screen: usedScreen,
    documents_uploaded: uploaded,
    decisions: [...decisions.values()],
    doctored: doctoredDecision === "rejected" ? "rejected" : doctoredDecision === "accepted" ? "accepted" : doctoredUploaded ? "not_reviewed" : "not_uploaded",
    call,
    assistant_questions: questions,
    lenders,
    submitted,
    package_downloaded: downloaded,
    clicks,
  };
}

export function minutes(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
