import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMcpModule, createMcpServices } from "../../mcp/module";
import { McpRegistry } from "../../mcp/registry";
import { subkey, vaultKeySync } from "../../secrets/crypto";
import { HostSettingsStore } from "../../store/host-settings";

/**
 * THE CLASS — "a credential the user hands an MCP server, reaching disk, a log or the renderer in
 * clear text."
 *
 * remote-header-vault.test.ts and command-env-vault.test.ts drive the two credential-bearing fields
 * we know about (`headers`, `env`) through the whole host and search for the literal bytes. This
 * file guards the MECHANISM that produces the next one.
 *
 * The mechanism is simply this: `McpRegistry.add()` copies its argument onto a `RegistryServer`, and
 * `save()` writes that object to servers.json verbatim, while `view()` copies from it onto an
 * `McpServerView` that is published to the renderer and handed to Bot tools. So EVERY field on
 * `AddMcpServerArgs` and `RegistryServer` is on a path to a 0600 JSON file and to the UI. A field
 * that holds a credential and is not sealed leaks by default, silently, and the person adding it
 * gets a green suite.
 *
 * THE RULE: every field on those two interfaces is declared here, exactly once, as either
 * CREDENTIAL (and then it must survive the canary sweep below — the value is unreadable on disk,
 * absent from the published view, absent from the logs) or NOT_A_CREDENTIAL with a reason. Neither
 * list is an allowlist for leaking: NOT_A_CREDENTIAL says "this field cannot carry a secret, and
 * here is why", and the reason has to answer "what would a user ever put here?".
 *
 * Deliberately NOT guarded here: fields on unrelated types, and the sealing mechanism itself (the
 * two vault tests own that). This file only forces the decision to be made out loud.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

import { interfaceFields } from "../guard-parse";
export { interfaceFields };

const ARGS_SRC = fs.readFileSync(path.join(repoRoot, "shared", "src", "phase5.ts"), "utf8");
const REG_SRC = fs.readFileSync(path.join(repoRoot, "host", "mcp", "registry.ts"), "utf8");
const FIELDS = new Set([...interfaceFields(ARGS_SRC, "AddMcpServerArgs"), ...interfaceFields(REG_SRC, "RegistryServer")]);

/**
 * Fields whose VALUES are the user's credentials. Each one is swept below: the literal value must be
 * unreadable in every file the host wrote, absent from the published server list, absent from stderr.
 */
const CREDENTIAL: Record<string, string> = {
  env: "a local command server's environment — the place an API key for a stdio MCP server goes (`API_KEY=sk-live-…`). Sealed in command-env.sealed.json; servers.json keeps only envNames.",
  headers: "a remote server's request headers — the place a bearer token or an `x-…-api-key` goes, which is the whole of the user's access to that endpoint. Sealed in remote-headers.sealed.json; servers.json keeps only headerNames.",
};

/** Fields that cannot carry a credential. The reason has to say what a user would put there. */
const NOT_A_CREDENTIAL: Record<string, string> = {
  name: "the display name the user typed (\"Composio\"); it is shown back to them in the server list and in Bot-facing tool text, so it is public by construction.",
  id: "the slug derived from name + label, used as the SDK server name in `mcp__<id>__<tool>`; it is in every tool name a Bot sees.",
  label: "the PLG-09 account label (\"work\", \"personal\") that disambiguates two accounts on one connector; it is rendered in the UI title.",
  kind: "\"remote\" or \"command\" — which of the two transports this server uses.",
  url: "the endpoint, which is also the OAuth `serverUrl` and is shown in errors. It is https-only (registry.ts), and a credential must not be put in it: that is exactly what the headers field is for.",
  transport: "\"http\" or \"sse\" — which HTTP flavour the connector settled on.",
  command: "the program a local server runs (\"npx\"); it is reviewed by the user before it is allowed to run, so it must be visible.",
  args: "the program's argv. Credentials are explicitly excluded here (connect.ts: \"never in argv\") — a key belongs in env, whose values are sealed and reach only that process.",
  envNames: "the NAMES of the env a command server needs (\"API_KEY\"), kept on disk so the UI can say which keys are set without holding any of them.",
  headerNames: "the NAMES of the headers a remote server sends (\"x-consumer-api-key\"). Header names are not secret — the server advertises them in access-control-allow-headers — and keeping them unsealed is what lets the UI say a key is set without reading it.",
  catalogId: "the marketplace/curated entry this server came from (\"curated:linear\"), used to match a catalog tile to an installed server.",
  source: "\"curated\" | \"marketplace\" | \"custom\" — where the server came from, which drives the read-only-tool policy (mcpReadOnly).",
  ownerPrivateReach: "bug 363: true only when the owner added the server in the app, so it may reach the Mac or the LAN without the guarded fetch; a flag, not anything secret.",
  enabled: "the user's on/off switch for the whole server; it decides whether the server is connected at all and is rendered as a toggle, so it is a boolean the user set and can see.",
  createdAt: "the millisecond the server was added, used to order the list and to date the entry; it is a clock reading, not anything the user supplied.",
};

