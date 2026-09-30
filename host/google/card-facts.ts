import { isGoogleId } from "@synapse/shared";
import type { GoogleApi } from "./api";
import { parseRecipients } from "./recipients";

/**
 * Final secfix item 9: what an approval card must show for a Google write, fetched host-side with the user's token
 * before the card is raised — the real reply recipient (Reply-To, else From), the event's title and time, the upload
 * folder's name and sharing state. `resolvedTo` is pinned onto the approved call so the send goes exactly there.
 */
export interface GoogleCardFacts { lines: string[]; summary?: string; resolvedTo?: string[]; attendees?: string[] }

interface Header { name: string; value: string }
interface Meta { payload?: { headers?: Header[] } }
interface Event { attendees?: { email?: string }[]; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }
interface DriveItem { name?: string; shared?: boolean }

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const hdr = (m: Meta, n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
const when = (w?: { dateTime?: string; date?: string }) => w?.dateTime ?? w?.date ?? "?";
const hasTo = (to: unknown) => (Array.isArray(to) ? to.some((x) => s(x).trim()) : s(to).trim() !== "");

/** Whether a Google write needs host-side facts on its card. */
export function needsCardFacts(tool: string, a: Record<string, unknown>): boolean {
  if (tool === "gmail_send" || tool === "gmail_draft") return !a.draft_id && !!a.reply_to_id && !hasTo(a.to);
  return tool === "calendar_update" || tool === "calendar_delete" || tool === "drive_upload";
}

export async function googleCardFacts(api: GoogleApi, tool: string, a: Record<string, unknown>): Promise<GoogleCardFacts | { error: string }> {
  const bad = (k: string) => ({ error: `${k} isn't a valid Google id.` });
  if (tool === "gmail_send" || tool === "gmail_draft") {
    const id = s(a.reply_to_id);
    if (!isGoogleId(id)) return bad("reply_to_id");
    const m = await api.call<Meta>(`${api.endpoints.gmail}/users/me/messages/${encodeURIComponent(id)}`, { query: { format: "metadata" } });
    const replyTo = hdr(m, "Reply-To");
    const to = parseRecipients(replyTo || hdr(m, "From")) ?? [];
    if (!to.length) return { error: "The message being replied to has no usable sender address." };
    return { resolvedTo: to, lines: [`To: ${to.join(", ")}`, `(the ${replyTo ? "Reply-To address" : "sender"} of “${hdr(m, "Subject").slice(0, 120)}”)`] };
  }
  if (tool === "calendar_update" || tool === "calendar_delete") {
    const id = s(a.id);
    const calId = s(a.calendar) || "primary";
    if (!isGoogleId(id)) return bad("id");
    if (!isGoogleId(calId)) return bad("calendar");
    const e = await api.call<Event>(`${api.endpoints.calendar}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`);
    const title = s(e.summary) || "(no title)";
    const range = `${when(e.start)} → ${when(e.end)}`;
    return {
      lines: [`Event: “${title.slice(0, 120)}”`, `When: ${range}`],
      attendees: (e.attendees ?? []).map((x) => s(x.email)).filter(Boolean),
      summary: tool === "calendar_delete" ? `Delete “${title.slice(0, 120)}” (${range}) from your Google Calendar` : `Change “${title.slice(0, 120)}” (${range}) on your Google Calendar`,
    };
  }
  if (tool === "drive_upload") {
    const folder = s(a.folder) || "root";
    if (!isGoogleId(folder)) return bad("folder");
    const f = await api.call<DriveItem>(`${api.endpoints.drive}/files/${encodeURIComponent(folder)}`, { query: { fields: "id,name,mimeType,shared", supportsAllDrives: true } });
    const name = s(f.name) || (folder === "root" ? "My Drive" : folder);
    const sharing = f.shared ? "shared with other people" : "private (only you)";
    return {
      lines: [`Folder: ${name.slice(0, 120)}`, `Sharing: ${sharing}`],
      summary: `Upload ${s(a.path)} to your Google Drive folder “${name.slice(0, 120)}” (${f.shared ? "shared" : "private"})${a.name ? ` as “${s(a.name).slice(0, 120)}”` : ""}`,
    };
  }
  return { lines: [] };
}
