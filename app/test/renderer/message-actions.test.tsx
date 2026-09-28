// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, type SendMessageEntry, type UserMessageEntry } from "@synapse/shared";
import { MessageActions } from "../../src/renderer/components/MessageActions";
import { Reactions } from "../../src/renderer/components/Reactions";
import { ReplyChip } from "../../src/renderer/components/ReplyChip";
import { ReplyHeader } from "../../src/renderer/components/ReplyHeader";
import { useComposer } from "../../src/renderer/composer-store";
import { useUi } from "../../src/renderer/store";
import { installFakeBridge } from "./fake-bridge";

const bot: SendMessageEntry = { kind: "send-message", id: "t1s1", requestId: "req_1", createdAt: 1, message: { type: "text", content: "Booked the 9:10." }, reactions: [{ emoji: "🎉", by: "user" }] };
const user: UserMessageEntry = { kind: "message", id: "t2u", role: "user", content: "and the hotel?", createdAt: 2, replyToId: "t1s1" };

describe("message actions (CHAT-11, CHAT-12, CHAT-13)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  afterEach(cleanup);
  beforeEach(() => {
    bridge = installFakeBridge();
    useComposer.setState({ byBot: {} });
    useUi.setState({ transcripts: { b: [bot, user] } } as never);
  });

  it("reacts from the hover bar and toggles an existing reaction", () => {
    render(<MessageActions botId="b" entry={bot} text="Booked the 9:10." />);
    fireEvent.click(screen.getByRole("button", { name: STR.react }));
    fireEvent.click(screen.getByRole("button", { name: "React 👍" }));
    expect(bridge.calls.at(-1)).toEqual(["reactToMessage", { id: "b", entryId: "t1s1", emoji: "👍" }]);
    render(<Reactions botId="b" entry={bot} />);
    fireEvent.click(screen.getByRole("button", { name: "🎉 1, you reacted" }));
    expect(bridge.calls.at(-1)).toEqual(["reactToMessage", { id: "b", entryId: "t1s1", emoji: "🎉" }]);
  });

  it("Reply sets the composer's reply target and the chip shows and clears it", () => {
    render(<MessageActions botId="b" entry={bot} text="Booked the 9:10." />);
    fireEvent.click(screen.getByRole("button", { name: STR.reply }));
    expect(useComposer.getState().byBot.b!.replyToId).toBe("t1s1");
    render(<ReplyChip botId="b" />);
    expect(screen.getByText(`${STR.replyingTo}:`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(useComposer.getState().byBot.b!.replyToId).toBeNull();
  });

  it("More: Copy text and Copy request ID", async () => {
    const copied: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: async (t: string) => void copied.push(t) } });
    render(<MessageActions botId="b" entry={bot} text="Booked the 9:10." />);
    fireEvent.click(screen.getByRole("button", { name: STR.moreMessageActions }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.copyText }));
    fireEvent.click(screen.getByRole("button", { name: STR.moreMessageActions }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.copyRequestId }));
    await Promise.resolve();
    expect(copied).toEqual(["Booked the 9:10.", "req_1"]);
  });

  it("the reply header quotes the target and jumps to it", () => {
    const jumps: string[] = [];
    useUi.setState({ jumpTo: async (_b: string, id: string) => void jumps.push(id) } as never);
    render(<ReplyHeader botId="b" replyToId="t1s1" />);
    fireEvent.click(screen.getByRole("button", { name: /↪ reply.*Booked the 9:10\./ }));
    expect(jumps).toEqual(["t1s1"]);
  });
});
