// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR, historyKeepLabel } from "@synapse/shared";
import { AdvancedSection } from "../../src/renderer/components/AdvancedSection";
import { AdvancedSettingsCard } from "../../src/renderer/components/AdvancedSettingsCard";
import { useUi } from "../../src/renderer/store";
import { installFakeBridge, settingsFixture } from "./fake-bridge";

describe("Advanced controls (D14)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => { bridge = installFakeBridge({ getAgentContext: { ctxTokens: 84_000, window: 200_000, ratio: 0.42, compactionEpoch: 3, compactions: 3, sessionBytes: 1 } }); });
  afterEach(cleanup);

  it("hides the Bot section while Advanced is off", () => {
    useUi.setState({ settings: { ...settingsFixture(), advancedEnabled: false } } as never);
    const { container } = render(<AdvancedSection botId="b" />);
    expect(container.textContent).toBe("");
  });

  it("shows the meter, Compact now, New session and a disabled Show memory files", async () => {
    useUi.setState({ settings: { ...settingsFixture(), advancedEnabled: true } } as never);
    render(<AdvancedSection botId="b" />);
    expect(await screen.findByText(STR.contextMeter(42, "84k", "200k"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR.compactNow }));
    expect(bridge.calls.at(-1)).toEqual(["compactAgentNow", { id: "b" }]);
    fireEvent.click(screen.getByRole("button", { name: STR.newSession }));
    expect(bridge.calls.at(-1)).toEqual(["newAgentSession", { id: "b" }]);
    expect((screen.getByRole("button", { name: STR.showMemoryFiles }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: STR.compactNow }).closest(".settings-row")?.classList.contains("stack")).toBe(true);
  });

  it("Keep more history: offers each choice with its token cost and saves it (token diet 2)", async () => {
    useUi.setState({ settings: { ...settingsFixture(), advancedEnabled: true }, bots: { b: { id: "b", settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false } } } } as never);
    render(<AdvancedSection botId="b" />);
    const select = screen.getByRole("combobox", { name: STR.keepMoreHistory }) as HTMLSelectElement;
    expect(select.value).toBe("standard");
    expect([...select.options].map((o) => o.textContent)).toEqual([historyKeepLabel("standard"), historyKeepLabel("more"), historyKeepLabel("full")]);
    // UI polish pass (critique 5.1): titles and labels only — the explanatory second line is gone.
    expect(screen.queryByText(STR.keepMoreHistoryHint)).toBeNull();
    fireEvent.change(select, { target: { value: "more" } });
    expect(bridge.calls.at(-1)).toEqual(["setAgentHistoryKeep", { id: "b", keep: "more" }]);
  });

  it("Task 34 fuzz: a failed Compact now / New session shows the action error instead of an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => { unhandled.push(e.reason); e.preventDefault(); };
    window.addEventListener("unhandledrejection", onUnhandled);
    // The FUZZ host this branch ships has no Phase 2 context commands wired (see task-34-report.md).
    (window as unknown as { synapse: { call: unknown } }).synapse.call = async (cmd: string) => (cmd === "compactAgentNow" || cmd === "newAgentSession"
      ? { ok: false, error: { code: "UNKNOWN_COMMAND", message: `Unknown command ${cmd}` } }
      : { ok: true, result: null });
    useUi.setState({ settings: { ...settingsFixture(), advancedEnabled: true }, actionError: null } as never);
    render(<AdvancedSection botId="b" />);
    fireEvent.click(screen.getByRole("button", { name: STR.compactNow }));
    await vi.waitFor(() => expect(useUi.getState().actionError).toBe("Unknown command compactAgentNow"));
    fireEvent.click(screen.getByRole("button", { name: STR.newSession }));
    await vi.waitFor(() => expect(useUi.getState().actionError).toBe("Unknown command newAgentSession"));
    await new Promise((r) => setTimeout(r, 20));
    window.removeEventListener("unhandledrejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("the settings card toggles Advanced and the recall switch", () => {
    useUi.setState({ settings: { ...settingsFixture(), advancedEnabled: true, memoryRecall: true } } as never);
    render(<AdvancedSettingsCard />);
    fireEvent.click(screen.getByRole("switch", { name: STR.perTurnRecall }));
    expect(bridge.calls.at(-1)).toEqual(["setHostSettings", { memoryRecall: false }]);
    fireEvent.click(screen.getByRole("switch", { name: STR.showAdvanced }));
    expect(bridge.calls.at(-1)).toEqual(["setHostSettings", { advancedEnabled: false }]);
  });
});
