// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRC, type BoxHelpView, type FormCardView, type SecretRequestView } from "@synapse/shared";
import { buildTranscriptItems } from "../../src/renderer/transcript-items";
import { useComputer } from "../../src/renderer/computer-state";
import { useUi } from "../../src/renderer/store";
import { AttentionBanner } from "../../src/renderer/components/AttentionBanner";
import { BoxHelpCard } from "../../src/renderer/components/BoxHelpCard";
import { FormCard } from "../../src/renderer/components/FormCard";
import { SecretCard } from "../../src/renderer/components/SecretCard";

const req = (o: Partial<BoxHelpView> = {}): BoxHelpView => ({ id: "bh_1", botId: "b", instruction: "Sign in to Northwind Air so I can see your saved trips and hold the refundable fare.", reason: "auth", domain: null, idpDomain: null, screenshotDataUrl: "data:image/webp;base64,AAAA", status: "pending", inControl: false, createdAt: 1, settledAt: null, ...o });
const calls: { cmd: string; args: unknown }[] = [];
const submit = vi.fn(async () => "saved");
const submitForm = vi.fn(async () => "submitted");

afterEach(cleanup);

beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: async (cmd: string, args: unknown) => { calls.push({ cmd, args }); return { ok: true, result: { request: req() } }; },
    secrets: { submitRequest: submit, submitForm }, vncUrl: () => null,
  };
});

describe("transcript items", () => {
  it("maps box-help, secret-request and form entries to their cards", () => {
    const items = buildTranscriptItems([
      { kind: "send-message", id: "t1s1", requestId: "r", createdAt: 1, message: { type: "box-help", request: req() } },
      { kind: "send-message", id: "t1s2", requestId: "r", createdAt: 1, message: { type: "secret-request", secret: { label: "Key", description: "", destination: "env", field: "K", connector: null, url: null, target: null, status: "pending" } } },
      { kind: "send-message", id: "t1s3", requestId: "r", createdAt: 1, message: { type: "card", card: { kind: "form", title: "Address", url: null, fields: [], status: "pending", answeredFields: [] } } },
    ], 1);
    expect(items.filter((i) => i.kind !== "separator").map((i) => i.kind)).toEqual(["box-help", "secret", "form"]);
  });
});

