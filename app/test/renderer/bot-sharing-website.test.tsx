// @vitest-environment jsdom
// Bot sharing, phase 4: "Export for website" is the owner's advanced action. It shows only with developer tools
// on (or SYNAPSE_OWNER=1), opens the same Share sheet with a blurb, and writes an entry the site build accepts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeShare, type SharePreview } from "@synapse/shared";
// @ts-expect-error plain ESM build script, no types
import { loadCatalogue } from "../../../site/build.mjs";
import { ChatHeaderActions } from "../../src/renderer/components/ChatHeaderActions";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { ShareSheet } from "../../src/renderer/templates/ShareSheet";
import { websiteEntry } from "../../src/renderer/templates/WebsiteEntry";
import { useTemplates } from "../../src/renderer/templates/store";

const payload = { v: 1, name: "Scout", title: "Research", instructions: "Research and cite sources.", shape: "gem", color: "#777777", tools: [{ catalogId: "curated:deepwiki", name: "DeepWiki" }], skills: [] };
let owner = false;
let fragment = "";
const saved: { defaultName: string; bytesBase64: string }[] = [];
beforeEach(async () => {
  owner = false;
  saved.length = 0;
  fragment = await encodeShare(payload);
  const share = (): SharePreview => ({ name: "Scout", title: "Research", instructions: payload.instructions, face: { shape: "gem", color: "#777777" }, skills: [], tools: [{ catalogId: "curated:deepwiki", name: "DeepWiki", included: true }], fragment, length: fragment.length, hidden: "", sameAsLastShare: false, selection: { skills: [], tools: ["curated:deepwiki"] } });
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (c: string) => ({ ok: true, result: c === "sharePayload" ? share() : c === "getTemplate" ? { template: null } : {} })),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: { defaultName: string; bytesBase64: string }) => { if (n === "saveFile") saved.push(a); return { ok: true, result: n === "ownerTools.get" ? { on: owner } : n === "saveFile" ? { path: `/tmp/${a.defaultName}` } : {} }; }), on: () => () => {} },
  };
  useUi.setState({ ...initialState(), bots: { b1: { id: "b1", profile: { name: "Scout" } } } } as never);
  useTemplates.setState({ sheet: null, importReady: true });
});
afterEach(cleanup);

describe("Export for website", () => {
  it("is in the Bot menu only with the owner's developer tools on", async () => {
    render(<ChatHeaderActions botId="b1" />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Share Bot…" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("menuitem", { name: "Export for website" })).toBeNull();
    cleanup();
    owner = true;
    render(<ChatHeaderActions botId="b1" />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export for website" }));
    expect(useTemplates.getState().sheet).toEqual({ kind: "share", botId: "b1", website: true });
  });

  it("asks for a blurb and writes <slug>.json that the site build accepts", async () => {
    useTemplates.getState().openShare("b1", true);
    render(<ShareSheet />);
    const sheet = await screen.findByRole("dialog", { name: "Scout" });
    const save = within(sheet).getByRole("button", { name: "Save entry" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Blurb" }), { target: { value: "Researches anything and cites sources." } });
    fireEvent.click(save);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.defaultName).toBe("scout.json");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "website-entry-"));
    fs.writeFileSync(path.join(dir, "scout.json"), Buffer.from(saved[0]!.bytesBase64, "base64"));
    const { entries, warnings } = loadCatalogue(dir);
    expect(warnings).toEqual([]);
    expect(entries[0].payload.name).toBe("Scout");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "scout.json"), "utf8"))).not.toHaveProperty("author");
  });

  it("websiteEntry refuses a damaged link", async () => {
    await expect(websiteEntry("b1.@@", "x")).rejects.toThrow("This link is damaged.");
  });
});
