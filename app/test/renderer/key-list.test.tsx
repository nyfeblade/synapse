// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeysView, KeyView } from "@synapse/shared";
import { KeyList } from "../../src/renderer/components/settings/KeyList";

/** Settings → Account (0.1.7): a provider's keys — Add key, Rename, Test, Make default, Remove, a monthly cap. */
const KEY = "sk-proj-NEWKEYabcdefghij0123456789";
const k = (id: string, label: string, isDefault: boolean, extra: Partial<KeyView> = {}): KeyView =>
  ({ id, label, masked: `sk-…${id.slice(-4).padStart(4, "0")}`, savedAt: 1, isDefault, health: null, monthUsd: 0, monthRuns: 0, capUsd: null, ...extra });
let keys: KeysView;
const calls: [string, unknown][] = [];
let addKey: ReturnType<typeof vi.fn>;
const openai = () => keys.rings.find((r) => r.provider === "openai")!;
const setOpenai = (ks: KeyView[]) => { keys = { ...keys, rings: keys.rings.map((r) => (r.provider === "openai" ? { ...r, keys: ks } : r)) }; };

beforeEach(() => {
  calls.length = 0;
  keys = { boxPublicKey: "pk", rings: [
    { provider: "anthropic", label: "Anthropic", keys: [] },
    { provider: "openai", label: "OpenAI", keys: [k("k1", "Personal", true, { monthUsd: 1.2, monthRuns: 14 }), k("kwork", "Work", false, { health: "rejected" })] },
  ] };
  addKey = vi.fn(async (_p: string, _v: string, label: string) => { setOpenai([...openai().keys, k("knew", label, false)]); return keys; });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string, a: { keyId?: string; label?: string; capUsd?: number | null }) => {
      calls.push([c, a]);
      if (c === "renameKey") setOpenai(openai().keys.map((x) => (x.id === a.keyId ? { ...x, label: a.label! } : x)));
      if (c === "setDefaultKey") setOpenai(openai().keys.map((x) => ({ ...x, isDefault: x.id === a.keyId })));
      if (c === "removeKey") setOpenai(openai().keys.filter((x) => x.id !== a.keyId));
      if (c === "setKeyCap") setOpenai(openai().keys.map((x) => (x.id === a.keyId ? { ...x, capUsd: a.capUsd ?? null } : x)));
      if (c === "testKey") return { ok: true, result: { ok: true, kind: "ok", title: "Key works", detail: "" } };
      return { ok: true, result: keys };
    }),
    providers: { saveKey: vi.fn(), testKey: vi.fn(), addKey },
    onEvent: () => () => {}, onConnection: () => () => {},
  };
});
afterEach(cleanup);

const row = (label: string) => screen.getByLabelText(label, { selector: ".key-row" });
const menuItem = async (keyLabel: string, item: string) => {
  fireEvent.click(within(row(keyLabel)).getByRole("button", { name: `${keyLabel}: more` }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
};

describe("Settings → Account: several keys per provider", () => {
  it("lists each key with its label, mask, Default, this month's spend and a quiet problem word", async () => {
    render(<KeyList provider="openai" />);
    const personal = await screen.findByLabelText("Personal", { selector: ".key-row" });
    expect(personal.textContent).toContain("Default");
    expect(personal.textContent).toContain("sk-…00k1");
    expect(personal.textContent).toContain("$1.20 · 14 runs");
    expect(row("Work").textContent).toContain("Rejected");
    expect(row("Work").textContent).not.toContain("Default");
  });

  it("adds a key with a label through the sealed IPC path, never the plain gateway call", async () => {
    render(<KeyList provider="openai" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add key" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Side project" } });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByLabelText("Side project", { selector: ".key-row" })).toBeTruthy());
    expect(addKey).toHaveBeenCalledWith("openai", KEY, "Side project");
    expect(calls.some(([, a]) => JSON.stringify(a).includes(KEY))).toBe(false);
  });

  it("renames, makes default, sets a cap, tests and removes from the row", async () => {
    render(<KeyList provider="openai" />);
    await screen.findByLabelText("Work", { selector: ".key-row" });
    await menuItem("Work", "Rename");
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Office" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByLabelText("Office", { selector: ".key-row" })).toBeTruthy());
    await menuItem("Office", "Make default");
    await waitFor(() => expect(row("Office").textContent).toContain("Default"));
    expect(calls).toContainEqual(["setDefaultKey", { provider: "openai", keyId: "kwork" }]);
    await menuItem("Office", "Monthly cap");
    fireEvent.change(screen.getByLabelText("Monthly cap"), { target: { value: "$25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(row("Office").textContent).toContain("/ $25"));
    fireEvent.click(within(row("Personal")).getByRole("button", { name: "Test" }));
    expect(await within(row("Personal")).findByText("Key works")).toBeTruthy();
    expect(calls).toContainEqual(["testKey", { provider: "openai", keyId: "k1" }]);
    await menuItem("Personal", "Remove");
    await waitFor(() => expect(screen.queryByLabelText("Personal", { selector: ".key-row" })).toBeNull());
    expect(calls).toContainEqual(["removeKey", { provider: "openai", keyId: "k1" }]);
  });

  it("a provider with no key says so and offers Add key", async () => {
    render(<KeyList provider="anthropic" />);
    expect(await screen.findByText("No key")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add key" })).toBeTruthy();
  });
});
