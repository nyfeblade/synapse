import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { decryptAes128gcm } from "../test/fixtures/webpush";
import { BOT, startHarness, type Harness } from "./harness";
import { REPORT, SPEECH_WAV } from "./setup";

/**
 * Bug 198: Phone access, end to end, on an emulated iPhone (WebKit) and Android phone (Chromium):
 * pair → the Bots → call Nova → Nova hears the words → Nova's voice reaches the phone and plays →
 * talking over Nova stops her → hang up → the hang-up tone. Every Mac-side piece is the real one
 * (phone server, dictation, the helper with --remote-audio and Apple's recognizer, the call loop);
 * the Bot's reply is scripted here (one test uses a real model instead).
 */

const LONG = "In Paris today it is sunny and mild, about twenty one degrees, with a light breeze from the west. "
  + "The afternoon stays bright, so it is a good day for a long walk along the Seine, and the evening should be clear and calm. "
  + "Tomorrow looks much the same, perhaps a little warmer, with only a small chance of a shower late in the day.";
const scripted = async (heard: string) => (/london/i.test(heard) ? "In London it is cloudy and cool, around fourteen degrees." : LONG);

const results: Record<string, unknown> = {};
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPORT, "screens", `${test.info().project.name}-${name}.png`) });

async function themed(page: Page, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** WebKit has no fake capture device: getUserMedia plays the same WAV through an AudioContext. */
async function fakeMic(page: Page, engine: string): Promise<void> {
  await page.addInitScript(() => { (window as unknown as { __PHONE_TEST_MUTE: boolean }).__PHONE_TEST_MUTE = true; });
  if (engine !== "webkit") return;
  await page.route("**/__fake/speech.wav", (r) => r.fulfill({ status: 200, contentType: "audio/wav", body: fs.readFileSync(SPEECH_WAV) }));
  await page.addInitScript(() => {
    const fake = async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const data = await (await fetch("/__fake/speech.wav")).arrayBuffer();
      const audio = await ctx.decodeAudioData(data);
      const src = ctx.createBufferSource();
      src.buffer = audio;
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      src.start();
      (window as unknown as { __fakeMic: unknown }).__fakeMic = { startedAt: Date.now(), seconds: audio.duration };
      return dest.stream;
    };
    Object.defineProperty(MediaDevices.prototype, "getUserMedia", { value: fake, configurable: true, writable: true });
  });
}

const phone = (page: Page) => page.evaluate(() => {
  const p = (window as unknown as { __phone: { state: { phase: string; heard: { who: string; text: string }[]; log: { type: string }[] }; stats: Record<string, number | string | null>; playing: boolean } }).__phone;
  return { phase: p.state.phase, heard: p.state.heard, log: p.state.log.map((m) => m.type), stats: { ...p.stats }, playing: p.playing };
});

