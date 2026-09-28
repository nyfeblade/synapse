import fs from "node:fs";
import path from "node:path";
import { readAppSettings } from "./app-settings";
import type { AppRuntime } from "./box-lifecycle";
import { execCommand, OrbBoxProvider } from "./box-provider";
import { launchLocalHost, type LocalHost } from "./local-host";

/** dispose({ keepData: true }) is for a reconnect: a FUZZ local host's disposable store survives for the next launch (root). */
export interface GatewayHandle { baseUrl: string; token: string; mode: "box" | "local"; root?: string; dispose(o?: { keepData?: boolean }): void | Promise<void>; stopBox?(): Promise<void> }

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
    });
    return { baseUrl: local.baseUrl, token: local.token, mode: "local", root: local.root, dispose: (o) => local.stop(o) };
  }
  const s = readAppSettings(d.userData, d.appDir, d.runtime);
  const provider = d.provider ?? new OrbBoxProvider(execCommand, { machine: d.machine ?? "box", route: s.gatewayRoute, gatewayHost: s.gatewayHost });
  await provider.ensureRunning();
  const info = await provider.readGatewayInfo();
  d.storeSecret?.("gatewayToken", info.token);
  const conn = await provider.connect(info.port);
  return {
    baseUrl: conn.baseUrl, token: info.token, mode: "box", dispose: () => conn.close(),
    ...(provider.stop ? { stopBox: () => provider.stop!() } : {}),
  };
}
