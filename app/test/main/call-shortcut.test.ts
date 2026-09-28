import { describe, expect, it, vi } from "vitest";
import { installNativeIpc } from "../../src/main/native";
import { DEFAULT_CALL_SHORTCUT, callMenuItems, registerCallShortcut, validCallShortcut } from "../../src/main/native/call-shortcut";

// Bug 134 (item 9): call from anywhere — a configurable global shortcut and the menu bar's Call menu.

function setup(o: { saved?: string | null; taken?: string[] } = {}) {
  const handlers = new Map<string, (e: unknown, m: unknown) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>>();
  installNativeIpc({ handle: (ch: string, fn: never) => void handlers.set(ch, fn) } as never, () => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as never);
  const registered = new Map<string, () => void>();
  const shortcuts = {
    register: vi.fn((a: string, fn: () => void) => { if (o.taken?.includes(a)) return false; registered.set(a, fn); return true; }),
    unregister: vi.fn((a: string) => { registered.delete(a); }),
  };
  const writes: (string | null)[] = [];
  const onFire = vi.fn();
  registerCallShortcut({ shortcuts, read: () => ("saved" in o ? o.saved : undefined), write: (a) => writes.push(a), onFire });
  const dispatch = (name: string, args: unknown) => handlers.get("native")!({}, { name, args });
  return { registered, shortcuts, writes, onFire, dispatch };
}

describe("the call shortcut", () => {
  it("⌥⌘C by default; pressing it calls the current Bot", () => {
    const h = setup();
    expect(DEFAULT_CALL_SHORTCUT).toBe("Alt+CommandOrControl+C");
    expect([...h.registered.keys()]).toEqual([DEFAULT_CALL_SHORTCUT]);
    h.registered.get(DEFAULT_CALL_SHORTCUT)!();
    expect(h.onFire).toHaveBeenCalledTimes(1);
  });

  it("configurable: a new one replaces it, null turns it off, junk and taken ones are refused (the old one stays)", async () => {
    const h = setup({ taken: ["Control+Shift+X"] });
    expect((await h.dispatch("calls.shortcut.set", { accelerator: "Control+Alt+K" })).result).toEqual({ accelerator: "Control+Alt+K" });
    expect([...h.registered.keys()]).toEqual(["Control+Alt+K"]);
    const bad = await h.dispatch("calls.shortcut.set", { accelerator: "K" });
    expect(bad.ok).toBe(false);
    const taken = await h.dispatch("calls.shortcut.set", { accelerator: "Control+Shift+X" });
    expect(taken.ok).toBe(false);
    expect(taken.error!.message).toMatch(/already used/);
    expect([...h.registered.keys()]).toEqual(["Control+Alt+K"]);
    await h.dispatch("calls.shortcut.set", { accelerator: null });
    expect(h.registered.size).toBe(0);
    expect(h.writes).toEqual(["Control+Alt+K", null]);
  });

  it("a saved 'off' stays off", () => {
    expect(setup({ saved: null }).registered.size).toBe(0);
  });

  it("validation: modifiers + one key; Shift alone is not enough", () => {
    for (const ok of ["Alt+CommandOrControl+C", "Command+Shift+9", "Control+Option+Space", "Cmd+F5"]) expect(validCallShortcut(ok), ok).toBe(true);
    for (const bad of ["C", "Shift+C", "Alt+Alt+C", "Alt+Command", "Command+CC", "Hyper+C", 42, "Command+C+V"]) expect(validCallShortcut(bad), String(bad)).toBe(false);
  });
});

describe("the menu bar's Call menu", () => {
  it("one 'Call <Bot>' item per Bot (at most 20); none yet = a disabled line", () => {
    const onCall = vi.fn();
    const items = callMenuItems([{ id: "nova", name: "Nova" }, { id: "ledger", name: "Ledger" }], onCall);
    expect(items.map((i) => i.label)).toEqual(["Call Nova", "Call Ledger"]);
    items[1]!.click!();
    expect(onCall).toHaveBeenCalledWith("ledger");
    expect(callMenuItems([], onCall)).toEqual([{ label: "No Bots yet", enabled: false }]);
    expect(callMenuItems(Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, name: `B${i}` })), onCall)).toHaveLength(20);
  });
});