async function pairAndList(page: Page, h: Harness): Promise<void> {
  page.on("console", (m) => h.log.push(`[page ${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => h.log.push(`[page error] ${e.message}`));
  await page.goto(h.url);
  await expect(page.getByRole("heading", { name: "Pair this phone" })).toBeVisible();
  await themed(page, "1-pair");
  await page.getByLabel("Pairing code").fill("000000".replace(/0/g, "9"));
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("alert")).toHaveText("That code didn't work");
  const code = await h.pairCode();
  await page.getByLabel("Pairing code").fill(code);
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("heading", { name: "Bots" })).toBeVisible();
  await expect(page.getByRole("button", { name: `Call ${BOT.name}` })).toBeVisible();
  // The device cookie: httpOnly (the page can't read it), Secure, SameSite=Strict.
  const cookies = await page.context().cookies();
  const c = cookies.find((x) => x.name === "synapse_phone");
  expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("synapse_phone");
  expect(page.url()).not.toMatch(/code|token/i);
}

test.describe.configure({ mode: "serial" });

test("pair → Bots → call → heard → Bot's voice plays → barge-in → hang up (scripted reply)", async ({ page, browserName }, info) => {
  const h = await startHarness({ reply: scripted });
  const t0 = Date.now();
  try {
    await fakeMic(page, browserName);
    await pairAndList(page, h);
    if (browserName === "webkit") await expect(page.getByTestId("ios-hint")).toHaveText("Add to Home Screen for call alerts");
    else await expect(page.getByTestId("ios-hint")).toHaveCount(0);
    await themed(page, "2-bots");

    await page.getByRole("button", { name: `Call ${BOT.name}` }).click();
    // Live: the Mac brought up a helper whose audio is the phone's.
    await expect.poll(async () => (await phone(page)).phase, { timeout: 20_000 }).toBe("live");
    await expect(page.getByTestId("call-state")).toHaveText(/Listening|Speaking/);
    const helperArgs = h.spawns.at(-1)!;
    expect(helperArgs).toContain("--remote-audio");
    expect(helperArgs).not.toContain("--voice-processing");
    // The helper itself says where its audio is: the phone, never this Mac's microphone or speaker.
    expect(h.log.some((l) => l.includes("source=remote"))).toBe(true);
    expect(h.log.some((l) => /source=mic|engine started|input format/.test(l))).toBe(false);
    // serve points at the phone server's 0600 Unix socket, not a port another program could take.
    expect(h.wire.server.socketPath).toMatch(/phone\.sock$/);
    expect(h.log.some((l) => l.includes("phone: on at") && l.includes("unix socket"))).toBe(true);
    await themed(page, "3-call");

    // Nova heard the words (the phone's caption is the helper's final transcript).
    await expect.poll(async () => (await phone(page)).heard.filter((l) => l.who === "You").map((l) => l.text).join(" "), { timeout: 40_000 }).toMatch(/weather.*Paris/i);
    const heard1 = (await phone(page)).heard.find((l) => l.who === "You")!.text;
    expect(h.screen()!.turns[0]).toMatch(/weather.*Paris/i);

    // Nova's voice arrived as audio frames and PLAYED (the output analyser saw real samples).
    await expect.poll(async () => { const s = (await phone(page)).stats; return Number(s.audioChunks) > 25 && Number(s.playedPeak) > 0.05; }, { timeout: 30_000 }).toBe(true);
    await expect(page.getByTestId("call-state")).toHaveText("Speaking");
    const mid = await phone(page);
    await shot(page, "4-speaking");

    // Barge-in: the second phrase comes over Nova's long answer. The helper stops her, the phone drops
    // what it had queued, and the words become the next turn.
    const answerAt = h.screen()!.events.find((e) => e.type === "final")!.at;
    await expect.poll(async () => Number((await phone(page)).stats.flushes) > Number(mid.stats.flushes), { timeout: 40_000 }).toBe(true);
    const barge = h.screen()!.events.find((e) => e.type === "barge-in" && e.at > answerAt);
    expect(barge).toBeTruthy();
    await expect.poll(async () => (await phone(page)).playing, { timeout: 3_000 }).toBe(false);
    await expect.poll(async () => (await phone(page)).heard.filter((l) => l.who === "You").map((l) => l.text).join(" | "), { timeout: 40_000 }).toMatch(/London/i);
    const cut = h.screen()!.events.filter((e) => e.type === "speak-end" && e.interrupted);
    expect(cut.length).toBeGreaterThan(0);
    // The short answer about London is spoken to the phone too.
    await expect.poll(async () => (await phone(page)).heard.some((l) => l.who === BOT.name && /London/.test(l.text)), { timeout: 30_000 }).toBe(true);

    // Hang up: the tone (peak gain 0.05, the Mac's own) plays on the phone — the analyser hears it — and the Mac's call ends.
    await page.getByRole("button", { name: "Hang up" }).click();
    await expect.poll(async () => { const s = (await phone(page)).stats; return s.lastTone === "hangup" && Number(s.tonePeak) > 0.02; }, { timeout: 5_000 }).toBe(true);
    const end = await phone(page);
    await expect.poll(() => h.phoneEvents.some((e) => e.type === "hangup"), { timeout: 5_000 }).toBe(true);
    expect(h.wire.calls.active()).toBe(false);
    await expect(page.getByRole("heading", { name: "Bots" })).toBeVisible({ timeout: 10_000 });

    const scr = h.screens[0]!;
    results[info.project.name] = {
      pass: true, seconds: Math.round((Date.now() - t0) / 1000),
      helperArgs, helperStartedRemote: h.log.some((l) => l.includes("source=remote")),
      heardFirst: heard1, turns: scr.turns, botLines: scr.lines,
      bargeIn: { helperEvent: Boolean(barge), interruptedLines: cut.length, phoneFlushes: end.stats.flushes },
      audio: { chunksAtSpeaking: mid.stats.audioChunks, receivedPeak: end.stats.audioPeak, playedPeak: end.stats.playedPeak, micChunksSent: end.stats.micChunks, micPeak: end.stats.micPeak },
      hangUp: { tone: end.stats.lastTone, tonePeak: end.stats.tonePeak, macHangupEvent: true },
      phoneMessages: end.log.filter((x, i, a) => a.indexOf(x) === i),
    };
  } finally {
    fs.writeFileSync(path.join(REPORT, `run-${info.project.name}.log`), h.log.join("\n"));
    await h.stop();
  }
});

test("call alerts: subscribe → a Bot rings → encrypted push → the notification shows", async ({ page, browserName, context }, info) => {
  test.skip(browserName !== "chromium", "Web Push subscription is checked in Chromium (WebKit needs a Home Screen install on iOS).");
  // The test's own push service on the loopback, and the keys a browser would hold.
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  const received: { headers: http.IncomingHttpHeaders; body: Buffer; url: string }[] = [];
  const pushSvc = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => { received.push({ headers: req.headers, body: Buffer.concat(parts), url: req.url ?? "" }); res.writeHead(201); res.end(); });
  });
  await new Promise<void>((r) => pushSvc.listen(0, "127.0.0.1", () => r()));
  const endpoint = `http://127.0.0.1:${(pushSvc.address() as { port: number }).port}/push/device-1`;
  const h = await startHarness({ reply: scripted, allowLoopbackPush: true });
  try {
    await fakeMic(page, browserName);
    // Chromium's real subscribe() would register with Google's push service over the internet; the
    // subscription is the only stand-in (its endpoint is the loopback service above, its keys ours).
    await page.addInitScript(({ endpoint, p256dh, auth }) => {
      const sub = { endpoint, expirationTime: null, getKey: () => null, unsubscribe: async () => true, toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }) };
      PushManager.prototype.subscribe = async function () { (window as unknown as { __subscribed: boolean }).__subscribed = true; return sub as unknown as PushSubscription; };
      PushManager.prototype.getSubscription = async function () { return (window as unknown as { __subscribed?: boolean }).__subscribed ? sub as unknown as PushSubscription : null; };
    }, { endpoint, p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") });
    await pairAndList(page, h);
    await expect(page.getByTestId("alerts-turn-on")).toBeVisible();
    await page.getByTestId("alerts-turn-on").click();
    await expect(page.getByTestId("alerts-on")).toHaveText("On");
    await themed(page, "5-alerts-on");
    expect(h.wire.store.read().subs.map((s) => s.endpoint)).toEqual([endpoint]);

    // A Bot rings on the Mac: the phone gets it as Web Push.
    expect(await h.wire.ring(BOT.id, "Nova is calling", "About the Paris trip")).toBe(1);
    const msg = received[0]!;
    expect(msg.headers["content-encoding"]).toBe("aes128gcm");
    const payload = JSON.parse(decryptAes128gcm(msg.body, { privateKey: ua.getPrivateKey(), publicKey: ua.getPublicKey() }, auth).toString());
    expect(payload).toEqual({ title: "Nova is calling", body: "About the Paris trip", botId: BOT.id, tag: `call-${BOT.id}` });
    // The VAPID signature verifies with the key the phone was given, for this push service's origin.
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(msg.headers.authorization))!;
    const [hd, cl, sg] = m[1]!.split(".");
    const pub = Buffer.from(m[2]!, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${hd}.${cl}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sg!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(cl!, "base64url").toString()).aud).toBe(new URL(endpoint).origin);
    expect(m[2]).toBe(h.wire.store.vapid().publicKey);

    // The browser delivers the decrypted payload to the service worker, which shows the notification.
    const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.scope; });
    const cdp = await context.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    const regs: { registrationId: string; scopeURL: string }[] = [];
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e: { registrations: { registrationId: string; scopeURL: string }[] }) => regs.push(...e.registrations));
    await expect.poll(() => regs.find((r) => r.scopeURL === reg)?.registrationId ?? null, { timeout: 5_000 }).not.toBeNull();
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: new URL(h.url).origin, registrationId: regs.find((r) => r.scopeURL === reg)!.registrationId, data: JSON.stringify(payload) });
    await expect.poll(() => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body }))), { timeout: 5_000 })
      .toEqual([{ title: "Nova is calling", body: "About the Paris trip" }]);
    results[`${info.project.name}-push`] = { pass: true, subscribed: endpoint, pushHeaders: { encoding: msg.headers["content-encoding"], ttl: msg.headers.ttl, urgency: msg.headers.urgency, topic: msg.headers.topic }, decrypted: payload, vapidVerified: true, notification: "Nova is calling" };
  } finally {
    fs.writeFileSync(path.join(REPORT, `run-${info.project.name}-push.log`), h.log.join("\n"));
    await h.stop();
    pushSvc.close();
  }
});

