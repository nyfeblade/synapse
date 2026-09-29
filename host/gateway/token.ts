import { randomBytes } from "node:crypto";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

/** `hello: 1`: this host answers /hello (proof of host), so the app never sends it the token unproven. */
export interface GatewayInfo { port: number; pid: number; startedAt: number; scheme: "http"; host: string; token: string; hello?: 1 }

export function loadOrCreateGatewayToken(hostPrivate: string): string {
  const existing = readJson<Partial<GatewayInfo> | null>(path.join(hostPrivate, "gateway.json"), null);
  if (existing?.token && existing.token.length >= 32) return existing.token;
  return randomBytes(32).toString("hex");
}

export function writeGatewayInfo(hostPrivate: string, info: GatewayInfo): void {
  writeJsonAtomic(path.join(hostPrivate, "gateway.json"), info, 0o600);
}
