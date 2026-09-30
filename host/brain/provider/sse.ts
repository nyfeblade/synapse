/**
 * A Server-Sent Events parser (the WHATWG event-stream rules) that is indifferent to where the network cut the bytes:
 * a chunk may end inside a UTF-8 character, inside a field name, between a CR and its LF, or in the middle of an event.
 * Only complete events come out. Used for every provider stream (spec §2, §6).
 */
export interface SseEvent { event: string; data: string; id?: string }

export class SseParser {
  private decoder = new TextDecoder("utf-8");
  private buf = "";
  /** The last chunk ended on a CR: an LF at the start of the next one belongs to it. */
  private pendingCr = false;
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  private sawBom = false;

  /** Feeds bytes or text; returns the events completed by it. */
  push(chunk: Uint8Array | string): SseEvent[] {
    let text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (!this.sawBom && text.length) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.sawBom = true;
    }
    if (this.pendingCr && text.startsWith("\n")) text = text.slice(1);
    this.pendingCr = false;
    this.buf += text;
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.line(this.buf.slice(start, i), out);
      if (c === 13) {
        if (i + 1 < this.buf.length) { if (this.buf.charCodeAt(i + 1) === 10) i++; }
        else this.pendingCr = true;
      }
      start = i + 1;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** The stream ended: a trailing event with no blank line after it is dropped, as the spec says. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    const tail = this.decoder.decode();
    if (tail) out.push(...this.push(tail));
    this.buf = "";
    this.data = [];
    this.event = "";
    return out;
  }

  private line(l: string, out: SseEvent[]): void {
    if (l === "") {
      if (this.data.length) out.push({ event: this.event || "message", data: this.data.join("\n"), ...(this.id !== undefined ? { id: this.id } : {}) });
      this.data = [];
      this.event = "";
      return;
    }
    if (l.startsWith(":")) return; // a comment (keep-alive)
    const colon = l.indexOf(":");
    const field = colon === -1 ? l : l.slice(0, colon);
    let value = colon === -1 ? "" : l.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
  }
}