/** One call through a REAL model (Claude Code's `claude -p`, Haiku) instead of the scripted reply. */
function claude(heard: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("claude", ["-p", "--model", "haiku", `You are Nova, a friendly assistant on a phone call. Reply in one short spoken sentence, no markdown, to: "${heard.replace(/"/g, "'")}"`],
      { timeout: 60_000, env: { ...process.env } }, (err, out) => resolve(err ? "Sorry, I couldn't reach the model just now." : out.trim().split("\n").join(" ").slice(0, 300)));
  });
}

test("one real-model call through the real pipeline", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium" || process.env.PHONE_E2E_REAL !== "1", "Run once, on demand: PHONE_E2E_REAL=1 (it calls a real model).");
  let reply = "";
  // Exactly one model call: the first turn. (The fake microphone's second phrase gets a canned line.)
  let asked = 0;
  const h = await startHarness({ reply: async (t) => (asked++ === 0 ? (reply = await claude(t)) : "Okay.") });
  try {
    await fakeMic(page, browserName);
    await pairAndList(page, h);
    await page.getByRole("button", { name: `Call ${BOT.name}` }).click();
    await expect.poll(async () => (await phone(page)).heard.filter((l) => l.who === "You").map((l) => l.text).join(" "), { timeout: 40_000 }).toMatch(/weather.*Paris/i);
    await expect.poll(() => reply, { timeout: 70_000 }).not.toBe("");
    await expect.poll(async () => (await phone(page)).heard.some((l) => l.who === BOT.name && l.text.length > 3 && !/^Hi, it's Nova/.test(l.text)), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => Number((await phone(page)).stats.playedPeak) > 0.05, { timeout: 30_000 }).toBe(true);
    const s = await phone(page);
    await shot(page, "6-real-model");
    await page.getByRole("button", { name: "Hang up" }).click();
    results[`${info.project.name}-real-model`] = { pass: true, model: "claude -p --model haiku", heard: s.heard, reply, playedPeak: s.stats.playedPeak };
  } finally {
    fs.writeFileSync(path.join(REPORT, `run-${info.project.name}-real.log`), h.log.join("\n"));
    await h.stop();
  }
});

test.afterAll(async ({}, info) => {
  const f = path.join(REPORT, "e2e-results.json");
  const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown> : {};
  fs.writeFileSync(f, JSON.stringify({ ...prev, ...results, [`${info.project.name}-updated`]: new Date().toISOString() }, null, 2));
});
