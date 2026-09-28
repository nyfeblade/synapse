// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityIcon, ToolCallEntry } from "@synapse/shared";
import { ActivityGroup } from "../../src/renderer/components/ActivityGroup";
import type { TranscriptItem } from "../../src/renderer/transcript-items";

// A PROVEN CRASH: ICON[r.icon]() is an unguarded lookup in a map keyed by a closed union, on a
// string the HOST supplies over the wire. The union is a compile-time claim about a value that
// crosses a version boundary: a host shipped after this build — the ordinary state of things for a
// few minutes after an update, and indefinitely for a user who updates one side — can send an icon
// name this build has never heard of. ICON[unknown] is undefined, undefined() throws, and before
// the root boundary existed that throw took the entire window with it.
//
// The invariant "the host only sends icons this build knows" is one nobody can enforce across two
// independently-updated processes, so the renderer stops asserting it and carries a default.

const step = (icon: string): ToolCallEntry => ({
  kind: "tool-call", id: "t1", requestId: "r1", segmentId: "s1", hidden: false, name: "Bash",
  step: "Ran the thing", icon: icon as ActivityIcon, metric: null, status: "done", startedAt: 0,
});

const item = (icon: string): Extract<TranscriptItem, { kind: "activity" }> => ({
  kind: "activity", key: "act-1", more: 0, running: false,
  rows: [{ verb: "Read", noun: "emails", count: 48, icon: icon as ActivityIcon }],
  steps: [step(icon)],
});

afterEach(cleanup);

describe("ActivityGroup — an icon name from a newer host", () => {
  it("renders the row instead of throwing (summary row)", () => {
    expect(() => render(<ActivityGroup item={item("hologram")} />)).not.toThrow();
    expect(screen.getByText(/48/).textContent).toContain("emails");
  });

  it("renders the expanded step list too", () => {
    render(<ActivityGroup item={item("hologram")} />);
    fireEvent.click(screen.getByRole("button", { name: "Show steps" }));
    expect(screen.getByText(/Ran the thing/)).toBeTruthy();
  });

  it("falls back to an icon, not to a hole in the step", () => {
    const { container } = render(<ActivityGroup item={item("hologram")} />);
    fireEvent.click(screen.getByRole("button", { name: "Show steps" }));
    expect(container.querySelector(".step svg"), "the step must still carry a glyph").not.toBeNull();
  });

  it("still uses the right icon for a name it knows", () => {
    const svgOf = (icon: string) => {
      const r = render(<ActivityGroup item={item(icon)} />);
      fireEvent.click(within(r.container).getByRole("button", { name: "Show steps" }));
      return r.container.querySelector(".step svg")!.innerHTML;
    };
    expect(svgOf("mail")).not.toBe(svgOf("hologram"));
  });

  it("the summary line is type, not a row of glyphs (the look study draws one sentence)", () => {
    const { container } = render(<ActivityGroup item={item("mail")} />);
    expect(container.querySelector(".activity-row svg"), "no icon inside the summary sentence").toBeNull();
    expect(container.querySelector(".activity-row")!.textContent).toBe("Read 48 emails");
  });
});
