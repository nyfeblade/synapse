import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { ImapFlowClient, ImapIdleWatcher } from "../../triggers/email/imap-idle";
import type { MailMessage } from "../../triggers/email/query";

// Start the fixture first:
// docker run -d --name greenmail -p 3025:3025 -p 3143:3143 \
//   -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=bot:secret@localhost -Dgreenmail.users.login=email' \
//   greenmail/standalone:2.1.3
const run = process.env.RUN_IMAP === "1" ? describe : describe.skip;

function smtpSend(subject: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.connect(3025, "127.0.0.1");
    const lines = ["HELO test", "MAIL FROM:<boss@acme.com>", "RCPT TO:<bot@localhost>", "DATA",
      `From: Boss <boss@acme.com>\r\nTo: bot@localhost\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@acme.com>\r\n\r\nHello ${subject}\r\n.`, "QUIT"];
    let i = 0;
    s.on("data", (b) => { if (/^[45]/m.test(b.toString())) reject(new Error(b.toString())); if (i < lines.length) s.write(`${lines[i++]}\r\n`); });
    s.on("close", () => resolve());
    s.on("error", reject);
  });
}

run("IMAP IDLE against GreenMail", () => {
  it("receives 20 new messages, then survives a dropped socket", async () => {
    const got: MailMessage[] = [];
    let current: ImapFlowClient | null = null;
    const w = new ImapIdleWatcher({
      client: () => (current = new ImapFlowClient({ label: "gm", host: "127.0.0.1", port: 3143, user: "bot@localhost", appPassword: "secret" }, "INBOX")),
      folder: "INBOX", onMessage: (m) => got.push(m), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    });
    w.start();
    await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < 20; i++) await smtpSend(`m${i}`);
    await vi.waitFor(() => expect(got).toHaveLength(20), { timeout: 20_000, interval: 250 });
    expect(got[0]!.subject).toBe("m0");
    await current!.close();
    await new Promise((r) => setTimeout(r, 6000));
    await smtpSend("after-drop");
    await vi.waitFor(() => expect(got.map((m) => m.subject)).toContain("after-drop"), { timeout: 20_000, interval: 250 });
    await w.stop();
  }, 60_000);
});
