import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { availableMemory, refreshAvailableMemory, seedAvailableMemory } from "./mac-memory";
import { STRF, scrubClaudeLogin, boxPortEnv, WRONG_HOST_MESSAGE, APP_NAME, CALL_FEEL, LIMITSC, VOICE_ENGINE_MEMORY_MB, defaultVoiceMode, isVoiceMode, resolveVoiceMode, shouldDropToLight, type VoiceMode } from "@synapse/shared";
import { BoxLifecycle, OrbBoxOps, bundledImageVersion, defaultBoxDir, type LifecycleState } from "./box-lifecycle";
import { BoxPin } from "./box-pin";
import { CoordinatorHost, type CoordinatorProcess } from "./coordinator-host";
import { execCommand, OrbBoxProvider } from "./box-provider";
import { shutdownOnQuit } from "./box-quit";
import { resolveOrb } from "./orb-path";
import { MacNetsWatcher } from "./mac-nets";
import { resolveGateway, type GatewayHandle } from "./gateway-bootstrap";
import { gatewayCall, type HostCreds } from "./gateway-call";
import { registerComposioPaste } from "./native/composio-paste";
import { createHostFetch, streamProves } from "./host-fetch";
import { deployAndReconnect, hostMoved } from "./auto-update-steps";
import { PROBE_ENV, codeIdentity, electronStore, migrationItemName, openLegacyKeychain, runProbeMode } from "./keychain";
import { FileKeyStore } from "./file-key-store";
import { SECRETS_RELOCKED_MESSAGE, mayCreateKey, openSealing, prepareSealing, retireStaleHashKey, sealer } from "./sealing";
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, MessageChannelMain, nativeTheme, screen, shell, systemPreferences, utilityProcess } from "electron";
import { ensureMicAccess, privacySettingsUrl } from "./native/privacy";
import { captureScreen } from "./native/screen-share";
import { clampRectToWorkArea, maximizeRect } from "./window-bounds";
import { readAppSettings, writeAppSettings } from "./app-settings";
import { emitNative, installNativeIpc, registerNative, tapNative } from "./native";
import { installCrashReporting } from "./crash/wire";
import { fitPng, installFeedback } from "./feedback/wire";
import { logsDir } from "./backup/wire";
import { registerDeepLinks, setImportSheetOpen } from "./native/deep-links";
import { registerClipboardBotLink, registerShareMenu } from "./native/share-menu";
import { registerOpenBotpacks } from "./native/open-botpacks";
import { registerAudioDevices } from "./native/audio-devices";
import { registerDictation, writeContextFile } from "./native/dictation";
import { makeLmCache } from "./native/stt-lm";
import { downloadModel, helperHasWhisper, helperWhisperArgs, humanBytes, whisperRoot, whisperStatus } from "./native/stt-whisper";
import { registerWakeWord } from "./native/wake-wire";
import { registerBotCalls } from "./native/bot-calls-wire";
import { quietHoursStore, registerSettingsNatives, switchValue, wakeSettingsStore } from "./native/settings-natives";
import { bundledKokoroDir, prosodyFrom, registerKokoro, type Prosody } from "./native/kokoro";
import { SELFTEST_ENV, kokoroSelfTest } from "./native/kokoro-selftest";
import { runPortableMigration } from "./portable-migration";
import { registerSetup } from "./setup/wire";
import { boxMachineName, machineMarks } from "./setup/orb";
import { HOLD_LEASE_MS, HOLD_RENEW_MS, HOLD_WAIT_CAP_MS, USER_QUIET_MS, releaseStaleHold, renewEvery, reprovisionIfChanged, type ReprovisionStatus } from "./setup/reprovision";
import { BoxOpsLock, boxBusyMessage } from "./setup/box-ops-lock";
import { registerF5 } from "./native/f5";
import { registerQwen } from "./native/qwen";
import { registerVoicePacks } from "./native/voice-packs";
import { offerMoveToApplications } from "./install-location";
import { registerVoiceClips } from "./native/voice-clips";
import { PhraseCache, pruneOld, registerVoiceCache } from "./native/voice-cache";
import { callMenuItems, registerCallShortcut } from "./native/call-shortcut";
import { createRotatingLog } from "./rotating-log";
import { guardNavigation, registerExternal } from "./native/external";
import { allowDroppedPath, registerFiles } from "./native/files";
import { fetchLogoDataUrl } from "./native/logo";
import { installAppMenu } from "./native/menu";
import { defaultReleaseDir, launchHealth, markHealthy, registerUpdater, validFeed } from "./native/updater";
import { bundledHostBuild, redeployHostIfChanged } from "./native/host-redeploy";
import { applyNativeTheme, cacheTheme, readCachedTheme, windowBackground } from "./native-theme";
import { registerBackups } from "./backup/wire";
import { setDockBadge, showAppNotification, showBotNotification } from "./notify";
import { registerMacDisk } from "./mac-disk";
import { configureProfile } from "./profile";
import { resolveUnpacked } from "./resolve-unpacked";
import { MacSecretVault } from "./secret-vault";
import { confirmTrustDialog, createApiKeySender, registerAuthIpc, type ApiKeySender } from "./auth-key";
import { SecretSync, sealWith } from "./secret-sync";
import { saveFileFromGateway } from "./save-file";
import { readSecret, sealedSecretNames, storeSecret } from "./secrets";
import { effectiveFeed, migrateUpdateSourceFromKeychain, readUpdateSource, writeUpdateSource } from "./update-source";
import { SnapshotSink } from "./snapshot-sink";
import { postToRenderer, sendToRenderer } from "./to-renderer";
import { registerMacBrowser } from "./browser/wire";
import { registerMacApps } from "./macapp/wire";
import { registerPhone } from "./phone/wire";
import { makeTailscale } from "./phone/tailscale";

const profileDir = configureProfile(app, process.env);
app.setAppLogsPath(logsDir());

// Bug-log 279: the keychain is retired. Secrets are sealed with the profile's own key file (sealing.ts). Once the
// profile has the `keychain-retired.json` marker (or is fresh, with nothing sealed), Chromium runs with
// `use-mock-keychain`, so neither the app nor Chromium's own cookie encryption asks the keychain anything — no
// password prompt after an update. Only the migration launch keeps the real keychain, and names the safe-storage
// item the secrets were sealed into: the namespace an earlier build stamped in keychain-namespace.json, else this
// build's code identity (bug 99). Electron captures that name before `ready`; start() restores the real app name.
const sealMode = prepareSealing(profileDir, app.commandLine, { probeChild: process.env[PROBE_ENV] === "1" });
const legacyItem = sealMode === "migrate"
  ? migrationItemName(profileDir, () => codeIdentity({ exe: process.execPath, cacheFile: path.join(profileDir, "code-identity.json") }))
  : null;
if (legacyItem) app.setName(legacyItem);
const fileKeys = new FileKeyStore(profileDir, { mayCreate: () => mayCreateKey(profileDir) });

let windowLoaded = false;
// macOS delivers `open-url` before `whenReady()` resolves, so register before awaiting it.
// Bot sharing: a link brings the window forward (the first one; only one is ever opened).
registerDeepLinks(app, () => windowLoaded, () => BrowserWindow.getAllWindows()[0] ?? null);
registerOpenBotpacks(app, () => windowLoaded);

function hashKey(profileDir: string): () => Buffer {
  const f = path.join(profileDir, "secrets.hashkey.bin");
  return () => sealer.require((s) => {
    if (!fs.existsSync(f)) fs.writeFileSync(f, s.encryptString(randomBytes(32).toString("base64")), { mode: 0o600 });
    try {
      return Buffer.from(s.decryptString(fs.readFileSync(f)), "base64");
    } catch {
      // Still sealed by an old keychain item the move couldn't open. With no saved secret depending on
      // it, it is archived and replaced (sealing.ts retireStaleHashKey); otherwise regenerating
      // silently would invalidate every valueHash without saying so, so it says so instead.
      if (retireStaleHashKey(profileDir)) {
        fs.writeFileSync(f, s.encryptString(randomBytes(32).toString("base64")), { mode: 0o600 });
        return Buffer.from(s.decryptString(fs.readFileSync(f)), "base64");
      }
      throw new Error(SECRETS_RELOCKED_MESSAGE);
    }
  });
}

/** P5 review I3: the OLD HMAC key for the local-exec policy files, an HKDF subkey of the sealed hash key.
 *  Bug 225: used only to migrate those files to the profile's local-policy.key (coordinator/local-exec/policy-key.ts). */
function localPolicyKey(profileDir: string): string | undefined {
  return sealer.read(() => {
    try {
      return Buffer.from(hkdfSync("sha256", hashKey(profileDir)(), Buffer.alloc(0), "bots/local-exec-policy/v1", 32)).toString("base64");
    } catch { return undefined; }
  }, undefined);
}

/**
 * Opens the app's secrets — only ever called after `win.loadFile()`. On the one migration launch this is where the
 * keychain is read, once (sealing.ts retireKeychain), so a keychain prompt can never stop the window appearing;
 * every other launch opens straight onto the profile's key file and never touches the keychain.
 */
