import fs from "node:fs";
import path from "node:path";
import { acceptableGatewayPorts, LEGACY_PORT_UID, STR, WRONG_HOST_CODE, WRONG_HOST_MESSAGE } from "@synapse/shared";
import { readAppSettings } from "./app-settings";
import type { AppRuntime } from "./box-lifecycle";
import { execCommand, OrbBoxProvider } from "./box-provider";
import { checkHost } from "./host-hello";
import { launchLocalHost, type LocalHost } from "./local-host";

/** dispose({ keepData: true }) is for a reconnect: a FUZZ local host's disposable store survives for the next launch (root). */
/** `hello`: the host answers /hello, so every later caller proves it before sending the token (host-hello.ts). */
export interface GatewayHandle { baseUrl: string; token: string; hello?: boolean; mode: "box" | "local"; root?: string; dispose(o?: { keepData?: boolean }): void | Promise<void>; stopBox?(): Promise<void> }

type Provider = Pick<OrbBoxProvider, "ensureRunning" | "readGatewayInfo" | "connect"> & { stop?(): Promise<void> };

export interface BootstrapDeps {
  env: NodeJS.ProcessEnv;
  userData: string;
  appDir: string;
  /** Packaged: box/route.env comes from the bundle's Resources. */
  runtime?: AppRuntime;
  provider?: Provider;
  launchLocal?: typeof launchLocalHost;
  storeSecret?: (name: string, value: string) => void;
  /** Portable install: the OrbStack machine ("synapse-box" for a new install; an existing "box" kept). */
  machine?: string;
  /** FUZZ: the previous local host's store, reused on reconnect so a host restart keeps its data like the box. */
  reuseRoot?: string;
  /** The identity check's fetch (tests pass a fake). */
  fetchImpl?: typeof fetch;
  /** This Mac user's uid: the box may only report this user's port (or 47800 while an older install moves). */
  uid?: number;
  /**
   * Redeploys the host through orb (deploy.sh: no gateway token needed). Used when the box still runs a host too old
   * for /hello under a uid other than 501: that host sits on 47800, which may be uid 501's, so it is brought up to
   * date (and onto this user's own port) before anything carrying the token is sent.
   */
  redeployOldHost?: () => Promise<void>;
}

/** A port answered, but not by this account's host (two macOS accounts on one Mac share 127.0.0.1). */
export class WrongHostError extends Error {
  readonly code = WRONG_HOST_CODE;
  constructor() { super(WRONG_HOST_MESSAGE); }
}

/**
 * Where the local host's bundle actually is.
 *
 * In the repo it is `<appDir>/../host/dist/host.mjs`. Packaged, `appDir` is
 * `…/Contents/Resources/app.asar`, so that same expression points at
 * `…/Contents/Resources/host/dist/host.mjs` — which the packager never shipped, so FUZZ mode in the
 * packaged app always died with "The local host exited during start-up" and no test could ever run
 * the shipped artefact. `scripts/package.mjs` now ships `host/dist` as an extraResource and this
 * falls back to `resourcesPath`, so both layouts resolve to a file that exists.
 */
export function hostBundlePath(d: Pick<BootstrapDeps, "env" | "appDir" | "runtime">): string {
  if (d.env.SYNAPSE_HOST_BUNDLE) return d.env.SYNAPSE_HOST_BUNDLE;
  const dev = path.resolve(d.appDir, "..", "host", "dist", "host.mjs");
  const bundled = d.runtime?.resourcesPath ? path.join(d.runtime.resourcesPath, "host", "dist", "host.mjs") : null;
  for (const c of [dev, bundled]) if (c && fs.existsSync(c)) return c;
  // Nothing on disk: name the dev path, so the failure says where it looked.
  return dev;
}

export async function resolveGateway(d: BootstrapDeps): Promise<GatewayHandle> {
  if (d.env.FUZZ === "1" || d.env.SYNAPSE_LOCAL_HOST === "1") {
    const local: LocalHost = await (d.launchLocal ?? launchLocalHost)({
      bundle: hostBundlePath(d),
      dataDir: path.join(d.userData, "local-host"),
      disposable: d.env.FUZZ === "1",
      ...(d.env.FUZZ === "1" && d.reuseRoot ? { root: d.reuseRoot } : {}),
      // Journeys (scripts/journeys, 5.9): a FUZZ host store that outlives the app, so a cold start can be timed on a
      // profile that has Bots and has finished onboarding. FUZZ-only; the folder is the caller's to remove.
      ...(d.env.FUZZ === "1" && !d.reuseRoot && d.env.SYNAPSE_FUZZ_HOST_ROOT ? { root: d.env.SYNAPSE_FUZZ_HOST_ROOT, keepRoot: true } : {}),
    });
    return { baseUrl: local.baseUrl, token: local.token, mode: "local", root: local.root, dispose: (o) => local.stop(o) };
  }
  const s = readAppSettings(d.userData, d.appDir, d.runtime);
  const provider = d.provider ?? new OrbBoxProvider(execCommand, { machine: d.machine ?? "box", route: s.gatewayRoute, gatewayHost: s.gatewayHost });
  await provider.ensureRunning();
  const uid = d.uid ?? process.getuid?.() ?? 501;
  // Before anything is sent: the port must be one this user's box may use, then the host there must prove it holds the
  // token just read from THIS account's box (another account's host, or anyone who bound the port first, can't).
  // A refusal re-reads gateway.json once: a machine recreated since the last read has a new token.
  let info = await provider.readGatewayInfo();
  if (info.hello !== true && uid !== LEGACY_PORT_UID) {
    if (!d.redeployOldHost) throw new Error(STR.hostNeedsUpdate);
    // Before a connection only the connection screen's Retry is there, so a failure says to use it (the raw reason
    // is in the update log).
    try { await d.redeployOldHost(); } catch { throw new Error(STR.hostNeedsUpdate); }
    info = await provider.readGatewayInfo();
    if (info.hello !== true) throw new Error(STR.hostNeedsUpdate);
  }
  let conn = await open(provider, info, uid);
  let verdict = await checkHost({ baseUrl: conn.baseUrl, token: info.token, hello: info.hello === true, fetchImpl: d.fetchImpl });
  if (verdict === "refused") {
    conn.close();
    info = await provider.readGatewayInfo();
    conn = await open(provider, info, uid);
    verdict = await checkHost({ baseUrl: conn.baseUrl, token: info.token, hello: info.hello === true, fetchImpl: d.fetchImpl });
    if (verdict === "refused") { conn.close(); throw new WrongHostError(); }
  }
  // Nothing answering yet is not a verdict: the connection's own retry and "didn't answer" state cover a host starting.
  d.storeSecret?.("gatewayToken", info.token);
  const opened = conn;
  return {
    baseUrl: conn.baseUrl, token: info.token, hello: info.hello === true, mode: "box", dispose: () => opened.close(),
    ...(provider.stop ? { stopBox: () => provider.stop!() } : {}),
  };
}

async function open(provider: Provider, info: { port: number }, uid: number): Promise<{ baseUrl: string; close(): void }> {
  if (!Number.isInteger(info.port) || !acceptableGatewayPorts(uid).includes(info.port)) throw new Error(STR.hostOddPort(info.port));
  return provider.connect(info.port);
}
