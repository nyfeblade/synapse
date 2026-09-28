const MAX = 256 * 1024;

export function assertLogoUrl(url: unknown): string {
  if (typeof url !== "string" || !/^https:\/\//i.test(url)) throw new Error("Bad logo URL");
  return url;
}

export async function fetchLogoDataUrl(url: string, load: typeof fetch = fetch): Promise<string> {
  const res = await load(assertLogoUrl(url), { redirect: "follow" });
  if (!res.ok) throw new Error("Logo fetch failed");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX) throw new Error("Logo too large");
  const mime = (res.headers.get("content-type") ?? "image/png").split(";")[0]!.trim();
  if (!mime.startsWith("image/")) throw new Error("Not an image");
  return `data:${mime};base64,${buf.toString("base64")}`;
}
