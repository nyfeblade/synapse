import { STR_AUTH, type AuthTestResult, type AuthView } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import { openSealed, type BoxKeyPair } from "../secrets/crypto";
import type { AuthStore } from "./auth-store";
import { testAnthropicConnection } from "./test-connection";

/**
 * Settings → Account and the setup screen: the Anthropic API key (save, test, remove). The Mac seals a key to the box public key (like every Bot secret)
 * before it leaves the main process; the answers carry the masked key only.
 */
export function createAuthCommands(o: {
  store: AuthStore;
  keyPair(): Promise<BoxKeyPair>;
  /** Tests: a local fake Messages API. */
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): CommandHandlers {
  const view = async (): Promise<AuthView> => ({
    apiKey: o.store.masked(), boxPublicKey: (await o.keyPair()).publicKey,
  });
  const unseal = async (sealed: unknown): Promise<string> => {
    if (typeof sealed !== "string" || !sealed) throw new GatewayError("BAD_ARGS", STR_AUTH.badKeyFormat);
    try {
      return await openSealed(sealed, await o.keyPair());
    } catch {
      throw new GatewayError("BAD_SEALED", "The key couldn't be opened on the computer. Enter it again.");
    }
  };
  return {
    getAuth: () => view(),
    setApiKey: async ({ sealed }) => {
      o.store.setApiKey(await unseal(sealed));
      return view();
    },
    clearApiKey: async () => {
      // With no key, Bots don't run (AuthMissingError) until a new one is saved; nothing falls back.
      o.store.clearApiKey();
      return view();
    },
    testAuthConnection: async ({ sealed }): Promise<AuthTestResult> => {
      const key = sealed ? await unseal(sealed) : o.store.apiKey();
      if (!key) {
        const c = { kind: "no-key" as const, title: STR_AUTH.noKeyTitle, detail: STR_AUTH.noKey };
        return { ok: false, reached: false, status: null, ...c };
      }
      return testAnthropicConnection(key, { ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}), ...(o.fetchFn ? { fetchFn: o.fetchFn } : {}) });
    },
  };
}