async function openSecrets(): Promise<void> {
  sealer.onState((s) => emitNative("seal", s));
  const st = await openSealing({
    gate: sealer, mode: sealMode, profileDir, files: fileKeys,
    legacy: () => openLegacyKeychain({ exe: process.execPath, env: scrubClaudeLogin(process.env) }),
    log: (l) => console.error(l),
  });
  if (st.status !== "ready" || st.relocked) console.error(`secrets ${st.status}: ${st.message}`);
}

let secretSync: SecretSync | null = null;
/** Settings → Account's sender, once connected (registerAuthIpc answers before that with why not). */
let apiKeySender: ApiKeySender | null = null;
/**
 * Review fix 4: the Mac's copy of the API key is kept by the coordinator, which owns the permission key file (and
 * creates it on demand with its one-time migration). Main asks over the parent port; no answer in 10 s is a failure.
 */
let macKeySeq = 0;
const macKeyWaits = new Map<number, (r: unknown) => void>();
let postToCoordinator: ((m: Record<string, unknown>) => void) | null = null;
function macKeyRpc<T>(op: "save" | "clear" | "has", key?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!postToCoordinator) { reject(new Error("the coordinator isn't running")); return; }
    const id = ++macKeySeq;
    const t = setTimeout(() => { macKeyWaits.delete(id); reject(new Error("the coordinator didn't answer")); }, 10_000);
    macKeyWaits.set(id, (r) => {
      clearTimeout(t);
      const x = r as { ok: boolean; result?: unknown; error?: string };
      if (x?.ok) resolve(x.result as T); else reject(new Error(x?.error ?? "the coordinator couldn't do that"));
    });
    postToCoordinator({ type: "mac-key", op, id, ...(key !== undefined ? { key } : {}) });
  });
}
/**
 * How main's gateway calls reach the host (set on every connect): prove it first when it answers /hello, and ask for
 * fresh credentials before blaming another account for a refusal (a machine recreated under a stale token).
 */
/** The coordinator's client was refused by the host (set once the window's connect() exists). */
let onGatewayRefused: () => void = () => {};
let hostCallOpts: { hello?: boolean; onStale?: () => Promise<HostCreds | null>; proven?: (c: HostCreds) => boolean } = {};
/** The connected host, and whether the coordinator's event stream is up on it (its proof is then reused). */
let currentCreds: HostCreds | null = null;
let streamUp = false;
/** Main's raw token-bearing requests (health, backups, snapshots, file saves), proven first (host-fetch.ts). */
const hostFetch = createHostFetch({ creds: () => currentCreds, streamUp: () => streamUp });
function startSecrets(profileDir: string, baseUrl: string, token: string): void {
  const vault = new MacSecretVault(path.join(profileDir, "secrets.vault.json"), { encrypt: (s) => sealer.require((k) => k.encryptString(s)), decrypt: (b) => sealer.require((k) => k.decryptString(b)) }, hashKey(profileDir));
  const call = gatewayCall(baseUrl, token, hostCallOpts);
  const pin = new BoxPin(path.join(profileDir, "box-pin.json"));
  secretSync = new SecretSync({ vault, pin, call, seal: sealWith });
  // Settings → Account: the Anthropic API key is sealed to the box here and never sent back (auth-key.ts). A saved key
  // is also kept for the Bots' claude on this Mac (through the coordinator's key proxy), encrypted with
  // the profile's local-policy.key (never the keychain).
  apiKeySender = createApiKeySender({
    // No client time limit: a Save must reach its real end before a queued Remove runs (auth-key.ts), or a Save given
    // up on here could still land on the box after the Remove. The panel shows its slow note meanwhile.
    call: gatewayCall(baseUrl, token, hostCallOpts), pin, seal: sealWith, log: (s) => console.error(s),
    confirmTrust: (oldFp, newFp) => confirmTrustDialog((opts) => { const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]; return w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts); }, oldFp, newFp),
    mac: {
      save: (key) => macKeyRpc<{ ok: boolean; error?: string }>("save", key),
      clear: () => macKeyRpc<void>("clear"),
      has: () => macKeyRpc<boolean>("has"),
    },
  });
  void call("listAgents", {}).then((r) => secretSync?.resync(r.agents.map((a) => a.id))).catch(() => {});
  ipcMain.removeHandler("secrets:list");
  ipcMain.handle("secrets:list", (_e, botId: string) => secretSync!.list(botId));
  for (const [ch, fn] of [
    ["secrets:save", (botId: string, name: string, description: string, value: string) => secretSync!.save(botId, name, description, value)],
    ["secrets:remove", (botId: string, name: string) => secretSync!.remove(botId, name)],
    ["secrets:keep-on-box", async (botId: string, names: string[]) => secretSync!.keepOnBox(botId, names)],
    ["secrets:rename", (botId: string, from: string, to: string) => secretSync!.rename(botId, from, to)],
    ["secrets:submit-request", (botId: string, entryId: string, value: string, meta: never) => secretSync!.submitRequest(botId, entryId, value, meta)],
    ["secrets:submit-form", (botId: string, entryId: string, answers: never, secrets: never) => secretSync!.submitForm(botId, entryId, answers, secrets)],
  ] as const) {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args));
  }
}

