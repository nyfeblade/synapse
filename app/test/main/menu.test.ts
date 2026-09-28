import { describe, expect, it, vi } from "vitest";

type MenuItem = { label?: string; role?: string; submenu?: MenuItem[] };
let built: MenuItem[] | null = null;

vi.mock("electron", () => ({
  app: { isPackaged: true },
  Menu: {
    buildFromTemplate: (t: MenuItem[]) => { built = t; return t; },
    setApplicationMenu: () => {},
  },
}));

const { installAppMenu } = await import("../../src/main/native/menu");

describe("installAppMenu (fix round 1, finding 3)", () => {
  it("builds File, Edit (roles), View, Window and Help", () => {
    installAppMenu(() => {});
    expect(built).not.toBeNull();
    const labels = built!.map((i) => i.label ?? i.role);
    expect(labels).toContain("File");
    expect(labels).toContain("editMenu");
    expect(labels).toContain("View");
    expect(labels).toContain("windowMenu");
    const help = built!.find((i) => i.label === "Help" || i.role === "help");
    expect(help).toBeTruthy();
    expect(labels).not.toContain("Call"); // no Bots listed yet
  });

  it("bug 134: a Call menu listing the Bots, before Window", () => {
    installAppMenu(() => {}, { items: [{ label: "Call Nova" }, { label: "Call Ledger" }] });
    const labels = built!.map((i) => i.label ?? i.role);
    expect(labels.indexOf("Call")).toBe(labels.indexOf("windowMenu") - 1);
    expect(built!.find((i) => i.label === "Call")!.submenu!.map((i) => i.label)).toEqual(["Call Nova", "Call Ledger"]);
  });
});