const HEADER = "x-consumer-api-key";
const CANARY: Record<keyof typeof CREDENTIAL & string, { add: Record<string, unknown>; value: string }> = {
  env: { add: { name: "Files", command: "npx", args: ["files-mcp"], env: { API_KEY: "canary-env-8Hj2k-do-not-persist" } }, value: "canary-env-8Hj2k-do-not-persist" },
  headers: { add: { name: "Remote", url: "https://remote.example/mcp", headers: { [HEADER]: "canary-hdr-4Bn7q-do-not-persist" } }, value: "canary-hdr-4Bn7q-do-not-persist" },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

describe("a credential an MCP server carries must be a decision, not an accident", () => {
  it("finds the interfaces to check at all (the guard's own smoke test)", () => {
    // A zero from a source scan is a claim about the pattern, not about the code. If either parse
    // breaks, every assertion below passes vacuously and the guard silently stops guarding.
    expect(interfaceFields(ARGS_SRC, "AddMcpServerArgs")).toContain("url");
    expect(interfaceFields(REG_SRC, "RegistryServer")).toContain("createdAt");
    expect(FIELDS.size, "too few fields parsed — the interfaces moved and this guard is now blind").toBeGreaterThan(10);
  });

  it("every field on AddMcpServerArgs and RegistryServer is declared, exactly once", () => {
    const undeclared = [...FIELDS].filter((f) => !CREDENTIAL[f] && !NOT_A_CREDENTIAL[f]);
    expect(
      undeclared,
      `A new field on an MCP server config reaches servers.json (McpRegistry.save) and the renderer (McpRegistry.view) by default.\nDeclare each one: CREDENTIAL if a user would ever put a key there — and then seal it, the way headers and env are — or NOT_A_CREDENTIAL with a reason saying what a user would put there instead:\n  ${undeclared.join("\n  ")}`,
    ).toEqual([]);
    expect([...FIELDS].filter((f) => CREDENTIAL[f] && NOT_A_CREDENTIAL[f])).toEqual([]);
  });

  it("holds no stale entries — a field that no longer exists is deleted, not kept", () => {
    expect([...Object.keys(CREDENTIAL), ...Object.keys(NOT_A_CREDENTIAL)].filter((f) => !FIELDS.has(f))).toEqual([]);
  });

  it("every reason is a sentence, not a shrug (self-test on the lists themselves)", () => {
    for (const [f, why] of Object.entries({ ...CREDENTIAL, ...NOT_A_CREDENTIAL })) expect(why.length, `${f}'s reason is too thin`).toBeGreaterThan(60);
  });

  it("every CREDENTIAL field is swept: the value is on no disk, in no publish, in no log line", async () => {
    for (const [field, { add, value }] of Object.entries(CANARY)) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpcanary-"));
      const published: unknown[] = [];
      const stderr: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((c: string | Uint8Array) => { stderr.push(String(c)); return true; }) as typeof process.stderr.write;
      try {
        const ctx = {
          cfg: { hostPrivate: dir, workspace: dir }, hub: { publish: (e: unknown) => published.push(e) },
          settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1, flags: () => ({ connectorToolDisable: "disallowedTools" }),
        } as never;
        const svc = createMcpServices(ctx, { connect: async () => { throw new Error("offline"); }, connectCommand: async () => { throw new Error("offline"); } });
        const m = createMcpModule(ctx, svc);
        const { server } = await m.handlers.addMcpServer!(add as never);
        const list = await m.handlers.listMcpServers!({});

        const files = walk(dir);
        expect(files.length, `${field}: the host wrote no files — this sweep proves nothing`).toBeGreaterThan(1);
        expect(files.map((f) => fs.readFileSync(f, "latin1")).join("\n"), `${field}: the value is readable in a file the host wrote`).not.toContain(value);
        expect(JSON.stringify(server), `${field}: the value is in the view handed to the renderer`).not.toContain(value);
        expect(JSON.stringify(list), `${field}: the value is in the published server list`).not.toContain(value);
        expect(JSON.stringify(published), `${field}: the value is in an SSE publish`).not.toContain(value);
        expect(stderr.join(""), `${field}: the value is in a log line`).not.toContain(value);
      } finally {
        process.stderr.write = write;
      }
    }
  });

  it("the sweep would actually catch a leak (self-test on the sweep, must fail on plaintext)", () => {
    // The sweep is a substring search over files. If the canary were ever stored plaintext, this is
    // the shape of the failure it must produce — pinned so a future refactor of the search can't
    // quietly turn it into a search over nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpcanary-self-"));
    fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify({ headers: { [HEADER]: CANARY.headers!.value } }));
    expect(walk(dir).map((f) => fs.readFileSync(f, "latin1")).join("\n")).toContain(CANARY.headers!.value);
  });

  it("the registry seals headers even when the value arrives from a plugin marketplace, not the form", () => {
    // plugin-marketplaces.ts and the Bot-facing AddMcpServer tool both call registry.add() with
    // free-form headers. Sealing at add() — rather than at the form — is what makes those paths safe
    // without either of them knowing about credentials.
    const hp = fs.mkdtempSync(path.join(os.tmpdir(), "mcpcanary-mkt-"));
    const reg = new McpRegistry({
      dir: path.join(hp, "mcp"), settings: new HostSettingsStore(path.join(hp, "s.json")), now: () => 1,
      headerKey: subkey(vaultKeySync(hp), "bots/mcp-headers/v1"),
    });
    reg.add({ name: "Mkt", url: "https://mkt.example/mcp", headers: { Authorization: "Bearer canary-mkt-2Zx9-do-not-persist" } }, "marketplace", "mkt:a/b");
    expect(walk(hp).map((f) => fs.readFileSync(f, "latin1")).join("\n")).not.toContain("canary-mkt-2Zx9-do-not-persist");
    expect(reg.headersFor("mkt")).toEqual({ Authorization: "Bearer canary-mkt-2Zx9-do-not-persist" });
  });
});
