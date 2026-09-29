import {
  GatewayCallError,
  LIMITS,
  STR,
  WRONG_HOST_CODE,
  WRONG_HOST_MESSAGE,
  type CommandName,
  type GatewayCommands,
  type GatewayResponse,
  type HealthInfo,
  type SseEvent,
} from "@synapse/shared";
import { SseParser } from "./sse-parser";
import { checkHost } from "../main/host-hello";

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
  /** Opt-in: a command that hasn't answered by then fails (TIMEOUT). None by default: a restore or an import may take long. */
  callTimeoutMs?: number;
  /** The host answers /hello (gateway.json): prove it before the token is sent anywhere (main/host-hello.ts). */
  hello?: boolean;
  /** The host refused this token (a 401 or a failed proof). Called once: main checks whether the token went stale. */
  onRefused?(): void;
}

/** A call made while there is no connection: why, when the connection failed (another account's host), else "not yet". */
export function notConnectedMessage(state: ConnectionState): string {
  return state.kind === "unreachable" && state.error ? state.error : STR.hostNotConnected;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GatewayClient {
  private ac: AbortController | null = null;
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  /** The event stream is up on a proven host: calls go straight through (a restarted host drops the stream first). */
  private live = false;
  private refusedOnce = false;

  constructor(private o: GatewayClientOptions) {}

  /**
   * Two accounts on one Mac (or a local user who bound the port while the host was down): the first refusal asks main
   * whether the token went stale (a recreated machine) and shows "reconnecting"; after that it's another account's.
   */
  private refused(): void {
    if (!this.refusedOnce) {
      this.refusedOnce = true;
      this.o.onRefused?.();
      this.o.onState({ kind: "reconnecting", attempt: Math.max(1, this.attempt) });
      return;
    }
    this.o.onState({ kind: "unreachable", error: WRONG_HOST_MESSAGE });
  }

  /** For other token-bearing requests (the VNC proxy): true when the host is proven for this connection. */
  async provenForUse(): Promise<boolean> {
    return (await this.proven()) === "ours";
  }

  /** With `hello`, proves the host before the token is sent (unless the stream is already up on a proven host). */
  private async proven(): Promise<"ours" | "refused" | "no-answer"> {
    if (!this.o.hello || this.live) return "ours";
    return checkHost({ baseUrl: this.o.baseUrl, token: this.o.token, hello: true, fetchImpl: this.o.fetchImpl });
  }

  private get f(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.o.token}`, ...extra };
  }

  async call<K extends CommandName>(cmd: K, args: GatewayCommands[K]["args"]): Promise<GatewayCommands[K]["result"]> {
    const timeoutMs = this.o.callTimeoutMs;
    const v = await this.proven();
    if (v === "no-answer") throw new GatewayCallError("NETWORK", STR.hostNoAnswer);
    if (v === "refused") { if (!this.refusedOnce) this.refused(); throw new GatewayCallError(WRONG_HOST_CODE, WRONG_HOST_MESSAGE); }
    let res: Response;
    try {
      res = await this.f(`${this.o.baseUrl}/api/${cmd}`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(args ?? {}),
        ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (e) {
      const n = (e as { name?: string }).name;
      if (n === "TimeoutError" || n === "AbortError") throw new GatewayCallError("TIMEOUT", STR.hostTimeout);
      throw new GatewayCallError("NETWORK", STR.hostNoAnswer);
    }
    // Two accounts on one Mac: a host that refuses this app's token is another account's, on a shared port.
    if (res.status === 401) { if (!this.refusedOnce) this.refused(); throw new GatewayCallError(WRONG_HOST_CODE, WRONG_HOST_MESSAGE); }
    const body = (await res.json().catch(() => null)) as GatewayResponse<GatewayCommands[K]["result"]> | null;
    if (!body || typeof body !== "object" || typeof body.ok !== "boolean") throw new GatewayCallError("NETWORK", STR.hostBadAnswer(res.status));
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
        const v = await this.proven();
        if (gen !== this.generation) return;
        if (v === "refused") { this.refused(); await wait(this.o.retryMs ?? 2000); continue; }
        if (v === "no-answer") throw new Error("no answer");
        const res = await this.f(`${this.o.baseUrl}/events`, { headers: this.headers({ accept: "text/event-stream" }), signal: this.ac.signal });
        if (gen !== this.generation) return;
        if (res.status === 401) {
          // Another account's host on a shared port (or a token that went stale): say so, never "connected".
          this.refused();
          await wait(this.o.retryMs ?? 2000);
          continue;
        }
        if (!res.ok || !res.body) throw new Error(`events returned ${res.status}`);
        this.attempt = 0;
        this.live = true;
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
      this.live = false;
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
