// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STR_TELEGRAM } from "@synapse/shared";
import { TelegramSection, type TelegramStatusView } from "../../src/renderer/components/settings/TelegramSection";
import { settingEntries } from "../../src/renderer/components/settings/search-index";

/** Wave 4.1: Settings → System → Telegram. Off by default; token, switch, pair by code, unpair. Labels only. */
afterEach(cleanup);

function mount(state: Partial<TelegramStatusView>) {
  let s: TelegramStatusView = { enabled: false, polling: false, hasToken: false, botUsername: null, owner: null, pairing: null, error: null, ...state };
  const invoke = vi.fn(async (name: string) => {
    if (name === "telegram.setToken") s = { ...s, hasToken: true, botUsername: "my_bot" };
    if (name === "telegram.enable") s = { ...s, enabled: true, polling: true };
    if (name === "telegram.pair.start") s = { ...s, pairing: { code: "ABCD2345", link: "https://t.me/my_bot?start=ABCD2345", expiresAt: Date.now() + 60_000 } };
    if (name === "telegram.unpair") s = { ...s, owner: null };
    return { ok: true, result: s };
  });
  (window as unknown as { synapse: unknown }).synapse = { native: { invoke, on: () => () => {} } };
  return invoke;
}

describe("Settings → System → Telegram", () => {
  it("is off by default and can't be turned on without a token; save, turn on, pair", async () => {
    const invoke = mount({});
    render(<TelegramSection />);
    const sw = await screen.findByRole("switch", { name: STR_TELEGRAM.access });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByLabelText(STR_TELEGRAM.token) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "123:abc" } });
    fireEvent.click(screen.getByRole("button", { name: STR_TELEGRAM.save }));
    await waitFor(() => expect(screen.getByText("@my_bot")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("telegram.setToken", { token: "123:abc" });
    fireEvent.click(screen.getByRole("switch", { name: STR_TELEGRAM.access }));
    await waitFor(() => expect(screen.getByRole("switch", { name: STR_TELEGRAM.access }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: STR_TELEGRAM.pair }));
    await waitFor(() => expect(screen.getByTestId("telegram-code").textContent).toBe("ABCD2345"));
    expect(screen.getByRole("button", { name: STR_TELEGRAM.openTelegram })).toBeTruthy();
  });

  it("shows who it's paired with, and unpairs", async () => {
    const invoke = mount({ enabled: true, polling: true, hasToken: true, botUsername: "my_bot", owner: { name: "Sam", pairedAt: 1 } });
    render(<TelegramSection />);
    expect(await screen.findByText(`${STR_TELEGRAM.pairedWith} Sam`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR_TELEGRAM.unpair }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("telegram.unpair", {}));
  });

  it("names an error in a few words", async () => {
    mount({ enabled: true, hasToken: true, botUsername: "my_bot", error: "token-rejected" });
    render(<TelegramSection />);
    expect((await screen.findByRole("alert")).textContent).toBe(STR_TELEGRAM.errors["token-rejected"]);
  });

  it("is findable in Settings search", () => {
    expect(settingEntries().some((e) => e.section === "system" && e.label === STR_TELEGRAM.access && e.keywords?.includes("telegram"))).toBe(true);
  });
});
