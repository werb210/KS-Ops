// KS_OPS_SIGNUP_FAVICON_v1
import { describe, expect, it } from "vitest";
import { checkFavicon } from "../../src/lib/logo.js";
import { BRAND_PUSH_FIELDS, brandingOf } from "../../src/sync/planPush.js";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const ICO = [0, 0, 1, 0, 1, 0, 16, 16];
const JPG = [0xff, 0xd8, 0xff, 0xe0];

describe("sign-up favicon", () => {
  it("accepts PNG, ICO and plain SVG", () => {
    expect(checkFavicon({ content_type: "image/png", data_base64: b64(PNG) })).toMatchObject({ ok: true, favicon: { contentType: "image/png" } });
    expect(checkFavicon({ content_type: "image/x-icon", data_base64: b64(ICO) })).toMatchObject({ ok: true, favicon: { contentType: "image/x-icon" } });
    expect(checkFavicon({ content_type: "image/svg+xml", data_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64") }).ok).toBe(true);
  });
  it("refuses JPG, unsafe SVG and empty files", () => {
    expect(checkFavicon({ content_type: "image/jpeg", data_base64: b64(JPG) }).ok).toBe(false);
    expect(checkFavicon({ content_type: "image/svg+xml", data_base64: Buffer.from("<svg><script>x</script></svg>").toString("base64") }).ok).toBe(false);
    expect(checkFavicon({ content_type: "image/png", data_base64: "" }).ok).toBe(false);
  });
  it("is pushed to the brokerage with the rest of the branding", () => {
    expect(BRAND_PUSH_FIELDS).toContain("favicon_url");
    expect(brandingOf({ favicon_url: "https://ops.example/api/public/favicons/abc" }).favicon_url).toBe("https://ops.example/api/public/favicons/abc");
  });
});
