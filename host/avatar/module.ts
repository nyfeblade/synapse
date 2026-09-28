import fs from "node:fs";
import path from "node:path";
import { LIMITS5, STR5 } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import type { HostModule, ModuleContext } from "../phase5/types";
import type { AvatarGenerator } from "./generate";
import { sanitizeSvg } from "./svg-sanitize";

const EXT: Record<string, "png" | "jpg" | "webp" | "gif" | "svg"> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

export function createAvatarModule(ctx: Pick<ModuleContext, "cfg" | "bots">, gen: AvatarGenerator, recordHelper?: (botId: string) => void): HostModule {
  const dir = (id: string) => path.join(ctx.cfg.dataRoot, "agents", id);
  const clearFiles = (id: string) => { for (const f of fs.readdirSync(dir(id))) if (/^avatar\./.test(f)) fs.rmSync(path.join(dir(id), f)); };
  return {
    name: "avatar",
    handlers: {
      generateAgentAvatar: async (a) => {
        const prompt = String(a.prompt ?? "").trim().slice(0, LIMITS5.avatarPromptMax);
        if (!prompt) throw new GatewayError("BAD_ARGS", "Describe the avatar first.");
        const svg = sanitizeSvg(await gen.generate(a.id, prompt, ctx.bots.summary(a.id).profile.avatarColor));
        recordHelper?.(a.id);
        return { svg };
      },
      setAgentAvatarBytes: (a) => {
        ctx.bots.require(a.id);
        const ext = EXT[a.mime];
        if (!ext) throw new GatewayError("BAD_ARGS", STR5.avatarBadType);
        let bytes = Buffer.from(a.bytesBase64, "base64");
        if (bytes.length > LIMITS5.avatarMaxBytes) throw new GatewayError("TOO_LARGE", STR5.avatarTooLarge);
        if (ext === "svg") bytes = Buffer.from(sanitizeSvg(bytes.toString("utf8")));
        clearFiles(a.id);
        fs.writeFileSync(path.join(dir(a.id), `avatar.${ext}`), bytes, { mode: 0o640 });
        return { agent: ctx.bots.setAvatarImage(a.id, ext) };
      },
      getAgentAvatar: (a) => {
        ctx.bots.require(a.id);
        const f = fs.readdirSync(dir(a.id)).find((n) => /^avatar\.(png|jpg|webp|gif|svg)$/.test(n));
        return f ? { mime: MIME[f.split(".")[1]!]!, bytesBase64: fs.readFileSync(path.join(dir(a.id), f)).toString("base64") } : { mime: null, bytesBase64: null };
      },
      clearAgentAvatar: (a) => {
        ctx.bots.require(a.id);
        clearFiles(a.id);
        return { agent: ctx.bots.setAvatarImage(a.id, null) };
      },
    },
  };
}
