import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { LIMITS5, type TemplateRecord } from "@synapse/shared";
import { z } from "zod";
import { GatewayError } from "../gateway/errors";

export interface BotpackContents { template: TemplateRecord; skills: Record<string, Record<string, Uint8Array>>; memoriesMd: string; avatar: { name: string; bytes: Uint8Array } | null }

const SAFE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const TemplateSchema = z.object({
  // I9: the template id is a UUID (it names a folder under agent-data/templates).
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i), name: z.string().min(1).max(80),
  author: z.object({ name: z.string().max(80), avatarUrl: z.string().optional() }).optional(),
  sourceBotId: z.string().nullable(), visibility: z.literal("local"), createdAt: z.number(), updatedAt: z.number(),
  manifest: z.object({
    profile: z.object({ name: z.string().min(1).max(80), title: z.string().max(80), description: z.string().max(20_000), avatarShape: z.string(), avatarColor: z.string(), model: z.string().optional() }),
    skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).max(100),
    memories: z.array(z.string().max(500)).max(500),
    routines: z.array(z.object({ name: z.string().max(80), prompt: z.string().max(20_000), schedule: z.string().nullable() })).max(50),
    plugins: z.array(z.object({ catalogId: z.string(), name: z.string() })).max(100),
  }),
});

export function writeBotpack(c: BotpackContents): Uint8Array {
  const files: Zippable = { "template.json": strToU8(JSON.stringify(c.template, null, 2)), "memories.md": strToU8(c.memoriesMd) };
  for (const [id, parts] of Object.entries(c.skills)) for (const [rel, bytes] of Object.entries(parts)) files[`skills/${id}/${rel}`] = bytes;
  if (c.avatar) files[`avatar.${c.avatar.name.split(".").pop()}`] = c.avatar.bytes;
  return zipSync(files, { level: 6 });
}

export function readBotpack(bytes: Uint8Array): BotpackContents {
  if (bytes.byteLength > LIMITS5.templateMaxBytes) throw new GatewayError("BAD_TEMPLATE", "This template file is too large.");
  let files: Record<string, Uint8Array>;
  // P5 review minor: a total cap on the UNZIPPED size (each file under the cap can still add up to a zip bomb).
  let total = 0;
  let tooBig = false;
  try {
    files = unzipSync(bytes, { filter: (f) => {
      total += f.originalSize;
      if (f.originalSize > LIMITS5.templateMaxBytes || total > LIMITS5.templateMaxBytes) { tooBig = true; return false; }
      return true;
    } });
  } catch {
    throw new GatewayError("BAD_TEMPLATE", "This file isn't a Bot template (.botpack).");
  }
  if (tooBig) throw new GatewayError("BAD_TEMPLATE", "This template file is too large.");
  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  if (names.length > 500 || names.some((n) => n.split("/").some((seg) => seg === "." || seg === "..") || !SAFE.test(n))) throw new GatewayError("BAD_TEMPLATE", "This template contains unsafe file names.");
  if (!files["template.json"]) throw new GatewayError("BAD_TEMPLATE", "This file isn't a Bot template (.botpack).");
  let json: unknown;
  try { json = JSON.parse(strFromU8(files["template.json"]!)); } catch { throw new GatewayError("BAD_TEMPLATE", "This template's details are damaged."); }
  const parsed = TemplateSchema.safeParse(json);
  if (!parsed.success) throw new GatewayError("BAD_TEMPLATE", "This template's details are damaged.");
  const skills: BotpackContents["skills"] = {};
  for (const n of names) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(n);
    if (m && m[2]!.endsWith(".md")) (skills[m[1]!] ??= {})[m[2]!] = files[n]!;
  }
  const avatarName = names.find((n) => /^avatar\.(png|jpe?g|webp|gif|svg)$/.test(n));
  return { template: parsed.data as TemplateRecord, skills, memoriesMd: files["memories.md"] ? strFromU8(files["memories.md"]) : "", avatar: avatarName ? { name: avatarName, bytes: files[avatarName]! } : null };
}
