import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { BotToolDef } from "../../brain/types";
import { GoogleApi } from "../../google/api";
import { REAL_GOOGLE } from "../../google/endpoints";
import { GoogleAuth } from "../../google/oauth";
import { GoogleStore } from "../../google/store";
import { createGoogleTools } from "../../google/tools";
import { vaultKeySync } from "../../secrets/crypto";

/**
 * Live, read-only checks against the user's real Google account, through the client and tokens the app stored
 * after the user connected (Settings → Connected accounts → Google). Run it only after connecting:
 *   RUN_GOOGLE=1 HOST_PRIVATE=/home/box/.host WORKSPACE=/workspace npx vitest run host/test/google/google.integration.test.ts
 * It never sends, drafts, writes or uploads, and it never prints a token.
 */
describe.skipIf(process.env.RUN_GOOGLE !== "1")("built-in Google connector (live, read-only)", () => {
  const hostPrivate = process.env.HOST_PRIVATE ?? "/home/box/.host";
  let auth: GoogleAuth;
  let tools: BotToolDef[];
  beforeAll(() => {
    auth = new GoogleAuth({ store: new GoogleStore(path.join(hostPrivate, "google", "account.json"), vaultKeySync(hostPrivate)), endpoints: () => REAL_GOOGLE, now: Date.now });
    tools = createGoogleTools({ api: new GoogleApi({ auth, endpoints: () => REAL_GOOGLE }), auth, workspace: process.env.WORKSPACE ?? "/workspace", hostPrivate });
  });
  const run = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.handler(args);
  const clean = (text: string) => { for (const s of auth.secrets()) expect(text.includes(s)).toBe(false); };

  it("is connected with all three services", () => {
    const st = auth.status();
    expect(st.state).toBe("connected");
    expect(st.services).toEqual(["Gmail", "Calendar", "Drive"]);
  });

  it("refreshes the access token", async () => {
    await expect(auth.accessToken(true)).resolves.toEqual(expect.any(String));
  }, 30_000);

  it("reads Gmail, Calendar and Drive", async () => {
    const mail = await run("gmail_search", { query: "newer_than:30d", max: 3 });
    expect(mail.isError).toBeFalsy();
    clean(mail.text);
    const id = /id: (\w+)/.exec(mail.text)?.[1];
    if (id) {
      const msg = await run("gmail_read", { id });
      expect(msg.isError).toBeFalsy();
      clean(msg.text);
    }
    const cal = await run("calendar_list", { from: new Date().toISOString() });
    expect(cal.isError).toBeFalsy();
    clean(cal.text);
    const drive = await run("drive_search", { query: "", max: 3 });
    expect(drive.isError).toBeFalsy();
    clean(drive.text);
  }, 60_000);
});
