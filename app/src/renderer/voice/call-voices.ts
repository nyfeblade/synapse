import { VOICE_PREFIX, voiceBlockedByMode, type VoiceMode } from "@synapse/shared";
import type { VoiceView } from "./audio-devices";

const RANK = { premium: 3, enhanced: 2, default: 1 } as const;
const KOKORO = "kokoro:";
const QWEN = VOICE_PREFIX.qwen;

/** A stable small hash of a Bot id (FNV-1a), so a Bot keeps its voice across calls. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * Voice calls: the voice each Bot speaks with. A Bot's own voice (Bot settings) always wins. In a
 * 1:1 call, Settings → Voice comes next. Otherwise — and for every Bot in a group call, so they
 * don't all sound alike — a voice from the best quality tier installed, picked by the Bot's id and
 * distinct within the call (spilling to the next tier when the top one runs out).
 * `undefined` = let the helper choose (no voice list).
 *
 * Bug 164: the automatic pool stays Kokoro-only. A Qwen voice is only ever an explicit per-Bot
 * choice, because it costs 2.1 GB and nobody should pay that without having asked for it.
 */
export function assignVoices(botIds: string[], voices: readonly VoiceView[], overrides: Record<string, string | null | undefined>, appVoice: string | null, group: boolean, natural: readonly string[] = [], mode: VoiceMode = "full", qwen = true): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const used = new Set<string>();
  const auto: string[] = [];
  const usable = (v: string | null | undefined): string | null => {
    if (!v) return null;
    // Bug 107: a Kokoro choice ("kokoro:<id>") only counts while Kokoro is Ready.
    if (v.startsWith(KOKORO)) return natural.length ? v : null;
    // Bug 164: Light voice mode loads neither Qwen nor F5, so a Bot set to one of those counts as
    // unset here and takes the Kokoro voice it would have been assigned anyway. The saved setting
    // is untouched — this only decides what this call speaks with.
    if (voiceBlockedByMode(v, mode)) return null;
    if (v.startsWith(QWEN)) return qwen ? v : null;
    return v;
  };
  for (const id of botIds) {
    const own = usable(overrides[id]);
    if (own) { out[id] = own; used.add(own); }
    else if (!group && usable(appVoice)) out[id] = appVoice!;
    else auto.push(id);
  }
  // Bug 107: Kokoro Ready — it is the default engine; each Bot gets its own natural voice.
  if (natural.length) {
    const pool = natural.map((n) => KOKORO + n);
    for (const id of [...auto].sort((a, b) => hash(a) - hash(b) || a.localeCompare(b))) {
      const free = pool.filter((v) => !used.has(v));
      const pick = free.length ? free[hash(id) % free.length]! : pool[hash(id) % pool.length]!;
      out[id] = pick;
      used.add(pick);
    }
    return out;
  }
  if (!voices.length) { for (const id of auto) out[id] = undefined; return out; }
  const tiers = [...new Set(voices.map((v) => RANK[v.quality]))].sort((a, b) => b - a);
  for (const id of [...auto].sort((a, b) => hash(a) - hash(b) || a.localeCompare(b))) {
    let pick: string | undefined;
    for (const t of tiers) {
      const pool = voices.filter((v) => RANK[v.quality] === t).map((v) => v.id);
      const free = pool.filter((v) => !used.has(v));
      if (!free.length) continue;
      pick = free[hash(id) % free.length];
      break;
    }
    // Every voice is taken: share, still deterministically.
    pick ??= voices[hash(id) % voices.length]!.id;
    out[id] = pick;
    used.add(pick);
  }
  return out;
}
