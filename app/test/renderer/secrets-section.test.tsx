// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretsSection } from "../../src/renderer/components/SecretsSection";
import { relativeTime } from "../../src/renderer/relative-time";

afterEach(cleanup);

describe("Secrets section (SEC-05, ORIG-12 §12.5)", () => {
  it("lists names and descriptions only, adds, replaces and removes", async () => {
    let rows = [{ name: "STRIPE_KEY", description: "Stripe test key", updatedAt: Date.now() - 3 * 86_400_000 }];
    const api = {
      list: vi.fn(async () => rows), save: vi.fn(async () => { rows = [...rows, { name: "API_KEY", description: "Demo", updatedAt: Date.now() }]; }),
      remove: vi.fn(async () => { rows = rows.filter((r) => r.name !== "STRIPE_KEY"); }), submitRequest: vi.fn(), submitForm: vi.fn(),
    };
    (window as unknown as { synapse: unknown }).synapse = { secrets: api };
    render(<SecretsSection botId="b" />);
    expect(await screen.findByText("STRIPE_KEY")).toBeTruthy();
    expect(screen.getByText("Updated 3 days ago")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "API_KEY" } });
    fireEvent.change(screen.getByLabelText("Description (visible to your Bot)"), { target: { value: "Demo" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "value-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith("b", "API_KEY", "Demo", "value-123456"));
    expect(await screen.findByText("API_KEY")).toBeTruthy();
    expect(document.body.textContent).not.toContain("value-123456");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("b", "STRIPE_KEY"));
  });

  it("shows an error and keeps the row listed when remove rejects (no unhandled rejection)", async () => {
    const rows = [{ name: "STRIPE_KEY", description: "Stripe test key", updatedAt: Date.now() }];
    const api = {
      list: vi.fn(async () => rows), save: vi.fn(), submitRequest: vi.fn(), submitForm: vi.fn(),
      remove: vi.fn(async () => { throw new Error("remove failed"); }),
    };
    (window as unknown as { synapse: unknown }).synapse = { secrets: api };
    render(<SecretsSection botId="b" />);
    expect(await screen.findByText("STRIPE_KEY")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.getByText("remove failed")).toBeTruthy());
    expect(screen.getByText("STRIPE_KEY")).toBeTruthy();
  });

  it("shows the empty state", async () => {
    (window as unknown as { synapse: unknown }).synapse = { secrets: { list: async () => [] } };
    render(<SecretsSection botId="b" />);
    expect(await screen.findByText("No secrets yet.")).toBeTruthy();
  });

  it("formats relative times", () => {
    const now = 10 * 86_400_000;
    expect(relativeTime(now - 20_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 days ago");
  });
});

// Controller ruling (c), final integration: the "Add secret" form has a Cancel button.
describe("bug 56: a stored secret the Bot can't use", () => {
  it("says so on the secret's own row with the reason, and offers Rename and Remove instead of Replace", async () => {
    let rows = [
      { name: "GIT_TOKEN", description: "old", updatedAt: Date.now(), unusable: "Names starting with GIT_ are reserved." },
      { name: "STRIPE_KEY", description: "", updatedAt: Date.now() },
    ];
    const api = {
      list: vi.fn(async () => rows), save: vi.fn(), remove: vi.fn(), submitRequest: vi.fn(), submitForm: vi.fn(),
      rename: vi.fn(async (_b: string, from: string, to: string) => { rows = rows.map((r) => (r.name === from ? { name: to, description: r.description, updatedAt: Date.now() } : r)); }),
    };
    (window as unknown as { synapse: unknown }).synapse = { secrets: api };
    render(<SecretsSection botId="b" />);
    const row = (await screen.findByText("GIT_TOKEN")).closest(".secret-row") as HTMLElement;
    expect(row.textContent).toContain("Your Bot can't use this secret. Names starting with GIT_ are reserved.");
    const good = screen.getByText("STRIPE_KEY").closest(".secret-row") as HTMLElement;
    expect(good.textContent).not.toContain("can't use");
    // Replace would keep the refused name, so it is not offered on that row; the usable row keeps it.
    expect(screen.getAllByRole("button", { name: "Replace" })).toHaveLength(1);
    expect(good.contains(screen.getByRole("button", { name: "Replace" }))).toBe(true);
    expect(row.querySelector("button")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename GIT_TOKEN" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "github_token" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename secret" }));
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith("b", "GIT_TOKEN", "GITHUB_TOKEN"));
    await waitFor(() => expect(document.body.textContent).not.toContain("can't use"));
    expect(screen.getByText("GITHUB_TOKEN")).toBeTruthy();
  });

  it("a refused rename shows the reason and keeps the row as it was", async () => {
    const rows = [{ name: "GIT_TOKEN", description: "", updatedAt: Date.now(), unusable: "Names starting with GIT_ are reserved." }];
    const api = {
      list: vi.fn(async () => rows), save: vi.fn(), remove: vi.fn(), submitRequest: vi.fn(), submitForm: vi.fn(),
      rename: vi.fn(async () => { throw new Error("A secret named API_KEY already exists."); }),
    };
    (window as unknown as { synapse: unknown }).synapse = { secrets: api };
    render(<SecretsSection botId="b" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename GIT_TOKEN" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "API_KEY" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename secret" }));
    expect(await screen.findByText("A secret named API_KEY already exists.")).toBeTruthy();
    expect(screen.getByText("GIT_TOKEN")).toBeTruthy();
  });
});

describe("Add secret form Cancel (ruling c)", () => {
  it("closes the form, discards what was typed and saves nothing", async () => {
    const api = { list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(), submitRequest: vi.fn(), submitForm: vi.fn() };
    (window as unknown as { synapse: unknown }).synapse = { secrets: api };
    render(<SecretsSection botId="b" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add secret" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "API_KEY" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "value-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("button", { name: "Add secret" })).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("");
  });
});

describe("bug 57: secrets on the box whose values this Mac doesn't have", () => {
  it("says how many, offers Keep them on the computer, and each row offers Re-enter and Remove from computer", async () => {
    let rows: { name: string; description: string; updatedAt: number; boxOnly?: true; kept?: true }[] = [
      { name: "STRIPE_KEY", description: "", updatedAt: Date.now(), boxOnly: true },
      { name: "GH_PAT", description: "", updatedAt: Date.now(), boxOnly: true },
    ];
    const api = {
      list: vi.fn(async () => rows), save: vi.fn(async () => {}), remove: vi.fn(async () => {}), submitRequest: vi.fn(), submitForm: vi.fn(),
      keepOnBox: vi.fn(async () => { rows = rows.map((r) => ({ ...r, kept: true as const })); }),
    };
    (window as unknown as { synapse: unknown }).synapse = { secrets: api };
    render(<SecretsSection botId="b" />);
    expect(await screen.findByText(/This Mac doesn't have the values for 2 secrets this Bot uses/)).toBeTruthy();
    const row = screen.getByText("STRIPE_KEY").closest(".secret-row") as HTMLElement;
    expect(row.textContent).toContain("On the computer only. This Mac doesn't have its value.");
    expect(screen.getAllByRole("button", { name: "Re-enter" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Re-enter" })[0]!);
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "value-reentered" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace value" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith("b", "STRIPE_KEY", "", "value-reentered"));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove from computer" })[1]!);
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("b", "GH_PAT"));
    fireEvent.click(screen.getByRole("button", { name: "Keep them on the computer" }));
    await waitFor(() => expect(api.keepOnBox).toHaveBeenCalledWith("b", ["STRIPE_KEY", "GH_PAT"]));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByText("STRIPE_KEY")).toBeTruthy();
  });
});
