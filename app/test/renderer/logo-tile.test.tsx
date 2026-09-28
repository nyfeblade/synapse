// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogoTile } from "../../src/renderer/marketplace/LogoTile";

afterEach(cleanup);

describe("LogoTile falls back to initials when a logo 404s (same class as #36)", () => {
  beforeEach(() => {
    (window as unknown as { synapse: { native: { invoke: ReturnType<typeof vi.fn> } } }).synapse = {
      native: { invoke: vi.fn(async () => ({ ok: true, result: "data:image/png;base64,xx" })) },
    };
  });

  it("renders a same-origin data URL without fetching", () => {
    const { container } = render(<LogoTile name="Linear" logo="data:image/png;base64,xx" />);
    expect((container.querySelector("img") as HTMLImageElement).src).toBe("data:image/png;base64,xx");
    expect(window.synapse.native.invoke).not.toHaveBeenCalled();
  });

  it("rewrites an https favicon through native fetch so CSP can show it", async () => {
    const { container } = render(<LogoTile name="Linear" logo="https://linear.app/static/favicon.svg" />);
    await vi.waitFor(() => expect(window.synapse.native.invoke).toHaveBeenCalledWith("fetchLogo", { url: "https://linear.app/static/favicon.svg" }));
    await vi.waitFor(() => expect((container.querySelector("img") as HTMLImageElement | null)?.src).toBe("data:image/png;base64,xx"));
  });

  it("swaps to initials when the native fetch fails", async () => {
    (window as unknown as { synapse: { native: { invoke: ReturnType<typeof vi.fn> } } }).synapse.native.invoke = vi.fn(async () => ({ ok: false, error: { code: "NATIVE_ERROR", message: "nope" } }));
    render(<LogoTile name="Linear" logo="https://linear.app/gone.png" />);
    expect(await screen.findByText("Li")).toBeTruthy();
  });

  it("swaps to initials on a later image error", () => {
    const { container } = render(<LogoTile name="Linear" logo="data:image/png;base64,xx" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Li")).toBeTruthy();
  });
});
