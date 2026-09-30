// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { UpdatesSection } from "../../src/renderer/components/settings/UpdatesSection";
import { UsageSection } from "../../src/renderer/components/settings/UsageSection";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { useUpdates } from "../../src/renderer/updates/store";
import { useUsage } from "../../src/renderer/usage/store";
import { installBridge, settings, usageView } from "./settings-fixtures";

const upd = { version: "0.2.0", track: "stable", auto: false, feed: "alex/bots", status: "none", latest: null, error: null } as Record<string, unknown>;
beforeEach(() => {
  const h = installBridge();
  (window as unknown as { synapse: { native: unknown } }).synapse.native = { invoke: vi.fn(async () => ({ ok: true, result: upd })), on: () => () => {} };
  void h;
  useUi.setState({ ...initialState(), settings: settings({ advancedEnabled: false }) });
  useUsage.setState({ view: usageView, error: null });
  useUpdates.setState({ state: null });
});
afterEach(cleanup);

describe("new-user walk finding 8: internal plumbing waits behind Show advanced controls", () => {
  it("Account: no anti-ack gate efficiency tiles", () => {
    render(<UsageSection />);
    expect(document.body.textContent).not.toMatch(/anti-ack|Efficiency this week|ping-pong/);
  });

  it("Account with advanced controls: the tiles come back, as labels without subtitles", () => {
    useUi.setState({ settings: settings({ advancedEnabled: true }) });
    render(<UsageSection />);
    expect(screen.getByText(STR5.efficiencyThisWeek)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/anti-ack gate/);
  });

  it("System: no release folder, GitHub repo or token field", async () => {
    render(<UpdatesSection />);
    await screen.findByText("Version 0.2.0");
    expect(document.body.textContent).not.toMatch(/Release source|Release folder|Updates from GitHub/);
    expect(document.querySelector('input[placeholder^="github_pat"]')).toBeNull();
  });

  it("Voice: the Qwen line names no install script", () => {
    expect(STR5.qwenNotInstalled).not.toMatch(/install\.sh|app\/native/);
  });

  it("Bot settings: Engineering mode shows no token count and no engine memory sizes", async () => {
    const { installFakeBridge, botFixture } = await import("./fake-bridge");
    installFakeBridge({});
    useUi.setState({ bots: { a: botFixture("a", "Scout") }, settings: settings({ advancedEnabled: false }) } as never);
    const { BotSettingsPanel } = await import("../../src/renderer/components/BotSettingsPanel");
    render(<BotSettingsPanel botId="a" />);
    expect(document.body.textContent).not.toContain(STR5.engineeringModeCost);
    expect(document.body.textContent).not.toContain(STR5.voiceMemory);
  });
});
