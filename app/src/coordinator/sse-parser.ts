export class SseParser {
  private buf = "";
  private data: string[] = [];

  constructor(private onData: (data: string) => void) {}

  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.data.length) this.onData(this.data.join("\n"));
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const c = line.indexOf(":");
      const field = c < 0 ? line : line.slice(0, c);
      let value = c < 0 ? "" : line.slice(c + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
    }
  }
}