/** Packaged: box/ and route.env live in Synapse.app/Contents/Resources (scripts/package.mjs extraResource). */
const appRuntime = () => ({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
/** Portable install: the profile's OrbStack machine ("synapse-box" for a new install; an existing "box" is kept). */
const boxMachine = () => boxMachineName({ setting: readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).boxMachine, userData: app.getPath("userData") });
const boxPinFile = () => path.join(app.getPath("userData"), "box-pin.json");
/** Fix round 1: the ONE lock every operation on the Bots' computer takes (re-provision, setup, Update / Recover / Reset). */
const boxLock = new BoxOpsLock();
/** The last background box update (Settings shows a failure once, with Retry). */
let lastBoxUpdate: ReprovisionStatus | null = null;
/** This app asked the host to hold new turns and hasn't let go yet (released on quit, best effort). */
let holdingTurns = false;
let retryBoxUpdate: (() => Promise<void>) | null = null;

let lifecycle: BoxLifecycle | null = null;
let backupTimer: NodeJS.Timeout | null = null;
/** Bug 365: the Mac's own networks follow into the box firewall when they change (Wi-Fi, VPN, a new IPv6 prefix). */
let macNets: MacNetsWatcher | null = null;
function startBoxOps(win: BrowserWindow, profileDir: string, baseUrl: string, token: string, reconnect: () => Promise<void>): void {
  // FUZZ mode has no box (no OrbStack machine); only box:info answers, from the repo's bundled
  // box/ dir (present in development). Update/Recover/Reset would need a real machine, so they
  // reject cleanly instead of hanging or crashing main.
  if (process.env.FUZZ === "1") {
    const boxDir = process.env.APP_BOX_DIR ?? defaultBoxDir(app.getAppPath(), appRuntime());
    for (const ch of ["box:update", "box:recover", "box:reset", "box:info"]) ipcMain.removeHandler(ch);
    ipcMain.handle("box:info", () => ({ bundledImageVersion: bundledImageVersion(boxDir) }));
    ipcMain.handle("box:update", () => { throw new Error("Not available in FUZZ mode"); });
    ipcMain.handle("box:recover", () => { throw new Error("Not available in FUZZ mode"); });
    ipcMain.handle("box:reset", () => { throw new Error("Not available in FUZZ mode"); });
    return;
  }
  macNets ??= new MacNetsWatcher({
    apply: async (nets) => (await execCommand(resolveOrb(), ["-m", boxMachine(), "-u", "root", "/usr/local/lib/bots/bots-ports", "mac-nets", nets.join(" ")], { timeoutMs: 20_000 })).code === 0,
    log: (l) => process.stderr.write(`${l}\n`),
  });
  macNets.start();
  const call = gatewayCall(baseUrl, token, hostCallOpts);
  const sink = new SnapshotSink({
    dir: path.join(profileDir, "snapshots"), call,
    http: {
      get: async (p) => Buffer.from(await (await hostFetch(p)).arrayBuffer()),
      put: async (p, body) => { const r = await hostFetch(p, { method: "PUT", body: body as unknown as BodyInit }); if (!r.ok) throw new Error(`upload failed (${r.status})`); },
    },
  });
  const boxDir = process.env.APP_BOX_DIR ?? defaultBoxDir(app.getAppPath(), appRuntime());
  // Every call rebinds the current call/sink/ops (fresh baseUrl/token), even though `lifecycle` itself
  // is constructed once: startBoxOps runs again on every connect()/reconnect (including the one
  // BoxLifecycle.update() triggers via afterReconnect() right after recreateMachine() hands out a new
  // gateway token), and the rest of that in-flight run must pick up the new Bearer token instead of
  // 401/403ing against the recreated gateway with the stale one (T22 fix 1).
  const deps = {
    ops: new OrbBoxOps({
      exec: execCommand, boxDir, machine: boxMachine(), health: async () => (await hostFetch("/health").catch(() => null))?.ok === true,
      // Blocker (c): the recreated box has a new key; the next secret sync pins it instead of refusing forever.
      onRecreated: () => new BoxPin(boxPinFile()).forget(),
    }),
    call, sink, publish: (s: LifecycleState) => sendToRenderer(win, "box-lifecycle", s),
    afterReconnect: reconnect,
  };
  if (!lifecycle) lifecycle = new BoxLifecycle(deps, boxLock);
  else lifecycle.setDeps(deps);
  if (backupTimer) clearInterval(backupTimer);
  backupTimer = setInterval(() => { if (lifecycle?.state().phase === "ready") void sink.backupNow("scheduled").catch(() => {}); }, LIMITSC.snapshotEveryMs);
  for (const ch of ["box:update", "box:recover", "box:reset", "box:info"]) ipcMain.removeHandler(ch);
  ipcMain.handle("box:update", (_e, force: boolean) => lifecycle!.update({ force }));
  ipcMain.handle("box:recover", () => lifecycle!.recover());
  ipcMain.handle("box:reset", (_e, alsoBots: boolean) => lifecycle!.reset({ alsoBots }));
  ipcMain.handle("box:info", () => ({ bundledImageVersion: bundledImageVersion(boxDir) }));
}

async function start(): Promise<void> {
  await app.whenReady();
  // Portable install: run from the DMG or Downloads (translocated), offer once to move into /Applications.
  const moved = await offerMoveToApplications({
    packaged: app.isPackaged, inApplications: app.isInApplicationsFolder(), fuzz: process.env.FUZZ === "1",
    alreadyDeclined: readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).moveDeclined === true,
    currentVersion: app.getVersion(),
    existing: () => {
      const plist = "/Applications/Synapse.app/Contents/Info.plist";
      if (!fs.existsSync(plist)) return null;
      const r = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], { env: scrubClaudeLogin(process.env), encoding: "utf8", timeout: 5_000 });
      return { version: r.status === 0 ? r.stdout.trim() : "0" };
    },
    ask: async () => ((await dialog.showMessageBox({ type: "question", message: "Move Synapse to Applications?", buttons: ["Move", "Not now"], defaultId: 0, cancelId: 1 })).response === 0 ? "move" : "later"),
    confirmReplace: async (v) => (await dialog.showMessageBox({ type: "warning", message: `Replace Synapse ${v} in Applications?`, buttons: ["Replace", "Cancel"], defaultId: 1, cancelId: 1 })).response === 0,
    move: (conflictHandler) => app.moveToApplicationsFolder({ conflictHandler }),
    remember: () => { writeAppSettings(app.getPath("userData"), { moveDeclined: true }); },
  });
  if (moved === "moved") return; // Electron relaunches the moved copy
  // Electron has captured the safe-storage item name by now, so the app goes back to being called
  // what it is called (menus, the about panel, notifications).
  app.setName(APP_NAME);
  app.setAboutPanelOptions({ applicationName: APP_NAME });
  // Dev runs (`electron .`) show the Synapse icon in the Dock too; packaged builds get it from icon.icns.
  if (!app.isPackaged) { try { app.dock?.setIcon(path.join(__dirname, "..", "build", "icon.png")); } catch { /* icon is cosmetic */ } }
  // New-user walk, finding 4: the cached theme first, so the launch and the window paint in it from the start.
  const themeFile = path.join(app.getPath("userData"), "theme.json");
  applyNativeTheme(readCachedTheme(themeFile));
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 680, backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 }, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  // An update's swap script waits for this build to say it's healthy: window shown and renderer loaded, not
  // the box (a slow box used to roll a good update back). Unpackaged and fuzz runs never mark.
  const launch = launchHealth(() => (app.isPackaged && process.env.FUZZ !== "1" ? markHealthy(app.getPath("userData"), app.getVersion()) : { rolledBack: false }));
  win.once("ready-to-show", () => { win.show(); launch.windowShown(); });
  // Settings → Diagnostics (local only). Installed first so every later failure is seen.
  let lastHostVersion: string | null = null;
  let gatewayToken: string | null = null;
  const crash = installCrashReporting({
    userData: app.getPath("userData"), logsDir: logsDir(), appVersion: app.getVersion(), hostVersion: () => lastHostVersion,
    secrets: () => [gatewayToken, readUpdateSource(app.getPath("userData")).token, readSecret(app.getPath("userData"), "backupKey")].filter((v): v is string => !!v),
    reg: registerNative, emit: emitNative, reveal: (f) => shell.showItemInFolder(f), copyText: (t) => clipboard.writeText(t),
  });
  // Send feedback and 👍/👎 (local). The window's own screenshot only; FUZZ never leaves the app.
  installFeedback({
    reg: registerNative, userData: app.getPath("userData"), home: os.homedir(), appVersion: app.getVersion(), macos: process.getSystemVersion(),
    logFiles: () => [path.join(logsDir(), "main.log.1"), path.join(logsDir(), "main.log")],
    // Every secret main can read: the live gateway token, the update feed's token, and each sealed Mac-side secret.
    secrets: () => [gatewayToken, readUpdateSource(app.getPath("userData")).token, ...sealedSecretNames(app.getPath("userData")).map((n) => readSecret(app.getPath("userData"), n))].filter((v): v is string => !!v),
    username: (() => { try { return os.userInfo().username; } catch { return undefined; } })(),
    // Only a development build may send somewhere else.
    endpoint: !app.isPackaged ? process.env.SYNAPSE_FEEDBACK_URL : undefined,
    crashText: (id) => { const r = id === "latest" ? crash.store.list()[0] : crash.store.list().find((x) => x.id === id); return r ? crash.store.reportText(r.id) : null; },
    capture: async () => (win.isDestroyed() ? null : fitPng(await win.webContents.capturePage())),
    openExternal: (url) => shell.openExternal(url), offline: process.env.FUZZ === "1",
    // A reply: a quiet notice in the window, and a macOS notification when the window isn't in front.
    onReply: (unread) => {
      emitNative("feedback-reply", { unread });
      if (!win.isDestroyed() && !win.isFocused()) showAppNotification(win, { title: STRF.synapse, body: STRF.replyNotice });
    },
  });
  tapNative((ch, p) => {
    const e = p as { type?: string; code?: string; message?: string } | null;
    if (ch === "dictation" && e?.type === "error" && e.code === "helper-exit") crash.record({ kind: "helper-exit", message: String(e.message ?? "The dictation helper stopped unexpectedly.") });
  });
  // A crashed window is reloaded (not left white), unless it keeps crashing.
  win.webContents.on("render-process-gone", (_e, d) => {
    if (d.reason === "clean-exit") return;
    const r = crash.record({ kind: "renderer-crash", message: `The window's renderer ${d.reason} (exit ${d.exitCode}).` });
    if (!win.isDestroyed() && (r?.count ?? 1) < 3) setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 500);
  });
  app.on("child-process-gone", (_e, d) => {
    if (d.reason === "clean-exit") return;
    crash.record({ kind: "child-crash", message: `${d.type}${d.name ? ` (${d.name})` : ""} ${d.reason} (exit ${d.exitCode}).` });
  });
  app.on("second-instance", () => {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  // Maximize/zoom fills workArea only. A window sitting on display.bounds covers the Dock and
  // menu-bar hover strips, which is why those OS chrome pieces stop peeking (UI-01). Never
  // simpleFullScreen — that is the other way to swallow the same hotspots.
  const stayInWorkArea = () => {
    const display = screen.getDisplayMatching(win.getBounds());
    const cur = win.getBounds();
    const next = win.isMaximized() ? maximizeRect(display.workArea) : clampRectToWorkArea(cur, display.workArea);
    if (cur.x !== next.x || cur.y !== next.y || cur.width !== next.width || cur.height !== next.height) win.setBounds(next);
  };
  win.on("maximize", stayInWorkArea);
  win.on("enter-full-screen", () => { /* hiddenInset traffic lights stay; do not setSimpleFullScreen */ });
  // Added 11:10: links never open a window or navigate the app away; https goes through the guarded openExternal.
  guardNavigation(win.webContents, pathToFileURL(path.join(__dirname, "renderer", "index.html")).href);

  // The coordinator is the app's only link to the host, so its death is supervised: main re-forks it,
  // re-wires the renderer MessagePort and replays the connection instead of going mute until a relaunch.
  // mac-browser: Bots drive a browser window on this Mac (the controller answers the coordinator's gated requests).
  const macBrowser = registerMacBrowser({ userData: app.getPath("userData"), log: (l) => console.log(l), post: (m) => coordinator.postMessage(m) });
  app.on("will-quit", () => { void macBrowser.close(); });
  // mac-apps: Bots open and drive the apps on this Mac (Messages, Mail, Calendar… and any app through the
  // Accessibility helper). Same shape as the browser: the coordinator's gate first, this controller second.
  const macApps = registerMacApps({
    binary: resolveUnpacked(path.join(__dirname, "native", process.env.FUZZ === "1" ? "fake-macapp.sh" : "bots-mac")),
    userData: app.getPath("userData"),
    log: (l) => console.log(l),
    post: (m) => coordinator.postMessage(m),
    fuzz: process.env.FUZZ === "1",
    openExternal: (url) => shell.openExternal(url),
  });
  app.on("will-quit", () => macApps.close());
  const coordinator = new CoordinatorHost({
    fork: () => utilityProcess.fork(path.join(__dirname, "coordinator.cjs"), [], { serviceName: "Synapse Coordinator" }) as unknown as CoordinatorProcess,
    onMessage: (m) => {
      if (macBrowser.onMessage(m)) return;
      if (macApps.onMessage(m)) return;
      if (m.type === "gateway-refused") { onGatewayRefused(); return; }
      // The coordinator's stream: "connected" means its client proved this host for the connection (a restart drops it).
      if (m.type === "conn-state") { streamUp = (m as { kind?: string }).kind === "connected"; return; }
      if (m.type === "mac-key-result" && typeof m.id === "number") {
        macKeyWaits.get(m.id)?.((m as { result?: unknown }).result);
        macKeyWaits.delete(m.id);
        return;
      }
      if (m.type === "nolimits-verify" && typeof m.id === "number") {
        coordinator.postMessage({ type: "nolimits-verify-result", id: m.id, result: consumeNoLimitsNonce(typeof m.nonce === "string" ? m.nonce : "") });
        return;
      }
      if (m.type === "notify" && m.botId) showBotNotification(win, { botId: m.botId, title: m.title ?? "", body: m.body ?? "" });
      else if (m.type === "badge") setDockBadge(m.count ?? 0);
    },
    onDeath: (attempt) => {
      console.error(`coordinator exited; restarting (attempt ${attempt})`);
      crash.record({ kind: "child-crash", message: "The coordinator process exited and was restarted." });
    },
    onRespawn: () => {
      if (windowLoaded) wirePort();
      if (!win.isDestroyed()) sendFocus();
    },
  });
  postToCoordinator = (m) => coordinator.postMessage(m);
  const sendFocus = () => coordinator.postMessage({ type: "focus", focused: win.isFocused() });
  win.on("focus", sendFocus);
  win.on("blur", sendFocus);
  const wirePort = () => {
    const { port1, port2 } = new MessageChannelMain();
    coordinator.postMessage({ type: "renderer-port" }, [port1]);
    postToRenderer(win, "coordinator-port", null, [port2]);
  };
  win.webContents.on("did-finish-load", () => { windowLoaded = true; wirePort(); launch.rendererLoaded(); });
  // Start-up timing marks from the renderer (renderer/launch/trace.ts) go into main.log.
  win.webContents.on("console-message", (e) => { const m = (e as unknown as { message?: string }).message ?? ""; if (m.startsWith("[launch] ")) console.log(m); });
  win.once("ready-to-show", () => console.log("[launch] window shown (main)"));
  // `windowLoaded` used to be set on load and never cleared, so during a reload — or after a
  // renderer crash — it still read `true` from the PREVIOUS frame, and a coordinator respawn
  // arriving in that window wired a port into a frame that was already gone. Clearing it here means
  // the flag answers "is there a frame that finished loading", which is what its one reader
  // (`registerDeepLinks`) and `onRespawn` both actually mean by it. `did-finish-load` sets it again.
  win.webContents.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) windowLoaded = false; });
  win.webContents.on("render-process-gone", () => { windowLoaded = false; });

  ipcMain.handle("app-info", () => ({ userName: os.userInfo().username }));

  installNativeIpc(ipcMain, () => win);
  registerShareMenu(() => (win.isDestroyed() ? null : win), { fuzz: process.env.FUZZ === "1" });
  registerClipboardBotLink();
  registerNative("share.importSheetOpen", (a: { open?: unknown }) => { setImportSheetOpen(a?.open === true); return {}; });
  registerExternal();
  registerFiles(() => win);
  registerNative("fetchLogo", (a: { url: string }) => fetchLogoDataUrl(a.url));
  const appSettingsStore = { read: () => readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()), write: (p: Parameters<typeof writeAppSettings>[1]) => writeAppSettings(app.getPath("userData"), p) };
  ipcMain.on("native:dropped-path", (e, p: unknown) => { if (e.sender === win.webContents && typeof p === "string") allowDroppedPath(p); });
  // Bug 105: dictation / voice narration goes to a small rotating file in the logs folder as well
  // as the console, so a failure can be diagnosed after the fact (~/Library/Logs/Synapse/voice.log).
  const voiceFile = createRotatingLog({ dir: logsDir(), name: "voice.log", maxBytes: 512 * 1024, keep: 2 });
  const voiceLog = (line: string) => { console.warn(line); voiceFile(line); };
  const helperBinary = resolveUnpacked(path.join(__dirname, "native", process.env.FUZZ === "1" ? "fake-dictation.sh" : "bots-dictation"));
  const readAudioPrefs = () => {
    const s = readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime());
    return { input: s.audioInput ?? null, output: s.audioOutput ?? null };
  };
  const readVoice = () => readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).ttsVoice ?? null;
  let audioDevices: ReturnType<typeof registerAudioDevices> | null = null;
  // Portable install: an existing profile that pinned a box is recorded as set up (portable-migration.ts).
  try { runPortableMigration(app.getPath("userData"), os.homedir(), voiceLog); } catch (e) { voiceLog(`portable install: settings migration failed: ${(e as Error).message}`); }
  // Bug 107: the natural (Kokoro) voice — the runtime and model bundled in Synapse.app (portable
  // install), found and probed lazily, its sidecar spawned at a call's start or the first Preview.
  // FUZZ never runs it.
  const kokoro = registerKokoro({
    script: resolveUnpacked(path.join(__dirname, "native", "kokoro_server.py")),
    bundled: bundledKokoroDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), env: scrubClaudeLogin(process.env) }),
    home: os.homedir(), userData: app.getPath("userData"), log: voiceLog,
    settings: () => { const s = readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()); return { python: s.kokoroPython ?? null, modelDir: s.kokoroModelDir ?? null }; },
    ...(process.env.FUZZ === "1" ? { exists: () => false } : {}),
    // Bug 134: "Keep voice ready" (Settings → Voice, default on): loaded 10 s after launch, kept hot.
    keepReady: () => readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).keepVoiceReady !== false,
    launchDelayMs: 10_000,
  });
  // Bug 224: no question ramp on any voice, so the bug-161 "Natural question intonation" switch is gone. The env flag
  // SYNAPSE_TTS_PROSODY=0 still turns the whole prosody stage off for a run.
  const readProsody = (): Prosody => prosodyFrom();
  // settings-persist: the Settings switches kept in app-settings.json (Keep Bots running, Keep voice ready,
  // Question intonation, Call sounds, Whisper in calls) — one table, round-tripped in settings-natives.test.ts.
  registerSettingsNatives(registerNative, appSettingsStore, { changed: (k) => { if (k === "keepVoiceReady") kokoro.keepReadyChanged(); } });
  // Bot sharing: the owner's advanced actions (Export for website) — Settings' "Show developer tools", or SYNAPSE_OWNER=1.
  registerNative("ownerTools.get", () => ({ on: process.env.SYNAPSE_OWNER === "1" || switchValue(appSettingsStore.read(), "showDeveloperTools") }));
  app.on("will-quit", () => kokoro.dispose());
  // Cloned voices (F5). Optional and off until the user records one: with no saved voice this
  // starts no Python, reads no weights and takes no memory. It is never kept hot — the model is
  // about 1.4 GB resident — so it loads when a Bot using a cloned voice speaks and idles out after.
  const f5 = registerF5({
    script: resolveUnpacked(path.join(__dirname, "native", "f5_server.py")),
    home: os.homedir(), userData: app.getPath("userData"), log: voiceLog,
    python: () => readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).f5Python ?? null,
    ...(process.env.FUZZ === "1" ? { exists: () => false } : {}),
  });
  app.on("will-quit", () => f5.dispose());
  registerVoiceClips({ userData: app.getPath("userData"), log: voiceLog, changed: () => void f5.status() });
  // Bug 164: voice mode. One control, two honest numbers: Light is Kokoro alone (~0.8 GB), Full adds
  // Qwen3 and Whisper (~4 GB). The machine picks the first time — Light at 16 GB or less, or when
  // memory is already tight — and the user's own choice, once made, is what sticks.
  seedAvailableMemory();
  const machineMemory = () => ({ totalBytes: os.totalmem(), freeBytes: availableMemory() });
  /** Set for the rest of a call when the Mac ran short mid-call; cleared when the call ends. */
  let modeDroppedThisCall = false;
  const voiceMode = (): VoiceMode => {
    if (modeDroppedThisCall) return "light";
    return resolveVoiceMode(readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).voiceMode, machineMemory());
  };
  // Bug 164: Qwen3. Never loaded for a user who hasn't chosen it, and never kept hot (2.1 GB
  // resident): it loads when a Bot set to a Qwen voice speaks and idles out like F5 does.
  const qwen = registerQwen({
    script: resolveUnpacked(path.join(__dirname, "native", "qwen_server.py")),
    home: os.homedir(), userData: app.getPath("userData"), log: voiceLog,
    settings: () => { const s = readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()); return { python: s.qwenPython ?? null, modelDir: s.qwenModelDir ?? null }; },
    ...(process.env.FUZZ === "1" ? { exists: () => false } : {}),
    allowed: () => voiceMode() === "full",
  });
  app.on("will-quit", () => qwen.dispose());
  // Portable install: the optional voice packs (Qwen3 "Natural voices", F5 "Cloned voices") — a pinned runtime and
  // pinned weights downloaded into Synapse's own shared folder, from the setup screen or Settings.
  registerVoicePacks({
    reg: registerNative, emit: emitNative, userData: app.getPath("userData"), log: voiceLog,
    nativeDir: path.dirname(resolveUnpacked(path.join(__dirname, "native", "qwen_server.py"))),
    working: async (id) => (id === "qwen" ? (await qwen.status()).state === "ready" : !["missing", "checking"].includes((await f5.status()).state)),
    installed: (id) => { if (id === "qwen") qwen.recheck(); else f5.recheck(); },
    freeBytes: () => { try { const s = fs.statfsSync(app.getPath("userData")); return s.bavail * s.bsize; } catch { return null; } },
  });
  registerNative("voiceMode.get", () => ({
    mode: voiceMode(),
    machineDefault: defaultVoiceMode(machineMemory()),
    // What the voice stack is costing right now, so Settings can say so without guessing.
    memoryMb: qwen.memoryMb() + (kokoro.isWarm() ? VOICE_ENGINE_MEMORY_MB.kokoro : 0),
    droppedThisCall: modeDroppedThisCall,
  }));
  registerNative("voiceMode.set", (a: { mode?: unknown }) => {
    if (!isVoiceMode(a?.mode)) throw new Error("Bad voice mode.");
    writeAppSettings(app.getPath("userData"), { voiceMode: a.mode });
    // A change applies to the NEXT call: a call in progress keeps the engines it already has, and
    // what the new mode doesn't need is unloaded as soon as nothing is speaking through it.
    modeDroppedThisCall = false;
    if (a.mode === "light") { qwen.unload(); f5.dispose(); }
    voiceLog(`voice mode: ${a.mode}`);
    return { mode: a.mode };
  });
  /**
   * Bug 164: the Mac went short mid-call. Full gives way for the REST of this call — the call is
   * never interrupted, the line already speaking finishes — and the call screen says so once.
   */
  // Two low readings in a row (10 s apart), so a brief dip while macOS reclaims cache never costs the call its voice.
  let lowReadings = 0;
  const checkVoiceMemory = async (): Promise<void> => {
    if (modeDroppedThisCall || !micLive) return;
    const available = await refreshAvailableMemory();
    if (modeDroppedThisCall || !micLive) return;
    if (!shouldDropToLight(voiceMode(), available)) { lowReadings = 0; return; }
    if (++lowReadings < 2) return;
    modeDroppedThisCall = true;
    voiceLog(`voice mode: dropped to light for the rest of this call (${Math.round(available / 1e6)} MB available)`);
    qwen.unload();
    emitNative("voice-mode", { mode: "light", reason: "low-memory" });
  };
  // The 3 s import probe runs once, in the background, so the first call already knows the status.
  void kokoro.status();
  // Bug 134: each Bot's call lines (greetings, fillers…) rendered once in its Kokoro voice and kept on
  // this Mac, so a pick-up plays at once; voicemail audio too, pruned after 30 days.
  const phraseCache = new PhraseCache({ dir: path.join(app.getPath("userData"), "voice-cache") });
  const voicemailDir = path.join(app.getPath("userData"), "voicemail");
  const voicemails = new PhraseCache({ dir: voicemailDir, maxBytes: 256 * 1024 * 1024, maxText: 600 });
  const pruneVoicemails = () => { const n = pruneOld(voicemailDir, CALL_FEEL.voicemailKeepMs); if (n) voiceLog(`voicemail: pruned ${n} older than 30 days`); };
  pruneVoicemails();
  setInterval(pruneVoicemails, 24 * 3_600_000).unref();
  // Bug 141: never pre-render while a call or dictation has the microphone; the lines calls asked for
  // are remembered so a new launch renders them before the next call.
  let micLive = false;
  /** Bug 164: the low-memory watch, running only while a call holds the microphone. */
  let voiceMemoryTimer: NodeJS.Timeout | null = null;
  const prerender = registerVoiceCache({ cache: phraseCache, tts: kokoro, qwen, log: voiceLog, live: () => micLive, book: path.join(app.getPath("userData"), "voice-cache", "phrasebook.json") });
  let wakeWire: ReturnType<typeof registerWakeWord> | null = null;
  // Bug 134: the Bots the Call menus list (the renderer sends them, in sidebar order).
  let callBots: { id: string; name: string }[] = [];
  // Bug 162: the compiled models of the user's own vocabulary, kept beside the app's data. Built in
  // the background when a new name list first appears; a session never waits on one. FUZZ never
  // builds one — it would spawn the real helper, and the fake has no --build-lm.
  const sttLm = process.env.FUZZ === "1" ? undefined : makeLmCache({
    binary: helperBinary,
    root: path.join(app.getPath("userData"), "stt-lm"),
    writeContext: writeContextFile,
    log: voiceLog,
  });
  // Bug 165: whisper.cpp re-transcribes each finished utterance. It follows Settings → Voice's
  // mode and nothing else: Light loads no model and passes no argument, so the helper is byte for
  // byte the session it was before. FUZZ never gets it either — the fake helper has no whisper.
  // Whether the binary was even built with whisper linked in — read once, it cannot change at run time.
  const whisperBuiltIn = process.env.FUZZ !== "1" && helperHasWhisper(helperBinary);
  const readWhisperStatus = () => whisperStatus({ userData: app.getPath("userData"), mode: voiceMode(), builtIn: whisperBuiltIn });
  // Measured (bug 165): whisper changes the words on 52% of turns, and a call speculates on the
  // likely-end partial — so in a call it would throw away that early start every other turn on top
  // of its own ~470 ms. Off for calls unless the user asks, on for dictation where the partials are
  // already on screen and the text only tightens.
  const whisperInCalls = (): boolean =>
    readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).whisperInCalls === true;
  registerNative("whisper.status.get", () => {
    const s = readWhisperStatus();
    return { state: s.state, name: s.name, size: humanBytes(s.bytes), inCalls: whisperInCalls(), root: whisperRoot(app.getPath("userData")) };
  });
  // Bug 165: a missing model says so and offers the download, rather than quietly leaving every
  // turn on Apple's text while Settings claims the accurate mode is on. One download at a time.
  let whisperDownloading = false;
  registerNative("whisper.model.download", () => {
    if (whisperDownloading) return { started: false };
    whisperDownloading = true;
    void downloadModel({
      userData: app.getPath("userData"),
      onProgress: (p) => {
        if (p.state !== "downloading") { whisperDownloading = false; voiceLog(`whisper model ${p.state === "ready" ? `ready (${p.name})` : `download failed: ${p.message}`}`); }
        emitNative("whisper", p);
      },
    }).catch((e: unknown) => {
      whisperDownloading = false;
      emitNative("whisper", { state: "failed", message: e instanceof Error ? e.message : String(e) });
    });
    return { started: true };
  });
  // Bug 198: Phone access — call a Bot from the user's phone over their own tailnet. The call screen
  // here still runs the call; only its microphone and speaker become the phone's.
  const phone = registerPhone({
    userData: app.getPath("userData"),
    clientDir: path.join(__dirname, "phone"),
    reg: registerNative, emit: emitNative, log: voiceLog,
    feed: (pcm) => dictation.feedRemote(pcm),
    muteHelper: (m) => dictation.muteRemote(m),
    // The push (VAPID) private key is sealed like the app's other secrets (the profile's key file, sealing.ts).
    seal: { encrypt: (s) => sealer.require((k) => k.encryptString(s)), decrypt: (b) => sealer.require((k) => k.decryptString(b)) },
    // FUZZ never looks for (or runs) the real Tailscale.
    ...(process.env.FUZZ === "1" ? { tailscale: makeTailscale({ find: () => process.env.SYNAPSE_TAILSCALE_CLI ?? null }) } : {}),
  });
  void phone.resume().catch((e: Error) => voiceLog(`phone: resume failed: ${e.message}`));
  // The tailnet mapping goes with the app (it is made again, and verified, at the next launch).
  app.on("will-quit", () => { phone.quit(); void phone.dispose(); });
  const dictation = registerDictation({
    remote: phone.calls,
    lm: sttLm,
    whisper: (mode) => helperWhisperArgs({ status: readWhisperStatus(), mode, dictationOnly: !whisperInCalls() }),
    tts: kokoro,
    f5,
    qwen,
    // Bug 161: the question ramp follows Settings → Voice, read at every spoken line.
    prosody: readProsody,
    phrases: phraseCache,
    onTtsIdle: () => prerender.pre.pump(),
    log: voiceLog,
    devices: readAudioPrefs,
    voice: readVoice,
    onDeviceEvent: () => { audioDevices?.invalidate(); wakeWire?.devicesChanged(); },
    // Wake word: dictation and calls own the microphone while they run.
    onActive: (active) => {
      micLive = active;
      wakeWire?.setActive(active);
      if (!active) prerender.kick();
      else prerender.pre.halt(); // bug 221: no pre-render (a Qwen take is seconds of GPU) beside the call just starting
      // Bug 164: the low-memory watch runs only while a call has the microphone, and the drop is
      // scoped to that call — the next one starts in the mode the user actually chose.
      if (active) { void checkVoiceMemory(); voiceMemoryTimer ??= setInterval(() => void checkVoiceMemory(), 10_000); voiceMemoryTimer.unref?.(); }
      else { if (voiceMemoryTimer) { clearInterval(voiceMemoryTimer); voiceMemoryTimer = null; } modeDroppedThisCall = false; lowReadings = 0; }
    },
    // Packaged: __dirname is inside app.asar, and Electron can only spawn() an executable that
    // lives outside the archive (electron-packager unpacks dist/native/** — see package.mjs).
    // resolveUnpacked is a no-op for a dev path (no app.asar segment), so this is unchanged there.
    binary: helperBinary,
    // Bug 99: check (and, the first time, ask for) the microphone before the helper starts. FUZZ
    // runs the fake helper and must never raise a real TCC prompt.
    micAccess: process.env.FUZZ === "1" ? undefined : () => ensureMicAccess(systemPreferences),
  });
  audioDevices = registerAudioDevices({
    binary: helperBinary,
    log: voiceLog,
    readPrefs: readAudioPrefs,
    writePrefs: (p) => {
      const s = writeAppSettings(app.getPath("userData"), { audioInput: p.input, audioOutput: p.output });
      return { input: s.audioInput ?? null, output: s.audioOutput ?? null };
    },
    applyLive: (p) => dictation.switchDevices(p),
    tts: kokoro,
    qwen,
    voicemails,
    readVoice,
    writeVoice: (v) => writeAppSettings(app.getPath("userData"), { ttsVoice: v }).ttsVoice ?? null,
    // FUZZ never leaves the app.
    openExternal: async (url) => { if (process.env.FUZZ !== "1") await shell.openExternal(url); },
  });
  // A device may have been plugged in or out while the app was in the background.
  win.on("focus", () => audioDevices?.invalidate());
  // "Hey <Bot name>" (Settings → Voice, off by default): an on-device listener, paused on lock, sleep,
  // dictation, calls, a Bluetooth microphone and (if chosen) battery; its state is in the menu bar.
  const devicesForWake = audioDevices!;
  wakeWire = registerWakeWord({
    binary: helperBinary, log: voiceLog, win: () => win, devices: readAudioPrefs,
    listDevices: () => devicesForWake.list().then((d) => d, () => null),
    ...wakeSettingsStore(appSettingsStore),
    tray: process.env.FUZZ !== "1",
    callItems: () => callMenuItems(callBots, callBot),
  });
  app.on("will-quit", () => wakeWire?.dispose());
  // A Bot calling the user: quiet hours and Focus decide whether the Mac rings (the host owns the rest).
  registerBotCalls({
    win: () => win, home: os.homedir(),
    ...quietHoursStore(appSettingsStore),
    // Bug 198: a paired phone gets the ring as a notification too.
    onRing: (botId, title, body) => void phone.ring(botId, title, body),
  });
  // Bug 99: the "Open System Settings" button on a denied microphone / speech permission. The
  // renderer names a pane; only the two fixed deep links can open. FUZZ never leaves the app.
  registerNative("openPrivacySettings", async (a: { pane?: unknown }) => {
    const url = privacySettingsUrl(a?.pane);
    if (process.env.FUZZ === "1") return { opened: false };
    await shell.openExternal(url);
    return {};
  });
  // Screen share on a call: one still of the main display per turn, only while the user shares.
  registerNative("screen.capture", () => captureScreen({
    status: () => systemPreferences.getMediaAccessStatus("screen"),
    primary: () => screen.getPrimaryDisplay(),
    sources: (o) => desktopCapturer.getSources(o),
  }));
  installAppMenu((ch) => emitNative(ch, {}));
  // Bug 134 (item 9): call from anywhere — the menu bar's Call menu, the wake word's menu-bar item and a
  // global shortcut (⌥⌘C by default; Settings → Voice). The renderer sends the Bot list and places the call.
  function callBot(botId: string): void {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    emitNative("call-bot", { botId });
  }
  function refreshCallMenus(): void {
    installAppMenu((ch) => emitNative(ch, {}), { items: callMenuItems(callBots, callBot) });
    wakeWire?.refreshMenu();
  }
  registerNative("calls.menu.set", (a: { bots?: unknown }) => {
    const list = Array.isArray(a?.bots) ? a.bots : [];
    callBots = list.filter((b): b is { id: string; name: string } => !!b && typeof (b as { id?: unknown }).id === "string" && typeof (b as { name?: unknown }).name === "string")
      .slice(0, 50).map((b) => ({ id: b.id.slice(0, 80), name: b.name.slice(0, 60) }));
    refreshCallMenus();
    return {};
  });
  if (process.env.FUZZ !== "1") {
    registerCallShortcut({
      shortcuts: globalShortcut,
      read: () => readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).callShortcut,
      write: (a) => { writeAppSettings(app.getPath("userData"), { callShortcut: a }); },
      onFire: () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); emitNative("call-current", {}); },
      log: voiceLog,
    });
    app.on("will-quit", () => globalShortcut.unregisterAll());
  }
  // phase5 native modules register here (Tasks 21, 29, 31)
  const updater = registerUpdater(
    {
      app,
      // The local release folder (npm run release writes latest.json there); GitHub is optional.
      folder: () => readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).updateFolder || defaultReleaseDir(),
      setFolder: (d) => writeAppSettings(app.getPath("userData"), { updateFolder: d }),
      chooseFolder: async () => (await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })).filePaths[0] ?? null,
      // The feed (validated owner/repo) and the read-only token live in the profile's update-source.json
      // (0600, the token encrypted at rest; update-source.ts), not the keychain — a relocked keychain
      // silently broke the permission switches (bug 225) and would have broken updates the same way.
      // A legacy plaintext feed in app-settings.json moves once.
      feed: () => {
        const ud = app.getPath("userData");
        const legacy = readAppSettings(ud, app.getAppPath(), appRuntime()).updateFeed;
        if (legacy) {
          if (validFeed(legacy) && !readUpdateSource(ud).feed) writeUpdateSource(ud, { feed: legacy });
          writeAppSettings(ud, { updateFeed: null });
        }
        return effectiveFeed(readUpdateSource(ud).feed);
      },
      setFeed: (f) => writeUpdateSource(app.getPath("userData"), { feed: f }),
      setToken: (t) => writeUpdateSource(app.getPath("userData"), { token: t }),
      hasToken: () => readUpdateSource(app.getPath("userData")).token !== null,
      auto: () => readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).autoUpdate ?? true, // on unless the user turned it off; checking happens either way
      setAuto: (on) => writeAppSettings(app.getPath("userData"), { autoUpdate: on }),
      // Never plaintext AppSettings — the private repo's releases/latest and asset endpoints both 404
      // unauthenticated (Fix round 1, finding 1).
      token: () => readUpdateSource(app.getPath("userData")).token,
    },
    registerNative,
    emitNative,
  );
  launch.onRolledBack((v) => updater.noteRolledBack(v));

  let handle: GatewayHandle | null = null;
  /** The last connect() reached the host (setup's "connect" step reads it). */
  let hostConnected = false;
  /** Why the last connect() failed (setup's "connect" step shows another account's host as it is). */
  let hostConnectError: string | null = null;
  // Settings → Account and the setup screen can Save before the first connection lands (or after it failed): the
  // auth IPC is there from the start and says why, instead of Electron's "No handler registered".
  registerAuthIpc(ipcMain, () => (hostConnected ? apiKeySender : null), () => hostConnectError);
  // Settings → Connected accounts → Composio: the Paste click reads the clipboard here and hands the key straight to
  // the host. FUZZ never touches the real clipboard: it pastes a stand-in key the fake Composio accepts.
  registerComposioPaste({
    reg: registerNative,
    readClipboard: () => (process.env.FUZZ === "1" ? process.env.FUZZ_COMPOSIO_KEY ?? "ak_fuzz_example_key_0000" : clipboard.readText()),
    call: () => (handle ? gatewayCall(handle.baseUrl, handle.token, hostCallOpts) : null),
  });
  // Settings → Backups: talks to whichever host the app is connected to right now.
  registerBackups({
    userData: app.getPath("userData"), appDir: app.getAppPath(), runtime: appRuntime(), appVersion: app.getVersion(), fuzz: process.env.FUZZ === "1",
    gateway: () => (handle ? { baseUrl: handle.baseUrl, token: handle.token } : null),
    hostFetch,
    reconnect: () => connect(),
    call: (cmd) => { if (!handle) throw new Error("Synapse isn't connected to its host yet."); return gatewayCall(handle.baseUrl, handle.token, hostCallOpts)(cmd, {}); },
    reg: registerNative, emit: emitNative,
    dialog: {
      openFolder: async () => (await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })).filePaths[0] ?? null,
      openArchive: async () => (await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Synapse backup", extensions: ["synbak"] }] })).filePaths[0] ?? null,
      saveText: async (name, text) => {
        const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), name) });
        if (r.canceled || !r.filePath) return false;
        fs.writeFileSync(r.filePath, text, { mode: 0o600 });
        return true;
      },
    },
    reveal: (f) => shell.showItemInFolder(f),
    machine: boxMachine,
  });
  ipcMain.handle("save-file", (_e, req: { path: string; name: string }) => (handle ? saveFileFromGateway(win, hostFetch, req) : { saved: false }));
  ipcMain.on("native-theme", (_e, pref: string) => {
    applyNativeTheme(pref);
    cacheTheme(themeFile, pref);
    if (!win.isDestroyed()) win.setBackgroundColor(windowBackground(nativeTheme.shouldUseDarkColors));
  });
  const connect = async () => {
    coordinator.postMessage({ type: "state", state: { kind: "starting" } });
    streamUp = false;
    try {
      // Reconnect: keep a FUZZ host's store, so a restarted host recovers its data (interrupted runs) like the box.
      const reuseRoot = handle?.root;
      await handle?.dispose({ keepData: true });
      handle = await resolveGateway({
        env: scrubClaudeLogin(process.env), userData: app.getPath("userData"), appDir: app.getAppPath(), runtime: appRuntime(), reuseRoot, machine: boxMachine(),
        storeSecret: (n, v) => storeSecret(app.getPath("userData"), n, v),
        // An older host under another uid sits on 47800 (maybe another account's): bring it up to date through orb
        // before any token goes out. Under the one box-operations lock, like every other deploy.
        redeployOldHost: async () => {
          const release = boxLock.tryAcquire("re-provision");
          if (!release) throw new Error(boxBusyMessage(boxLock.holder()));
          try {
            const boxDir = process.env.APP_BOX_DIR ?? defaultBoxDir(app.getAppPath(), appRuntime());
            await new OrbBoxOps({ exec: execCommand, boxDir, machine: boxMachine(), health: async () => false }).deploy();
          } finally { release(); }
        },
      });
      // Test-only hook: FUZZ=1 is never set for a real user profile, only the disposable fuzz/e2e
      // local host. Lets Playwright's app.evaluate() read the current baseUrl/token to assert host
      // state directly (bypassing the renderer's optimistic UI), the same way host/test's in-process
      // gateway tests already do.
      if (process.env.FUZZ === "1") {
        (globalThis as unknown as { __fuzzGateway?: { baseUrl: string; token: string } }).__fuzzGateway = { baseUrl: handle.baseUrl, token: handle.token };
      }
      // Bug 225: the permission files are signed with the profile's own local-policy.key; the old keychain-derived key
      // is asked for only while that file doesn't exist yet (the one-time migration), never again after.
      const userData = app.getPath("userData");
      const legacyPolicyKey = fs.existsSync(path.join(userData, "local-policy.key")) ? undefined : localPolicyKey(userData);
      hostCallOpts = { hello: handle.hello === true, onStale: freshHostCreds, proven: (c) => streamProves(streamUp, currentCreds, c) };
      currentCreds = { baseUrl: handle.baseUrl, token: handle.token, hello: handle.hello === true };
      coordinator.postMessage({ type: "connect", baseUrl: handle.baseUrl, token: handle.token, hello: handle.hello === true, userData, legacyPolicyKey });
      startSecrets(app.getPath("userData"), handle.baseUrl, handle.token);
      startBoxOps(win, app.getPath("userData"), handle.baseUrl, handle.token, async () => { await connect(); });
      // A hold left by an app that crashed or quit mid-operation is let go on every connect, unless this app is
      // running a box operation itself (then the host was restarted under it and the operation still owns it).
      const conn = handle;
      void releaseStaleHold({ lock: boxLock, hold: (on) => gatewayCall(conn.baseUrl, conn.token, hostCallOpts)("setBoxMaintenance", { on }), log: (l) => console.log(l) })
        .then((released) => { if (released) holdingTurns = false; })
        .finally(() => void afterConnected());
      gatewayToken = handle.token;
      hostConnected = true;
      hostConnectError = null;
      void checkHost();
    } catch (e) {
      hostConnected = false;
      hostConnectError = (e as Error).message;
      currentCreds = null;
      coordinator.postMessage({ type: "state", state: { kind: "unreachable", error: (e as Error).message } });
    }
  };
  ipcMain.on("retry-connection", () => void connect());
  // A refused token: before anyone is told "another account", the box's gateway.json is read again. A new token (the
  // machine was recreated), a new port (a redeploy moved it) or a new proof (an updated host) reconnects everything;
  // an unchanged box means the host there really isn't ours.
  let staleCheck: Promise<HostCreds | null> | null = null;
  const freshHostCreds = (): Promise<HostCreds | null> => (staleCheck ??= (async () => {
    try {
      if (!handle || handle.mode !== "box") return null;
      const st = readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime());
      const info = await new OrbBoxProvider(execCommand, { machine: boxMachine(), route: st.gatewayRoute, gatewayHost: st.gatewayHost }).readGatewayInfo(5_000).catch(() => null);
      if (!info || !hostMoved(handle, info)) return null;
      await connect();
      return hostConnected && handle ? { baseUrl: handle.baseUrl, token: handle.token, hello: handle.hello === true } : null;
    } finally { staleCheck = null; }
  })());
  onGatewayRefused = () => void freshHostCreds().then((c) => {
    if (!c) coordinator.postMessage({ type: "state", state: { kind: "unreachable", error: WRONG_HOST_MESSAGE } });
  });
  // Portable install: the first-run setup screen (OrbStack → the Bots' computer → Claude → optional
  // voices, phone access, updates). An existing profile (it pinned a box) never sees it.
  const boxDirNow = () => process.env.APP_BOX_DIR ?? defaultBoxDir(app.getAppPath(), appRuntime());
  registerSetup({
    reg: registerNative, emit: emitNative,
    userData: app.getPath("userData"), appDir: app.getAppPath(), runtime: appRuntime(), home: os.homedir(),
    exec: execCommand, orb: () => resolveOrb(), machine: boxMachine, boxDir: boxDirNow,
    imageVersion: () => { try { return bundledImageVersion(boxDirNow()); } catch { return null; } },
    hostBuild: () => (app.isPackaged ? bundledHostBuild(process.resourcesPath) : bundledHostBuild(path.join(app.getAppPath(), ".."))),
    reconnect: () => connect(), connected: () => hostConnected, connectError: () => hostConnectError,
    forgetPin: () => new BoxPin(boxPinFile()).forget(),
    openExternal: async (url) => { if (process.env.FUZZ !== "1") await shell.openExternal(url); },
    skip: process.env.FUZZ === "1" && process.env.SYNAPSE_SETUP_FORCE !== "1",
    log: (l) => console.log(l),
    lock: boxLock,
  });

  // Updates, once per launch after the first good connection: bring the box's host up to the build this
  // app ships, once no Bot is working. (The swap script's health marker is written at window + renderer load.)
  // Diagnostics: a host whose previous run ended without close() crashed; its journal tail (cut
  // to time, level and message in the crash store) goes with the report.
  const checkHost = async () => {
    if (!handle) return;
    const r = await hostFetch("/health").catch(() => null);
    const h = r?.ok ? (await r.json().catch(() => null)) as { hostVersion?: string; previousRun?: { bootId: string; startedAt: number; clean: boolean } | null } | null : null;
    if (h?.hostVersion) lastHostVersion = h.hostVersion;
    await crash.noteHostHealth(h, async () => {
      if (process.env.FUZZ === "1") return [];
      const j = await execCommand(resolveOrb(), ["-m", boxMachine(), "-u", "root", "journalctl", "-u", "bothost", "-n", "400", "-o", "cat", "--no-pager"], { timeoutMs: 15_000 });
      return j.code === 0 ? j.stdout.split("\n") : [];
    });
  };
  let afterUpdateDone = false;
  const afterConnected = async () => {
    if (afterUpdateDone || !handle) return;
    const health = async () => { const r = await hostFetch("/health").catch(() => null); return r?.ok ? (await r.json()) as { hostBuild?: string | null } : null; };
    if (!(await health())) return;
    afterUpdateDone = true;
    if (!app.isPackaged || process.env.FUZZ === "1") return;
    const boxDir = process.env.APP_BOX_DIR ?? defaultBoxDir(app.getAppPath(), appRuntime());
    const ops = new OrbBoxOps({ exec: execCommand, boxDir, machine: boxMachine(), health: async () => !!(await health()) });
    const updateLog = createRotatingLog({ dir: logsDir(), name: "update.log", maxBytes: 256 * 1024, keep: 2 });
    // Portable install: the box's own setup travels with the app. When the bundle's provision version
    // differs from the box's, provision runs again IN PLACE (then deploy, then verify) — once no Bot is
    // working and no call holds the microphone. It deploys the host too, so the host check below is then current.
    // Fix round 1: nothing that restarts the host runs while a Bot's turn could be cut. New turns are HELD on the
    // host (queued, answered after — even across the deploy's restart), running turns finish first, and the one
    // box-operations lock keeps this apart from setup and Settings → Update.
    // The hold is a lease on the host (5 min); reprovisionIfChanged renews it every minute while it runs.
    const hold = async (on: boolean, opts?: { quietMs?: number }) => {
      const r = await gatewayCall(handle!.baseUrl, handle!.token, hostCallOpts)("setBoxMaintenance", on ? { on, ttlMs: HOLD_LEASE_MS, ...(opts?.quietMs ? { quietMs: opts.quietMs } : {}) } : { on });
      holdingTurns = on && !r.deferred;
      return r;
    };
    const runReprovision = async (): Promise<void> => {
      const result = await reprovisionIfChanged({
        bundled: () => { try { return bundledImageVersion(boxDir); } catch { return null; } },
        boxVersion: async () => {
          const m = await machineMarks(execCommand, resolveOrb(), boxMachine());
          return m.ok ? { ok: true as const, version: m.provisioned ?? m.image } : { ok: false as const };
        },
        callLive: () => micLive,
        lock: boxLock,
        hold,
        provision: () => ops.provision(), deploy: deployAndReconnect({ deploy: () => ops.deploy(), reconnect: () => connect() }), waitHealthy: () => ops.waitHealthy(180_000),
        verify: async () => {
          const r = await execCommand("bash", [path.join(boxDir, "verify-box.sh")], { timeoutMs: 10 * 60_000, env: { ORB: resolveOrb(), BOX_MACHINE: boxMachine(), ...boxPortEnv(process.getuid?.() ?? 501) } });
          const failed = r.stdout.split("\n").filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(5));
          return { ok: r.code === 0 && failed.length === 0, failed };
        },
        status: (s) => { lastBoxUpdate = s; emitNative("box-update", s); },
        log: updateLog,
      }).catch((e: Error) => { updateLog(`box update failed: ${e.message}`); return "failed" as const; });
      // A marker that couldn't be read is never a difference: look again later, never re-provision on it.
      if (result === "retry-later") setTimeout(() => void runReprovision(), 10 * 60_000).unref();
      if (result === "reprovisioned" || result === "failed" || result === "retry-later") return;
      // The host build alone changed: deploy under the same hold and lock.
      const release = boxLock.tryAcquire("re-provision");
      if (!release) { updateLog("host redeploy: another operation on the Bots' computer is running; next launch"); return; }
      // Same lease and the same 2-minute cap on waiting for running turns as the re-provision (bug 258).
      let since = 0;
      let stopRenew: (() => void) | null = null;
      let capped = false;
      await redeployHostIfChanged({
        bundledBuild: () => bundledHostBuild(process.resourcesPath), health,
        prepare: async () => {
          // Bug 258: the host redeploy defers like the re-provision while the user wrote in the last 5 minutes.
          const r = await hold(true, since ? undefined : { quietMs: USER_QUIET_MS });
          if (!since && r.deferred) { capped = true; throw new Error("the user wrote in the last 5 minutes; deferred, will try again later"); }
          if (!since) { since = Date.now(); stopRenew = renewEvery(() => { void hold(true).catch(() => {}); }, HOLD_RENEW_MS); }
          if (r.runningBotIds.length && Date.now() - since >= HOLD_WAIT_CAP_MS) { capped = true; throw new Error(`${r.runningBotIds.length} Bot(s) still working after ${Math.round(HOLD_WAIT_CAP_MS / 60_000)} min; released the hold, will try again later`); }
          return { ok: r.runningBotIds.length === 0, busyBotIds: r.runningBotIds };
        },
        deploy: deployAndReconnect({ deploy: () => ops.deploy(), reconnect: () => connect() }), waitHealthy: () => ops.waitHealthy(180_000), log: updateLog,
        retryMs: 5_000,
      }).then(async () => { stopRenew?.(); if (holdingTurns) await hold(false).catch(() => {}); })
        .catch(async (e: Error) => { stopRenew?.(); updateLog(`host redeploy: ${e.message}`); if (holdingTurns) await hold(false).catch(() => {}); })
        .finally(() => { release(); if (capped) setTimeout(() => void runReprovision(), 10 * 60_000).unref(); });
    };
    retryBoxUpdate = runReprovision;
    await runReprovision();
  };
  // Settings: the last box update's outcome (a failure shows once, with Retry).
  registerNative("boxUpdate.status", () => ({ status: lastBoxUpdate, busyWith: boxLock.holder() }));
  registerNative("boxUpdate.retry", () => {
    if (!retryBoxUpdate) throw new Error("The Bots' computer isn't connected yet.");
    if (boxLock.holder()) throw new Error(boxBusyMessage(boxLock.holder()));
    void retryBoxUpdate();
    return { started: true };
  });

  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting) return;
    // Quitting mid box operation: let the held turns run now (best effort; the host's lease is the backstop).
    if (holdingTurns && handle) {
      holdingTurns = false;
      void gatewayCall(handle.baseUrl, handle.token, hostCallOpts)("setBoxMaintenance", { on: false }).catch(() => {});
    }
    const keep = readAppSettings(app.getPath("userData"), app.getAppPath(), appRuntime()).keepBoxOnQuit !== false;
    if (keep || !handle?.stopBox) {
      void handle?.dispose();
      coordinator.kill();
      return;
    }
    e.preventDefault();
    quitting = true;
    void shutdownOnQuit({
      keepBoxOnQuit: false,
      dispose: () => handle?.dispose(),
      kill: () => coordinator.kill(),
      stopBox: handle.stopBox,
    }).finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());

  // Bug 258 (fix round): the No limits confirm is a per-dialog nonce. The renderer mints one right before the confirm
  // dialog and passes it as `confirm`; the coordinator daemon checks it once with `nolimits-verify`. Single-use, 2-min
  // TTL, and only for a window this app owns — so a Bot can never produce the token that turns No limits on.
  const noLimitsNonces = new Map<string, number>();
  registerNative("noLimits.mintNonce", () => {
    const nonce = randomBytes(24).toString("base64url");
    const now = Date.now();
    for (const [k, exp] of noLimitsNonces) if (exp < now) noLimitsNonces.delete(k);
    noLimitsNonces.set(nonce, now + 2 * 60_000);
    return { nonce };
  });
  const consumeNoLimitsNonce = (nonce: string): boolean => {
    const exp = noLimitsNonces.get(nonce);
    if (exp === undefined) return false;
    noLimitsNonces.delete(nonce);
    return exp >= Date.now();
  };

  registerNative("seal.get", () => sealer.state());
  // bug-log 128: the Mac's free space, on launch and every 10 minutes (banner under 15 GB, a
  // notification under 5 GB); the box's comes from the host's /health for Settings → Diagnostics.
  registerMacDisk({
    path: os.homedir(), reg: registerNative, emit: (v) => emitNative("mac-disk", v),
    notify: (title, body) => showAppNotification(win, { title, body }),
    boxFree: async () => {
      if (!handle) return null;
      const r = await hostFetch("/health").catch(() => null);
      const h = r?.ok ? (await r.json().catch(() => null)) as { diskFreeBytes?: number | null } | null : null;
      return typeof h?.diskFreeBytes === "number" ? h.diskFreeBytes : null;
    },
  });

  await win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // PAST THIS LINE ONLY. The window exists and the run loop is spinning, so the one keychain read of a migration
  // launch can be asked and answered; before it, a keychain call blocked the main thread inside
  // SecItemCopyMatching and the app never drew anything at all.
  await openSecrets();
  // The update feed and token used to live in secrets/: moved into the profile's update-source.json once.
  try {
    const ud = app.getPath("userData");
    if (migrateUpdateSourceFromKeychain(ud, { readable: sealer.state().status === "ready", read: (n) => readSecret(ud, n) })) console.log("updates: feed and token moved out of the keychain into update-source.json");
  } catch (e) { console.error(`updates: moving the feed out of the keychain failed: ${(e as Error).message}`); }
  void connect();
}

if (process.env[PROBE_ENV] === "1") {
  // This process IS the bounded canary a parent app spawned: answer with one line and exit. It must
  // not take the single-instance lock (the parent holds it), must not open a window, and gets its
  // own throwaway user-data dir so it cannot disturb the profile that asked.
  const probeData = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-keychain-probe-"));
  app.setPath("userData", probeData);
  void app.whenReady().then(() => runProbeMode({
    store: electronStore,
    write: (s) => process.stdout.write(s),
    exit: (c) => { fs.rmSync(probeData, { recursive: true, force: true }); app.exit(c); },
  }));
} else if (process.env[SELFTEST_ENV]) {
  // Portable install: prove the shipped bundle speaks on its own (kokoro-selftest.ts). No window, no host.
  const out = path.resolve(process.env[SELFTEST_ENV]!);
  void app.whenReady().then(async () => {
    const r = await kokoroSelfTest({
      out, script: resolveUnpacked(path.join(__dirname, "native", "kokoro_server.py")),
      bundled: bundledKokoroDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), env: scrubClaudeLogin(process.env) }),
      userData: app.getPath("userData"), log: (l) => process.stderr.write(`${l}\n`),
    });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    app.exit(r.ok ? 0 : 1);
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else void start();