describe("Computer card (C2–C4, CMP-08)", () => {
  it("shows the badge, instruction, screenshot and the three buttons; Take over starts control and opens the view", async () => {
    render(<BoxHelpCard botId="b" request={req()} />);
    const card = screen.getByRole("region", { name: "Computer" });
    expect(card.textContent).toContain("Action needed");
    expect(screen.getByRole("img", { name: "Screenshot of the Bot's screen" }).getAttribute("src")).toBe("data:image/webp;base64,AAAA");
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(calls[0]).toEqual({ cmd: "setTakeoverActive", args: { id: "b", requestId: "bh_1", active: true } }));
    expect(useComputer.getState().open).toEqual({ botId: "b" });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    // Opening the view also asks for a screen (ensureDisplay), so find the hand-back by command
    // rather than by position: exactly one, carrying "skip", sent after Take over.
    await waitFor(() => expect(calls.filter((c) => c.cmd === "handBackForeverBox")).toEqual([{ cmd: "handBackForeverBox", args: { id: "b", requestId: "bh_1", outcome: "skip" } }]));
    expect(calls.findIndex((c) => c.cmd === "handBackForeverBox")).toBeGreaterThan(0);
  });

  it("shows the orange pill while the user is in control and the outcome once settled", () => {
    const { rerender } = render(<BoxHelpCard botId="b" request={req({ inControl: true })} />);
    expect(screen.getByText("You're in control")).toBeTruthy();
    rerender(<BoxHelpCard botId="b" request={req({ status: "handed_back", settledAt: 2 })} />);
    expect(screen.getByText("Handed back")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("the attention banner offers Skip this step and I'm done, continue", async () => {
    useUi.setState({ transcripts: { b: [{ kind: "send-message", id: "t1s1", requestId: "r", createdAt: 1, message: { type: "box-help", request: req() } }] } as never });
    render(<AttentionBanner botId="b" />);
    expect(screen.getByText("Needs your attention")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I'm done, continue" }));
    await waitFor(() => expect(calls[0]).toMatchObject({ cmd: "handBackForeverBox", args: { outcome: "done" } }));
  });
});

describe("secret card (SEC-02)", () => {
  const secret: SecretRequestView = { label: "Stripe test key", description: "For the demo app", destination: "env", field: "STRIPE_KEY", connector: null, url: null, target: null, status: "pending" };

  it("takes a masked value, warns under 8 chars, rejects under 4, and sends it through the Mac vault (never the gateway)", async () => {
    render(<SecretCard botId="b" entryId="t1s2" secret={secret} />);
    const input = screen.getByPlaceholderText("Paste your Stripe test key") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "abc" } });
    expect((screen.getByRole("button", { name: "Save securely" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "abcdef" } });
    expect(screen.getByText("Short values can't be reliably hidden from your Bot's output.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "sk_test_123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save securely" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("b", "t1s2", "sk_test_123456", { destination: "env", field: "STRIPE_KEY", label: "Stripe test key" }));
    expect(calls).toEqual([]);
    expect(screen.getByText("Kept encrypted; your Bot never sees it")).toBeTruthy();
  });

  it("renders the settled states from the entry", () => {
    const { rerender } = render(<SecretCard botId="b" entryId="e" secret={{ ...secret, status: "saved" }} />);
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("Saved securely and kept private")).toBeTruthy();
    rerender(<SecretCard botId="b" entryId="e" secret={{ ...secret, destination: "page", status: "filled" }} />);
    expect(screen.getByText("Entered on the page. Your Bot never saw the secret values.")).toBeTruthy();
    rerender(<SecretCard botId="b" entryId="e" secret={{ ...secret, destination: "page", status: "fill_failed" }} />);
    expect(screen.getByText("Couldn't enter it on the page")).toBeTruthy();
  });

  it("shows the spec error when saving fails and keeps the card open", async () => {
    submit.mockResolvedValueOnce("failed");
    render(<SecretCard botId="b" entryId="t1s2" secret={secret} />);
    fireEvent.change(screen.getByPlaceholderText("Paste your Stripe test key"), { target: { value: "sk_test_123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save securely" }));
    await waitFor(() => expect(screen.getByText("Couldn't save the secret. Please try again.")).toBeTruthy());
  });
});

describe("form card (SEC-04)", () => {
  it("sends plain answers and secret answers separately", async () => {
    const card: FormCardView = { kind: "form", title: "Checkout address", url: null, status: "pending", answeredFields: [], fields: [
      { name: "street", label: "Street", type: "text", secret: false, required: true, fillTarget: null },
      { name: "card", label: "Card number", type: "password", secret: true, required: true, fillTarget: { ref: "e9" } },
    ] };
    render(<FormCard botId="b" entryId="t1s3" card={card} />);
    fireEvent.change(screen.getByLabelText("Street"), { target: { value: "1 Main St" } });
    fireEvent.change(screen.getByLabelText("Card number"), { target: { value: "4242424242424242" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(submitForm).toHaveBeenCalledWith("b", "t1s3", { street: "1 Main St" }, { card: "4242424242424242" }));
  });

  it("shows an error and re-enables Submit when submitForm rejects (no unhandled rejection)", async () => {
    submitForm.mockRejectedValueOnce(new Error("network down"));
    const card: FormCardView = { kind: "form", title: "Checkout address", url: null, status: "pending", answeredFields: [], fields: [
      { name: "street", label: "Street", type: "text", secret: false, required: true, fillTarget: null },
    ] };
    render(<FormCard botId="b" entryId="t1s3" card={card} />);
    fireEvent.change(screen.getByLabelText("Street"), { target: { value: "1 Main St" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByText(STRC.formNotSubmitted)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
