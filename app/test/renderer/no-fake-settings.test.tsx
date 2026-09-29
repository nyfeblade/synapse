// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { settingEntries } from "../../src/renderer/components/settings/search-index";
import { UpdatesSection } from "../../src/renderer/components/settings/UpdatesSection";
import { useUpdates } from "../../src/renderer/updates/store";
import * as OnboardingModule from "../../src/renderer/onboarding/Onboarding";

/**
 * Code audit 2026-09-29 §5.1, §5.2, §4.8: no settings that do nothing and no dead links. The hardware security key
 * switch was permanently disabled (no WebAuthn behind it), the Update Track select had one option and saved nothing,
 * and the splash's "Terms" link opened github.com.
 */
const repo = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(repo, p), "utf8");
afterEach(cleanup);

describe("the security key switch is gone", () => {
  it("from Settings, its search, its copy and the host", () => {
    expect(fs.existsSync(path.join(repo, "app/src/renderer/components/settings/SecurityKeyBlock.tsx"))).toBe(false);
    expect(read("app/src/renderer/main.tsx")).not.toMatch(/SecurityKeyBlock/);
    expect(settingEntries().map((e) => `${e.label} ${(e.keywords ?? []).join(" ")}`).join("\n")).not.toMatch(/security key|yubikey/i);
    expect(Object.keys(STR5).filter((k) => /securityKey/i.test(k))).toEqual([]);
    expect(read("shared/src/phase5.ts")).not.toMatch(/HardwareSecurityKeys/);
    expect(read("host/phase5/settings-module.ts")).not.toMatch(/HardwareSecurityKeys/);
    expect(read("host/tools/parity.ts")).not.toMatch(/HardwareSecurityKeys/);
    expect(read("host/tools/control-plane-tools.ts")).not.toMatch(/security_keys/);
  });

  it("from the docs", () => {
    expect(read("site/docs.html")).not.toMatch(/security key/i);
  });
});

describe("the Update Track select is gone", () => {
  it("from Settings → Updates and its search", async () => {
    useUpdates.setState({ state: null });
    (window as unknown as { synapse: unknown }).synapse = {
      call: async () => ({ ok: true, result: {} }), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
      native: { invoke: vi.fn(async () => ({ ok: true, result: { version: "0.2.0", auto: true, feed: "a/b", status: "none", latest: null, error: null } })), on: () => () => {} },
    };
    render(<UpdatesSection />);
    expect(await screen.findByText("Version 0.2.0")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Update Track")).toBeNull();
    expect(settingEntries().some((e) => /track/i.test(e.label))).toBe(false);
  });
});

describe("the splash has no placeholder Terms link", () => {
  it("no TERMS_URL pointing at github.com, and no Terms footer", async () => {
    expect((OnboardingModule as Record<string, unknown>).TERMS_URL).toBeUndefined();
    expect(read("app/src/renderer/onboarding/Onboarding.tsx")).not.toMatch(/termsLink|TERMS_URL/);
  });
});
