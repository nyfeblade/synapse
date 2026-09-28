import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { AckLedger } from "../../runner/ack-ledger";
import { newSlot } from "../../runner/turn-slot";
import { sealTo } from "../../secrets/crypto";
import { SecretRequestService } from "../../secrets/secret-requests";
import { SecretVault } from "../../secrets/vault";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// SEC-10 finding: submitSecret's "connector" branch wrote the host-private connector credential
// file (connector-secrets/<botId>/<platform>.json — real plaintext connector secrets) via a raw
// fs.mkdirSync/existsSync/readFileSync/writeFileSync sequence — writing straight to the final
// path — instead of the repo's writeJsonAtomic (tmp file + fsync + rename), unlike vault.ts's
// apply() (same directory, same class of secret material, two branches up in the same switch)
// which already goes through it. A crash or concurrent write mid-fs.writeFileSync can
// truncate/corrupt the file. Spy on the real fs primitives (no module mock, so every other
// component in this setup keeps working normally) to prove the write now goes through a
// "<file>.<pid>.<ts>.tmp" temp file + rename, per reviewer-rules.md's atomic-write contract,
// rather than writing the final path directly.
describe("submitSecret connector destination writes atomically (SEC-10)", () => {
  it("writes via a temp file + rename, never a direct fs.writeFileSync(file, ...)", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
    const acks = new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json"));
    const vault = await SecretVault.open({ hostPrivate: cfg.hostPrivate });
    const id = bots.create({ origin: "user", kickstart: false, name: "Ledger" });
    const slot = newSlot({ botId: id, requestId: "req_1", turnNo: 5, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 1 });
    const svc = new SecretRequestService({
      bots, acks, vault, slot: () => slot, enqueueHidden: () => {}, connectorDir: path.join(cfg.hostPrivate, "connector-secrets"), now: () => 9,
      fill: async () => true,
    });
    const entryOf = () => bots.tail(id, 10).filter((e): e is SendMessageEntry => e.kind === "send-message").at(-1)!;

    const file = path.join(cfg.hostPrivate, "connector-secrets", id, "linear.json");
    const writeFileSpy = vi.spyOn(fs, "writeFileSync");
    const renameSpy = vi.spyOn(fs, "renameSync");
    try {
      await svc.sendSecretRequest(id, { secret: { label: "Linear API key", connector: "linear", field: "api_key" } });
      const e = entryOf();
      const status = await svc.submitSecret(id, e.id, await sealTo(vault.publicKey, "lin_api_123"), "h");
      expect(status).toBe("saved");

      // The atomic-write contract: a temp file named "<file>.<pid>.<ts>.tmp" is renamed onto the
      // real path — never a direct writeFileSync(file, ...).
      const renamedToFile = renameSpy.mock.calls.filter(([, dest]) => dest === file);
      expect(renamedToFile).toHaveLength(1);
      const tmpArg = renamedToFile[0]![0] as string;
      expect(tmpArg).toMatch(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+\\.\\d+\\.tmp$`));
      expect(writeFileSpy.mock.calls.some(([target]) => target === file)).toBe(false);

      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ api_key: "lin_api_123" });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      writeFileSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });
});
