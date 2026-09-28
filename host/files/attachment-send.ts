import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostConfig } from "../config";
import { GatewayError } from "../gateway/errors";
import { toolError, type BotToolExtensions } from "../tools/registry";
import { pdfPages, resolveReadable } from "./file-access";
import { mimeOf } from "./mime";

export function createAttachmentSendExtension(d: { cfg: HostConfig }): BotToolExtensions {
  return {
    sendTypes: {
      attachment: ({ args, deliver }) => {
        const url = String(args.url ?? "").trim();
        const caption = typeof args.content === "string" && args.content.trim() ? args.content.trim() : null;
        if (/^https:\/\//i.test(url)) {
          const name = String(args.alt ?? "") || decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
          deliver({ type: "attachment", url, name, size: null, mime: mimeOf(name), pages: null, caption }, {}, `📎 ${name}`);
          return { text: `Sent ${name}.` };
        }
        if (!url.startsWith("file://")) return toolError("url must be a file:// path under /workspace or an https URL.");
        try {
          const f = resolveReadable(d.cfg, fileURLToPath(url));
          const name = path.basename(f.real);
          deliver({ type: "attachment", url: `file://${f.real}`, name, size: f.size, mime: f.mime, pages: pdfPages(f.real), caption }, {}, `📎 ${name}`);
          return { text: `Sent ${name}.` };
        } catch (e) {
          return toolError(e instanceof GatewayError ? e.message : String(e));
        }
      },
    },
  };
}
