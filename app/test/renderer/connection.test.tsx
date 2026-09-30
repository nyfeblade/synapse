// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectionScreen } from "../../src/renderer/components/ConnectionScreen";

describe("ConnectionScreen (CMP-13)", () => {
  it("shows Starting, Reconnecting and Couldn't Reach with Retry", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ConnectionScreen state={{ kind: "starting" }} onRetry={onRetry} />);
    expect(screen.getByText("Starting your computer")).toBeTruthy();
    rerender(<ConnectionScreen state={{ kind: "reconnecting", attempt: 2 }} onRetry={onRetry} />);
    expect(screen.getByText("Reconnecting")).toBeTruthy();
    rerender(<ConnectionScreen state={{ kind: "unreachable", error: "The host did not answer." }} onRetry={onRetry} />);
    expect(screen.getByText("Couldn't reach Bots' computer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
