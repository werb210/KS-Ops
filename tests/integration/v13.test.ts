// KS-Ops v13 on the real schema: sign-up with the address in parts, extra colours and an uploaded logo; the staff free
// trial from start to end.
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { endAdminTrials } from "../../src/billing/adminTrial.js";
import { planPushBody } from "../../src/sync/planPush.js";
import { getLicensee } from "../../src/licensees/repo.js";
import { fakeMailer, fakeStripe, staffToken, validSignup } from "../helpers.js";
import { freshPool, seedPrices } from "./db.js";

let pool: pg.Pool;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

beforeAll(async () => {
  pool = await freshPool();
  await pool.query("TRUNCATE licensee_logos");
  await seedPrices(pool);
});
afterAll(async () => {
  await pool?.end();
});

const deps = (over: Record<string, unknown> = {}) => ({
  db: pool,
  fetch: vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
  mailer: fakeMailer().mailer,
  stripe: () => null,
  now: () => new Date(),
  ...over,
});

describe("sign-up v13 (real database)", () => {
  it("stores the address in parts plus the one-line address, the extra colours and the logo", async () => {
    const app = createApp(deps() as never);
    const res = await request(app).post("/api/public/signup").send({
      ...validSignup(), company_code: "parts-co", mailing_address: undefined,
      address_line1: "100 Main Street", address_line2: "Suite 4", city: "Calgary", postal_code: "t2p1a1",
      primary_color: "#1F4E79", accent_color: "#2563EB", background_color: "#F5F7FA",
      logo_file: { content_type: "image/png", data_base64: PNG.toString("base64"), filename: "logo.png" },
    });
    expect(res.status).toBe(201);
    const l = (await getLicensee(pool, res.body.licensee_id))!;
    expect(l).toMatchObject({
      address_line1: "100 Main Street", address_line2: "Suite 4", city: "Calgary", postal_code: "T2P 1A1",
      mailing_address: "100 Main Street, Suite 4, Calgary AB T2P 1A1, Canada",
      accent_color: "#2563EB", background_color: "#F5F7FA",
    });
    expect(l.logo_url).toMatch(/\/api\/public\/logos\/[A-Za-z0-9_-]+$/);
    const logo = await request(app).get(new URL(l.logo_url!).pathname);
    expect(logo.status).toBe(200);
    expect(Buffer.from(logo.body).equals(PNG)).toBe(true);
  });

  it("an older row with only mailing_address still reads and edits fine", async () => {
    const app = createApp(deps() as never);
    const res = await request(app).post("/api/public/signup").send({ ...validSignup(), company_code: "legacy-co" });
    expect(res.status).toBe(201);
    const id = res.body.licensee_id;
    expect((await getLicensee(pool, id))!).toMatchObject({ mailing_address: "100 Main Street, Calgary AB T2P 1A1", address_line1: null });
    const patch = await request(app).patch(`/api/ops/licensees/${id}`).set("Authorization", `Bearer ${staffToken()}`)
      .send({ address_line1: "200 New Street", city: "Edmonton", postal_code: "t5j0n3", province_state: "AB" });
    expect(patch.status).toBe(200);
    expect(patch.body.licensee).toMatchObject({ postal_code: "T5J 0N3", mailing_address: "200 New Street, Edmonton AB T5J 0N3, Canada" });
  });
});

describe("staff free trial (real database)", () => {
  it("starts on a pending sign-up, records who started it, pushes Pro, and ends after 28 days", async () => {
    const start = new Date("2026-10-24T18:00:00Z");
    const stripe = fakeStripe({ customers: { update: vi.fn(), create: vi.fn(async () => ({ id: "cus_it" })) } });
    const create = vi.fn(async () => ({ id: "sub_it", status: "trialing" }));
    (stripe.subscriptions as Record<string, unknown>).create = create;
    const { mailer, sent } = fakeMailer();
    const app = createApp(deps({ stripe: () => stripe, mailer, now: () => start }) as never);
    const signup = await request(createApp(deps() as never)).post("/api/public/signup").send({ ...validSignup(), company_code: "trial-co" });
    const id = signup.body.licensee_id;
    await pool.query("UPDATE licensees SET server_url = 'https://trial-co.azurewebsites.net' WHERE id = $1", [id]);

    const res = await request(app).post("/api/ops/trials").set("Authorization", `Bearer ${staffToken()}`).send({ licensee_id: id });
    expect(res.status).toBe(201);
    const l = (await getLicensee(pool, id))!;
    expect(l).toMatchObject({ plan: "starter", billing_interval: "monthly", status: "trial", admin_trial_started_by: "admin@example.test", stripe_subscription_id: "sub_it" });
    expect(new Date(l.admin_trial_billing_starts_at!).toISOString()).toBe("2026-11-07T18:00:00.000Z");
    expect(planPushBody(l, new Date("2026-11-10T00:00:00Z")).plan).toBe("pro");
    const audited = await pool.query("SELECT actor FROM staff_audit WHERE licensee_id = $1 AND action = 'licensee.admin_trial_started'", [id]);
    expect(audited.rows).toEqual([{ actor: "admin@example.test" }]);
    expect(sent.some((m) => m.to.includes("nora@northwind.example") && /trial has started/.test(m.subject))).toBe(true);
    const list = await request(app).get("/api/ops/trials").set("Authorization", `Bearer ${staffToken()}`);
    expect(list.body.trials.map((t: { company_code: string }) => t.company_code)).toContain("trial-co");

    expect(await endAdminTrials({ db: pool, mailer, now: () => new Date("2026-11-20T00:00:00Z") })).toBe(0);
    expect(await endAdminTrials({ db: pool, mailer, now: () => new Date("2026-11-22T00:00:00Z") })).toBe(1);
    const ended = (await getLicensee(pool, id))!;
    expect(ended).toMatchObject({ status: "active", plan: "starter", admin_trial_end_reason: "ended", plan_sync_status: "pending_sync" });
    expect(planPushBody(ended, new Date("2026-11-22T00:00:00Z")).plan).toBe("starter");
    expect(await endAdminTrials({ db: pool, mailer, now: () => new Date("2026-11-23T00:00:00Z") })).toBe(0);
  });

  it("creates a new prospect and starts the trial in one call", async () => {
    const stripe = fakeStripe({ customers: { update: vi.fn(), create: vi.fn(async () => ({ id: "cus_new" })) } });
    (stripe.subscriptions as Record<string, unknown>).create = vi.fn(async () => ({ id: "sub_new" }));
    const app = createApp(deps({ stripe: () => stripe }) as never);
    const res = await request(app).post("/api/ops/trials").set("Authorization", `Bearer ${staffToken()}`).send({
      licensee: {
        company_name: "Prospect Co", legal_name: "Prospect Co Ltd", company_code: "prospect-co", contact_name: "Pat Prospect",
        contact_email: "pat@prospect.example", contact_phone: "(403) 555-0111", seats: 2, country: "CA", province_state: "AB",
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.licensee_created).toBe(true);
    expect(res.body.licensee).toMatchObject({ status: "provisioning", plan: "starter", source: "staff" });
  });
});
