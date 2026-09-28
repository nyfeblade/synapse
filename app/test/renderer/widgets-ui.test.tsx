// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, type SendMessageEntry } from "@synapse/shared";
import { CardView } from "../../src/renderer/components/Cards";
import { WidgetCard } from "../../src/renderer/components/WidgetCard";
import { installFakeBridge } from "./fake-bridge";

const widget = (over: Partial<SendMessageEntry> = {}): SendMessageEntry => ({
  kind: "send-message", id: "t1s1", requestId: "r", createdAt: 1, status: "pending",
  message: { type: "widget", widget: { question: "Which flight?", options: [{ label: "7 AM", value: "am" }, { label: "6 PM", value: "pm", style: "primary" }], allowCustom: true } },
  ...over,
});

describe("WidgetCard (CHAT-16/17)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => { bridge = installFakeBridge(); });
  afterEach(cleanup);

  it("answers with an option value", () => {
    render(<WidgetCard botId="b" entry={widget()} />);
    fireEvent.click(screen.getByRole("button", { name: "6 PM" }));
    expect(bridge.calls.at(-1)).toEqual(["respondToWidget", { id: "b", entryId: "t1s1", value: "pm" }]);
  });

  it("sends a custom answer when allowCustom", () => {
    render(<WidgetCard botId="b" entry={widget()} />);
    fireEvent.click(screen.getByRole("button", { name: STR.other }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "noon" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Your answer" }), { key: "Enter" });
    expect(bridge.calls.at(-1)).toEqual(["respondToWidget", { id: "b", entryId: "t1s1", value: "noon" }]);
  });

  it("shows the settled answer and disables the options (task-6-brief.md: disabled, not hidden)", () => {
    const { container } = render(<WidgetCard botId="b" entry={widget({ status: "answered", respondedValue: "6 PM" })} />);
    expect(container.querySelector(".card-settled")?.textContent).toBe(`${STR.answered}: 6 PM`);
    expect(screen.getByRole("button", { name: "7 AM" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("CardView", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => { bridge = installFakeBridge(); });
  afterEach(cleanup);

  it("email draft: Send email and Discard return as answers", () => {
    const e: SendMessageEntry = { kind: "send-message", id: "t2s1", requestId: "r", createdAt: 1, status: "pending", message: { type: "card", card: { kind: "email-draft", from: "me@x.dev", to: ["dana@x.dev"], subject: "Q3 deck", body: "Hi Dana" } } };
    render(<CardView botId="b" entry={e} />);
    expect(screen.getByText(`${STR.newEmail} · ${STR.readyToSend}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: STR.sendEmail }));
    expect(bridge.calls.at(-1)).toEqual(["respondToWidget", { id: "b", entryId: "t2s1", value: "send" }]);
  });

  it("form: submits field values", () => {
    const e: SendMessageEntry = { kind: "send-message", id: "t3s1", requestId: "r", createdAt: 1, status: "pending", message: { type: "card", card: { kind: "form", title: "Trip", fields: [{ name: "city", label: "City", kind: "text", required: true }] } } };
    render(<CardView botId="b" entry={e} />);
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Denver" } });
    fireEvent.click(screen.getByRole("button", { name: STR.submit }));
    expect(bridge.calls.at(-1)).toEqual(["respondToWidget", { id: "b", entryId: "t3s1", value: "submit", formValues: { city: "Denver" } }]);
  });

  it("table renders headers and cells", () => {
    const e: SendMessageEntry = { kind: "send-message", id: "t4s1", requestId: "r", createdAt: 1, message: { type: "card", card: { kind: "table", title: "Flights", columns: ["When", "Price"], rows: [["7 AM", "$210"]] } } };
    render(<CardView botId="b" entry={e} />);
    expect(screen.getByRole("columnheader", { name: "Price" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "$210" })).toBeTruthy();
  });
});
