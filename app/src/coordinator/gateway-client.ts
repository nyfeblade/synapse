import {
  GatewayCallError,
  LIMITS,
  type CommandName,
  type GatewayCommands,
  type GatewayResponse,
  type HealthInfo,
  type SseEvent,
} from "@synapse/shared";
import { SseParser } from "./sse-parser";

export type ConnectionState =
  | { kind: "starting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "unreachable"; error: string };

export { GatewayCallError };

export interface GatewayClientOptions {
  baseUrl: string;
  token: string;
  onEvent(e: SseEvent): void;
  onState(s: ConnectionState): void;
  fetchImpl?: typeof fetch;
  retryMs?: number;
  unreachableAfter?: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GatewayClient {
  private ac: AbortController | null = null;
  private stopped = true;
  private attempt = 0;
  private generation = 0;

  constructor(private o: GatewayClientOptions) {}

  private get f(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.o.token}`, ...extra };
  }

  async call<K extends CommandName>(cmd: K, args: GatewayCommands[K]["args"]): Promise<GatewayCommands[K]["result"]> {
    const res = await this.f(`${this.o.baseUrl}/api/${cmd}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(args ?? {}),
    });
    const body = (await res.json()) as GatewayResponse<GatewayCommands[K]["result"]>;
    if (!body.ok) throw new GatewayCallError(body.error.code, body.error.message);
    return body.result;
  }

  async health(): Promise<HealthInfo> {
    const res = await this.f(`${this.o.baseUrl}/health`, { headers: this.headers(), signal: AbortSignal.timeout(LIMITS.healthTimeoutMs) });
    if (!res.ok) throw new Error(`health returned ${res.status}`);
    return (await res.json()) as HealthInfo;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const gen = ++this.generation;
    void this.loop(gen);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.ac?.abort();
  }

  private async loop(gen: number): Promise<void> {
    while (!this.stopped && gen === this.generation) {
      this.ac = new AbortController();
      try {
        const res = await this.f(`${this.o.baseUrl}/events`, { headers: this.headers({ accept: "text/event-stream" }), signal: this.ac.signal });
        if (gen !== this.generation) return;
        if (!res.ok || !res.body) throw new Error(`events returned ${res.status}`);
        this.attempt = 0;
        this.o.onState({ kind: "connected" });
        const parser = new SseParser((data) => {
          try {
            this.o.onEvent(JSON.parse(data) as SseEvent);
          } catch {
            /* ignore malformed frames */
          }
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (gen !== this.generation) return;
          if (done) break;
          parser.feed(dec.decode(value, { stream: true }));
        }
      } catch {
        /* network error or abort: fall through to the retry logic */
      }
      if (this.stopped || gen !== this.generation) return;
      this.attempt += 1;
      this.o.onState(
        this.attempt >= (this.o.unreachableAfter ?? 6)
          ? { kind: "unreachable", error: "The host did not answer." }
          : { kind: "reconnecting", attempt: this.attempt },
      );
      await wait(this.o.retryMs ?? 2000);
      if (gen !== this.generation) return;
    }
  }
}
