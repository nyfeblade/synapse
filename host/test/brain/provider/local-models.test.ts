import { afterEach, describe, expect, it } from "vitest";
import { LocalModelLists, parseLocalModels } from "../../../brain/provider/local-models";
import { startFakeChatServer, type FakeReply, type FakeRequest } from "./fake-chat-server";
import { startProviderRuntime } from "./runtime";

/** Fakes only: no local model server is ever started or asked to load anything (the owner's rule). */
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });
async function withLocal(script: (r: FakeRequest) => FakeReply) {
  const up = await startFakeChatServer(script);
  closers.push(() => up.close());
  const rt = await startProviderRuntime({ upstream: `${up.url}/v1`, key: null });
  closers.push(rt.stop);
  return up;
}

describe("local model lists for the picker", () => {
  it("parses Ollama's /api/tags and LM Studio's /v1/models (chat models only)", () => {
    expect(parseLocalModels("ollama", JSON.stringify({ models: [{ name: "qwen3:4b" }, { name: "llama3.2:3b" }, { name: "bad name!" }] }))).toEqual(["qwen3:4b", "llama3.2:3b"]);
    expect(parseLocalModels("lmstudio", JSON.stringify({ data: [{ id: "qwen2.5-7b-instruct", type: "llm" }, { id: "nomic-embed", type: "embeddings" }, { id: "gemma-3" }] }))).toEqual(["qwen2.5-7b-instruct", "gemma-3"]);
    expect(parseLocalModels("ollama", "not json")).toEqual([]);
  });

  it("asks Ollama's /api/tags through the proxy (never a chat or load call), once per 30 s", async () => {
    const up = await withLocal((r) => (r.path === "/api/tags" ? { status: 200, body: JSON.stringify({ models: [{ name: "qwen3:4b" }] }) } : { status: 500, body: "{}" }));
    let t = 1_000;
    const lists = new LocalModelLists({ now: () => t });
    expect(await lists.list("ollama")).toEqual(["qwen3:4b"]);
    expect(await lists.list("ollama")).toEqual(["qwen3:4b"]);
    expect(up.requests.map((r) => [r.path, r.headers.authorization ?? null])).toEqual([["/api/tags", null]]);
    t += 31_000;
    await lists.list("ollama");
    expect(up.requests).toHaveLength(2);
    expect(up.requests.every((r) => r.path === "/api/tags")).toBe(true);
    expect(await lists.list("openai")).toEqual([]); // only local providers
  });

  it("LM Studio: /v1/models; a server that doesn't answer in time lists nothing, quickly", async () => {
    const up = await withLocal((r) => (r.path === "/v1/models" ? { hang: true } : { status: 404, body: "{}" }));
    const t0 = Date.now();
    expect(await new LocalModelLists().list("lmstudio")).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(up.requests.map((r) => r.path)).toEqual(["/v1/models"]);
  });
});
