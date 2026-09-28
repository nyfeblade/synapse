import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { CALL_FEEL, LIMITS5, STR5, STRV, VOICE_PREFIX, isVoiceMode, callSeats, type ApprovalCardView, type CallGreeting, type CallGreetingsView, type VoiceCallView, type VoiceMode } from "@synapse/shared";
import { call, callQuiet } from "../bridge";
import { ApprovalCard } from "../components/ApprovalCard";
import { useOverlayLayer } from "../components/Dialog";
import { CheckIcon, CloseIcon, GearIcon, HangUpIcon, HeadsetIcon, MicIcon, MicOffIcon, ScreenShareIcon } from "../components/Icons";
import { shareStill, wantsLook } from "./screen-share";
import { subscribeChannel } from "../feature-store";
import { CallAddMenu } from "./CallAddMenu";
import { ShapeAvatar } from "../components/ShapeAvatar";
import { seatGlance } from "../avatar/living-gaze";
import { livingNod } from "../avatar/living-bus";
import { CallMeter } from "./CallMeter";
import { nativeCall, onNative } from "../native";
import { useUi } from "../store";
import { sttContextFor } from "./stt-context";
import { deviceNotice, deviceOptions, levelPercent, useAudioDevices, type DeviceKind, type VoiceView } from "./audio-devices";
import { assignVoices } from "./call-voices";
import { playHangUp } from "./call-sounds";
import { useCall } from "./call-store";
import { useBotCalls } from "./bot-calls-store";
import { dictationFault, type PrivacyPane } from "./dictation-errors";
import { PrivacySettingsButton } from "./PrivacySettingsButton";
import { isOwnSession, newDictationSessionId } from "./session";
import { pauseMsFor } from "./sentences";
import { speechText } from "./speech-text";
import { cancelSpeech, speak } from "./tts";
import { VoiceLoop, type CallState, type RaisedHand as HandState } from "./voice-loop";
import { parseCallCommand } from "./call-commands";
import { useCallMemberMenu } from "./CallMemberMenu";
import { ackLines, phraseBags, stockLines, takeGreeting } from "./call-phrases";
import { useCallPresence, useCallSlot } from "./call-presence";
import { MiniCall } from "./MiniCall";
import { CallPicker, RaisedHand } from "./RaisedHand";
import { approvalAnswer, approvalQuestion } from "./call-approvals";
import { isPhoneCall, usePhoneCall } from "./phone-bridge";

/**
 * CHAT-08: which chat (a Bot or a group) has a voice call open. Phase 2 (bug 213): `adding` — the other
 * Bots to bring onto it as soon as it connects ("call Nova and Scout" from the palette or the wake word).
 */
export const useVoice = create<{ openFor: string | null; adding: string[]; open(botId: string, adding?: string[]): void; close(): void; takeAdding(): string[]; bringIn(ids: string[]): void }>((set, get) => ({
  openFor: null, adding: [],
  /** Bots to add to the call that is already open (the palette's "call A and B" mid-call). */
  bringIn: (ids) => set((s) => ({ adding: [...new Set([...s.adding, ...ids])].filter((x) => x !== s.openFor).slice(0, LIMITS5.callMaxBots - 1) })),
  open: (botId, adding = []) => set({ openFor: botId, adding: adding.filter((x) => x !== botId).slice(0, LIMITS5.callMaxBots - 1) }),
  close: () => set({ openFor: null, adding: [] }),
  takeAdding: () => { const a = get().adding; if (a.length) set({ adding: [] }); return a; },
}));

const NO_ENTRIES: never[] = [];
const NO_MEMBERS: string[] = [];
let speakSeq = 0;

type Ev = { type: string; text?: string; message?: string; code?: string; id?: string; sessionId?: string; kind?: string; name?: string; fallback?: string; mic?: number; out?: number | null; reason?: string };

/** The chat header's "Start a voice call" button (a headset), for a Bot's chat and a group chat alike. */
export function CallButton({ botId }: { botId: string }) {
  const open = useVoice((s) => s.open);
  return (
    <button type="button" className="icon-btn call-btn" aria-label={STR5.startVoiceChat} title={STR5.startVoiceChat} onClick={() => open(botId)}>
      <HeadsetIcon />
    </button>
  );
}

/**
 * Bug 134 (item 10): the live call lives at the app level, so it keeps running while the user reads
 * another chat (as a floating pill); the call screen itself shows in the call's own chat pane.
 */
export function CallHost() {
  const openFor = useVoice((s) => s.openFor);
  return openFor ? <VoiceOverlay key={openFor} botId={openFor} /> : null;
}

/**
 * A voice call with a Bot — or with every Bot in a group — inside the chat pane. The microphone
 * stays open for the whole call (echo-cancelled in the helper); the user's words go to the chat as
 * messages; each reply is spoken sentence by sentence while it streams, one Bot at a time, each Bot
 * in its own voice; talking over a Bot stops it at once. Captions, a live mic meter, the Bot's avatar
 * moving with its voice, a timer, approvals inside the call, and "started / ended" markers in the chat.
 */
export function VoiceOverlay({ botId }: { botId: string }) {
  const { openFor, close } = useVoice();
  const bot = useUi((s) => s.bots[botId]);
  const bots = useUi((s) => s.bots);
  const entries = useUi((s) => s.transcripts[botId] ?? NO_ENTRIES);
  const typing = useUi((s) => s.typing);
  const markInterrupted = useCall((s) => s.markInterrupted);
  // Task 34 fuzz: closing the chat ends the call, so the mic doesn't come back on when you return.
  useEffect(() => () => { if (useVoice.getState().openFor === botId) useVoice.getState().close(); }, [botId]);
  const [state, setState] = useState<CallState>("idle");
  const [muted, setMuted] = useState(false);
  // What the helper is hearing right now (live partial), so the user sees they are being heard.
  const [heard, setHeard] = useState("");
  // Set only when the call had to give up (microphone access off, or the helper kept dying).
  const [fault, setFault] = useState<string | null>(null);
  // Bug 99: the System Settings pane that fixes the current fault, when it is a permission fault.
  const [faultPane, setFaultPane] = useState<PrivacyPane | null>(null);
  const stagedPane = useRef<PrivacyPane | null>(null);
  // Bug 105: a device dropped out / came back, or echo cancellation is off for this device pair.
  const [notice, setNotice] = useState<string | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  // Screen share: while on, each finished turn carries one still of the screen. Off at every call's start.
  const [sharing, setSharing] = useState(false);
  const sharingRef = useRef(false);
  const [shareIssue, setShareIssue] = useState<{ text: string; pane: "screen" | null } | null>(null);
  // Token-cautious: a still goes only when the user's words ask the Bot to look, or the Bot asks
  // (once per user turn). `snapAt` shows the "Sent a snapshot" tick; `lookAsked` = the Bot asked
  // while the user wasn't sharing, so turning Share on sends that one still.
  const botLooked = useRef(false);
  const [lookAsked, setLookAsked] = useState(false);
  const lookAskedRef = useRef(false);
  const [snapAt, setSnapAt] = useState(0);
  useEffect(() => {
    if (!snapAt) return;
    const t = setTimeout(() => setSnapAt(0), 2_500);
    return () => clearTimeout(t);
  }, [snapAt]);
  const takeStill = async (): Promise<string[] | undefined> => {
    const r = await shareStill(botId);
    if ("attachmentId" in r) { setSnapAt(Date.now()); return [r.attachmentId]; }
    // The words still go: a failed snapshot never costs the user their turn.
    setShareIssue({ text: r.fault, pane: r.pane });
    if (r.stop) { sharingRef.current = false; setSharing(false); }
    return undefined;
  };
  const takeStillRef = useRef(takeStill);
  takeStillRef.current = takeStill;
  /** The still the Bot asked for, sent on its own as the user's next message. */
  const sendAskedStill = async () => {
    const ids = await takeStillRef.current();
    if (ids) void call("sendPrompt", { id: botId, text: STRV.snapshotForBot, clientNonce: crypto.randomUUID(), attachmentIds: ids, voice: { durationMs: 0, call: true } }).catch(() => {});
  };
  const sendAskedStillRef = useRef(sendAskedStill);
  sendAskedStillRef.current = sendAskedStill;
  const setShare = (on: boolean) => {
    sharingRef.current = on; setSharing(on);
    if (!on) return;
    setShareIssue(null);
    if (lookAskedRef.current) { lookAskedRef.current = false; setLookAsked(false); void sendAskedStill(); }
  };
  // Captions of both sides (the last two lines), the mic level, who is speaking and how loud.
  const [captions, setCaptions] = useState<{ who: string; text: string }[]>([]);
  const [mic, setMic] = useState(0);
  const [outLevel, setOutLevel] = useState(0);
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const audio = useAudioDevices(devicesOpen && openFor === botId);
  const seen = useRef(new Set<string>());
  // The dictation session this call owns right now. Events for any other session belong to the
  // composer microphone — or to a helper this call has already replaced — and are not ours.
  const session = useRef<string | null>(null);
  // Lines the helper is speaking: id → resolves the loop's speak() when the helper says it's done.
  const speaking = useRef(new Map<string, () => void>());
  // A call the user accepted from a ring: when the pick-up happened, until the opening line is heard.
  const openingAt = useRef<number | null>(null);
  // ---- bug 134: calls that feel like calling teammates ----
  const [hands, setHands] = useState<HandState[]>([]);
  const [pick, setPick] = useState<{ kind: "add" | "remove"; ids: string[] } | null>(null);
  const [wrapping, setWrapping] = useState(false);
  const wrappingRef = useRef(false);
  /** Each Bot's pick-up greetings (its own set once authored; the stock set until then). */
  const greetings = useRef<Record<string, CallGreeting[]>>({});
  const greeted = useRef(false);
  // Bug 218: the end-of-turn sounds already rendered in each Bot's voice ("<botId>\n<text>"): only those are made.
  const ackReady = useRef(new Set<string>());
  const newBags = () => phraseBags({ ready: (who, t) => ackReady.current.has(`${who}\n${t}`) });
  const bags = useRef(newBags());
  /** Bug 213: where each Bot sits, left to right — the avatar row's order and its voice's angle. */
  const seats = useRef<{ order: string[]; azimuth: Record<string, number> }>({ order: [], azimuth: {} });
  /** Bug 213 (review): the helper runs this call spatial (stereo, seats) — from its start for a group
   * call, from the moment a second Bot joins for a 1:1 call (one rebuild), never back. */
  const spatialOn = useRef(false);
  const addBotsRef = useRef<(ids: string[]) => void>(() => {});
  const soundsOn = useRef(true);
  const callIdRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const membersRef = useRef<string[]>([]);
  const interceptRef = useRef<(t: string) => boolean>(() => false);
  /** Bug 142: whether an utterance would be handled by the call itself (a voice command, a yes / no to a card) — no side effects. */
  const interceptPreviewRef = useRef<(t: string) => boolean>(() => false);
  const lastSpeakerRef = useRef<string | null>(null);
  const callStartPerf = useRef(0);
  const firstAudioMarked = useRef(false);
  const active = openFor === botId;
  const isGroupChat = Boolean(bot?.group);
  // Bug 108: the host owns who is on the call (startCall/addToCall/removeFromCall). An older host
  // without calls: the chat's own members, as before.
  const [callView, setCallView] = useState<VoiceCallView | null>(null);
  const chatMembers = bot?.group ? bot.group.memberIds : bot ? [botId] : NO_MEMBERS;
  const members = callView?.participantIds ?? chatMembers;
  // More than one Bot on the call: the avatar row, a distinct voice each.
  const isGroup = isGroupChat || members.length > 1;
  const memberKey = members.join(",");
  membersRef.current = members;
  // Bug 213: seats follow the roster (pure and idempotent: Bots keep their order; a newcomer sits where
  // the voices already there move least). The row is drawn in this order, so the picture matches the sound.
  seats.current = callSeats(members, seats.current.order);
  const seatOrder = seats.current.order;
  const callViewRef = useRef(callView);
  callViewRef.current = callView;
  /** Bug 142: the live speculative start (its id), and the newest pending card on the call (a spoken yes / no answers it). */
  const specRef = useRef<string | null>(null);
  const pendingApprovalRef = useRef<{ botId: string; approvalId: string } | null>(null);
  // Bug 126: a group call and a call room carry the still too (the host hands it to every Bot that answers),
  // so adding a Bot mid-call keeps sharing on.
  // Every Bot's voice for this call (F): its own, else Settings → Voice (1:1), else a distinct best voice.
  const [voiceList, setVoiceList] = useState<{ voices: VoiceView[]; chosen: string | null }>({ voices: [], chosen: null });
  useEffect(() => {
    if (!active) return;
    void nativeCall<{ voices?: VoiceView[]; chosen?: string | null }>("audio.voices.list").then(
      (r) => setVoiceList({ voices: Array.isArray(r?.voices) ? r.voices : [], chosen: r?.chosen ?? null }), () => {});
  }, [active]);
  // Bug 107: the natural (Kokoro) voices, when Kokoro is Ready — then it is every Bot's default engine.
  const [natural, setNatural] = useState<string[]>([]);
  useEffect(() => {
    if (!active) return;
    void nativeCall<{ state?: string; voices?: { id: string }[] }>("kokoro.status").then(
      (r) => setNatural(r?.state === "ready" && Array.isArray(r.voices) ? r.voices.map((v) => v.id) : []), () => setNatural([]));
  }, [active]);
  // Bug 164: the voice mode decides which engines this call may use at all. It is read when the call
  // opens and left alone after that — switching modes takes effect on the NEXT call, never this one —
  // except for the one case that has to act now: the Mac running short mid-call.
  const [mode, setMode] = useState<VoiceMode>("full");
  const [qwenReady, setQwenReady] = useState(false);
  useEffect(() => {
    if (!active) return;
    void nativeCall<{ mode?: string }>("voiceMode.get").then((r) => setMode(isVoiceMode(r?.mode) ? r.mode : "full"), () => setMode("full"));
    void nativeCall<{ state?: string }>("qwen.status").then((r) => setQwenReady(r?.state === "ready"), () => setQwenReady(false));
    // The Mac went short mid-call: Full gives way for the rest of THIS call. One short line, said
    // once, and the call itself is never interrupted.
    return onNative<{ mode?: string; reason?: string }>("voice-mode", (e) => {
      if (e?.reason !== "low-memory") return;
      setMode("light");
      setNotice(STR5.voiceModeDroppedLowMemory);
    });
  }, [active]);
  const voices = useRef<Record<string, string | undefined>>({});
  voices.current = useMemo(() => assignVoices(members, voiceList.voices, Object.fromEntries(members.map((m) => [m, bots[m]?.settings.voice ?? null])), voiceList.chosen, isGroup, natural, mode, qwenReady),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [memberKey, voiceList, isGroup, bots, natural, mode, qwenReady]);
  /**
   * Bug 190: a Bot whose OWN voice is Qwen3, whatever this call speaks it with — Qwen, or the Kokoro
   * voice it falls back to (Qwen unavailable, or Light mode on a short Mac). None of its lines gets question handling.
   */
  const ownVoice = useRef<{ chosen: string | null; group: boolean }>({ chosen: null, group: false });
  ownVoice.current = { chosen: voiceList.chosen, group: isGroup };
  const qwenBot = (who: string): boolean => {
    const own = useUi.getState().bots[who]?.settings.voice ?? (ownVoice.current.group ? null : ownVoice.current.chosen);
    return (voices.current[who] ?? "").startsWith(VOICE_PREFIX.qwen) || (own ?? "").startsWith(VOICE_PREFIX.qwen);
  };
  const nameOf = (id: string) => bots[id]?.profile.name ?? bot?.profile.name ?? "";
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;
  const caption = (who: string, text: string) => setCaptions((c) => [...c, { who, text }].slice(-2));
  /** The Kokoro ids of the call's voices ("bm_george"), so the sidecar builds them first. */
  const kokoroIds = () => membersRef.current.map((m) => voices.current[m]).filter((v): v is string => typeof v === "string" && v.startsWith("kokoro:")).map((v) => v.slice(7));
  /** Bug 134: render each Bot's own call lines ahead in its Kokoro voice (kept on this Mac; no tokens). */
  /**
   * Decision 184 / bug 164: a Bot on a Qwen (or cloned) voice falls back, for a WHOLE reply, to the Kokoro voice it
   * would have been given automatically — and bug 221: its Qwen lines are held to that voice's level.
   */
  // Bug 222: read at the moment a line is spoken. The call's speak() is made once (useMemo) and used to close over
  // the FIRST render's voice list — empty, the natural voices not loaded yet — so no Qwen line on a real call ever
  // named its Kokoro voice: every one was held to the default level, and with Qwen not ready it fell to Apple's voice.
  const fallbackIn = useRef({ voiceList, isGroup, natural, mode, qwenReady });
  fallbackIn.current = { voiceList, isGroup, natural, mode, qwenReady };
  const kokoroFallback = (who: string, voice: string | undefined): string | undefined => {
    if (!voice || voice.startsWith("kokoro:")) return undefined;
    const f = fallbackIn.current;
    return assignVoices([who], f.voiceList.voices, {}, null, f.isGroup, f.natural, f.mode, f.qwenReady)[who];
  };
  const preparePhrases = (ids: string[]) => {
    const items: { voice: string; speed: number; text: string; kind?: "greeting"; fallback?: string }[] = [];
    for (const m of ids) {
      const v = voices.current[m];
      // Bug 190: a Qwen Bot's Kokoro stand-in is never pre-rendered — the cache would hand it a
      // Kokoro Bot's ramped take of the same words; its lines render live, without the ramp.
      // Bug 221: a Qwen Bot on Qwen IS — in its Qwen voice, held to its own Kokoro voice's level.
      const kokoro = v?.startsWith("kokoro:") && !qwenBot(m);
      const fb = v?.startsWith("qwen3:") ? kokoroFallback(m, v) : undefined;
      if (!v || !(kokoro || fb?.startsWith("kokoro:"))) continue;
      const speed = useUi.getState().bots[m]?.settings.speechRate ?? 1;
      // Bug 151: greetings are marked, so a cached one that stops being a greeting is dropped on the next launch.
      const greetingTexts = new Set((greetings.current[m] ?? []).map((g) => g.text));
      for (const t of [...greetingTexts, ...stockLines()]) { const text = speechText(t); if (text) items.push({ voice: v, speed, text, ...(greetingTexts.has(t) ? { kind: "greeting" as const } : {}), ...(fb ? { fallback: fb } : {}) }); }
    }
    if (items.length) void nativeCall("voice.phrases.prepare", { items }).catch(() => {});
    refreshAcks(ids);
  };
  /** Bug 218: which end-of-turn sounds each Bot can make at once (rendered in its voice already; asked, not guessed). */
  const refreshAcks = (ids: string[]) => {
    for (const m of ids) {
      const v = voices.current[m];
      if (!v || !/^(?:kokoro|qwen3):/.test(v)) continue;
      const speed = useUi.getState().bots[m]?.settings.speechRate ?? 1;
      const lines = ackLines();
      const fb = v.startsWith("qwen3:") ? kokoroFallback(m, v) : undefined;
      void nativeCall<{ has?: boolean[] }>("voice.phrases.has", { items: lines.map((t) => ({ voice: v, speed, text: speechText(t), ...(fb ? { fallback: fb } : {}) })) })
        .then((r) => { lines.forEach((t, i) => { if (r?.has?.[i]) ackReady.current.add(`${m}\n${t}`); }); }, () => {});
    }
  };
  const greetingsFor = (id: string): CallGreeting[] => (greetings.current[id]?.length ? greetings.current[id]! : STRV.stockGreetings(null));

  const loop = useMemo(() => {
    const settle = () => { for (const r of speaking.current.values()) r(); speaking.current.clear(); };
    const mark = (what: string, ms?: number) => { if (session.current) void nativeCall("dictation.mark", { sessionId: session.current, what, ...(ms !== undefined ? { ms } : {}) }).catch(() => {}); };
    return new VoiceLoop({
      start: () => {
        const sessionId = newDictationSessionId();
        session.current = sessionId;
        settle(); // a new helper can't finish the old one's speech
        // Bug 162: a call needs the names at least as much as the composer does — the user says them
        // out loud to the Bot. Read at start, so it costs nothing while the call runs.
        const ui = useUi.getState();
        const context = sttContextFor(ui.bots, ui.transcripts, bot?.id ?? ui.activeBotId);
        // Bug 213 (review): a 1:1 call starts exactly as before (mono); a group call — a group chat, or a
        // call started with others to bring in — starts spatial, so nothing is rebuilt when they join.
        spatialOn.current = spatialOn.current || membersRef.current.length > 1 || useVoice.getState().adding.length > 0;
        void nativeCall("dictation.start", { sessionId, mode: "call", voices: kokoroIds(), ...(spatialOn.current ? { spatial: true } : {}), ...(bot?.settings.spokenLanguage ? { locale: bot.settings.spokenLanguage } : {}), ...(context.length ? { context } : {}) });
      },
      stop: () => void nativeCall("dictation.stop", { sessionId: session.current }),
      // Returned, not fire-and-forget: the loop needs the rejection so it can hand the microphone
      // back and tell the user, instead of sitting in "thinking" with the microphone dead.
      send: async (text, durationMs, extra) => {
        // A new user turn: the Bot may ask for one still again.
        botLooked.current = false;
        // Bug 142: a final that confirms the early start names it, so the host keeps the reply it already began.
        const speculationId = extra?.speculated ? specRef.current : null;
        specRef.current = null;
        // At most one still per user turn, and only when the words ask the Bot to look.
        const attachmentIds = sharingRef.current && wantsLook(text) ? await takeStillRef.current() : undefined;
        return call("sendPrompt", { id: botId, text, clientNonce: crypto.randomUUID(), voice: { durationMs, call: true, ...(speculationId ? { speculationId } : {}), ...(extra?.continues ? { continues: true } : {}) }, ...(attachmentIds ? { attachmentIds } : {}) });
      },
      // Bug 142: on a fast-path call, the helper's likely end of turn starts the Bot's voice early (held on the host).
      speculate: (text) => {
        if (!callViewRef.current?.fastPath || sharingRef.current || interceptPreviewRef.current(text)) return;
        const specId = crypto.randomUUID();
        specRef.current = specId;
        void callQuiet("voiceSpeculate", { id: botId, specId, text }).catch(() => { if (specRef.current === specId) specRef.current = null; });
      },
      cancelSpeculation: () => {
        const specId = specRef.current;
        specRef.current = null;
        if (specId) void callQuiet("voiceSpeculateCancel", { id: botId, specId }).catch(() => {});
      },
      speak: async (raw, o) => {
        // Bug 107: said the way a person says it (no markdown, emoji or URLs; natural numbers and units).
        const clean = speechText(raw);
        if (!clean) return;
        // …but the line still has to end the way its sentence did: cleaning up can take the mark with
        // what it replaced (a URL swallows the full stop after it), and a bare line trails off.
        const mark = raw.trim().match(/([.!?,;:])["')\]]*$/)?.[1];
        const text = mark && !/[.!?,;:]["')\]]*$/.test(clean) ? `${clean}${mark}` : clean;
        const who = o?.botId || botId;
        const st = useUi.getState().bots[who]?.settings ?? bot?.settings;
        const id = `sp-${++speakSeq}`;
        const done = new Promise<void>((r) => speaking.current.set(id, r));
        const voice = voices.current[who] ?? st?.voice ?? undefined;
        // Bug 134: the call's own lines are pre-rendered (and kept) in the Bot's voice; a group call
        // places each Bot's voice at its seat.
        const cache = (o?.phrase !== undefined && o.phrase !== "notice" && o.phrase !== "wrap-up") || STRV.goodbyes.some((g) => speechText(g) === text) || speechText(STRV.delegatedOnIt) === text; // bug 223: pre-rendered
        // Bug 213: a group call's line carries its Bot's seat (an angle) and whose seat it is; a 1:1
        // call's voice stays centred on the direct path, exactly as before.
        const azimuth = membersRef.current.length > 1 ? seats.current.azimuth[who] : undefined;
        // Decision 184 / bug 164: a Bot set to a Qwen (or cloned) voice needs a Kokoro voice to fall
        // back to for the WHOLE reply if that engine turns out to be unavailable. It is the one this
        // Bot would have been given automatically, so it is the same voice every time and the same
        // one its greetings were pre-rendered in.
        const fallbackVoice = kokoroFallback(who, voice);
        const r = await nativeCall<{ spoken?: boolean } | null>("dictation.speak", {
          sessionId: session.current, id, text, ...(o?.queue ? { queue: true } : {}),
          ...(fallbackVoice?.startsWith("kokoro:") ? { fallbackVoice } : {}),
          // The pause after the line is the punctuation it ends on \u2014 a breath after a comma, a beat
          // after a full stop, a little longer after a question \u2014 not one flat number for everything.
          pauseMs: o?.pauseMs ?? pauseMsFor(raw),
          // Bug 166: what to leave instead if this line really goes to Qwen — which only the speech
          // side knows, since it is the one that decides whether Qwen is available.
          ...(o?.pauseMsFlow !== undefined ? { pauseMsQwen: o.pauseMsFlow } : {}),
          ...(voice ? { voice } : {}), ...(st?.speechRate ? { rate: st.speechRate } : {}), ...(st?.spokenLanguage ? { lang: st.spokenLanguage } : {}),
          ...(cache ? { cache: true } : {}), ...(azimuth !== undefined ? { azimuth, seat: who } : {}),
          // Bug 190: whose Bot this is, so its Kokoro stand-in drops the question ramp too.
          ...(qwenBot(who) ? { qwenBot: true } : {}),
        }).catch(() => null);
        if (r?.spoken) return done;
        // No live helper to speak through (it is restarting, or an older build): the page's own
        // system voice still reads the line, just without echo cancellation.
        speaking.current.delete(id);
        // Bug 198: never on a phone call — its audio is the phone's, and this Mac stays silent.
        if (isPhoneCall(botId)) return;
        // Bug 157: the same voice the helper was asked for (this Bot's own choice, else the call's
        // assignment) — not a different one just because the page is speaking the line.
        return speak(text, { voice: voice && /^(kokoro|qwen3|f5):/.test(voice) ? null : voice, rate: st?.speechRate, lang: st?.spokenLanguage });
      },
      // Bug 166: a Bot on a Qwen3 voice gets its reply in bigger pieces and its own pauses.
      naturalFlow: (who: string) => (voices.current[who] ?? "").startsWith(VOICE_PREFIX.qwen),
      qwenBot: (who: string) => qwenBot(who),
      cancelSpeech: () => {
        settle();
        if (session.current) void nativeCall("dictation.hush", { sessionId: session.current }).catch(() => {});
        cancelSpeech();
      },
      mute: (m) => void nativeCall("dictation.mute", { sessionId: session.current, muted: m }).catch(() => {}),
      // Plan item 16: a reply that ended on a question lets the helper end a short answer ("Yes.") sooner.
      expectAnswer: () => { if (session.current) void nativeCall("dictation.expect", { sessionId: session.current }).catch(() => {}); },
      now: () => Date.now(), silenceMs: LIMITS5.voiceSilenceMs, helperEndpoints: true,
      after: (ms, fn) => { setTimeout(fn, ms); },
      notify: (message) => { setFault(message); setFaultPane(stagedPane.current); stagedPane.current = null; },
      onLine: (who, text, phrase) => {
        setSpeaker(who);
        if (phrase === "filler") livingNod(who); // bug 226: the nod lands with the call's "Mm"
        if (!phrase) lastSpeakerRef.current = who;
        // Fillers, "sorry" and "one minute" are just sounds of the call, not captions.
        if (!phrase || phrase === "greeting" || phrase === "wrap-up" || phrase === "notice") caption(nameRef.current(who), text);
      },
      onInterrupted: (_who, entryId, said) => { if (entryId && said) markInterrupted(entryId, said); },
      mark,
      phrase: (kind, who, mood) => bags.current.next(kind, who, mood),
      members: () => membersRef.current.map((id) => ({ id, name: nameRef.current(id) })),
      working: (id) => Boolean(useUi.getState().bots[id]?.running),
      intercept: (t) => interceptRef.current(t),
      onHands: setHands,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, bot?.settings.spokenLanguage]);

  useEffect(() => {
    if (!active) return;
    seen.current = new Set(entries.map((e) => e.id));
    setFault(null);
    setMuted(false);
    setHeard("");
    setNotice(null);
    sharingRef.current = false;
    setSharing(false);
    setShareIssue(null);
    botLooked.current = false;
    lookAskedRef.current = false;
    setLookAsked(false);
    setSnapAt(0);
    setCaptions([]);
    setMic(0);
    greeted.current = false;
    wrappingRef.current = false;
    setWrapping(false);
    setHands([]);
    setPick(null);
    ackReady.current = new Set();
    bags.current = newBags();
    callIdRef.current = null;
    lastSpeakerRef.current = null;
    callStartPerf.current = performance.now();
    firstAudioMarked.current = false;
    void nativeCall<{ on?: boolean }>("calls.sounds.get").then((r) => { soundsOn.current = r?.on !== false; }, () => {});
    const began = Date.now();
    // Bug 198: a call placed from the phone: its sounds are the phone's (it plays its own hang-up tone).
    const phoneCall = isPhoneCall(botId);
    const phoneSeq = usePhoneCall.getState().seq;
    startedAtRef.current = began;
    setStartedAt(began);
    setNow(began);
    // E: the call is recorded in the chat, around the turns it produces. Bug 108: the host starts
    // the call (its roster and markers); an older host without calls gets the plain markers.
    let ended = false;
    let callId: string | null = null;
    // startCall answered (either way); a hang-up before that is ended by the answer's handler.
    let settled = false;
    setCallView(null);
    void callQuiet("startCall", { id: botId }).then((v) => {
      settled = true;
      if (!v || typeof v.callId !== "string") throw new Error("no calls on this host");
      if (ended) { void callQuiet("endCall", { callId: v.callId, durationMs: Date.now() - began }).catch(() => {}); return; }
      callId = v.callId;
      callIdRef.current = v.callId;
      setCallView(v);
      // Phase 2 (bug 213): a group call started in one action — the others join as soon as it
      // connects, one after another (the audio path is already stereo: nothing is rebuilt).
      const more = useVoice.getState().takeAdding();
      void more.reduce<Promise<unknown>>((p, id) => p.then(() => callQuiet("addToCall", { callId: v.callId, botId: id })
        .then((nv) => { if (!ended && nv?.callId) setCallView(nv); }, () => {})), Promise.resolve());
    }).catch(() => { settled = true; if (!ended) void call("noteVoiceCall", { id: botId, phase: "started" }).catch(() => {}); });
    loop.begin();
    // The Bot asked to see the screen (SendMessage call: "look"): once per user turn. Sharing → the
    // still goes now; not sharing → the call screen asks, and turning Share on sends it.
    const offLook = subscribeChannel("call-look", (p) => {
      if (p?.botId !== botId || botLooked.current) return;
      botLooked.current = true;
      if (sharingRef.current) void sendAskedStillRef.current();
      else { lookAskedRef.current = true; setLookAsked(true); }
    });
    // Bug 158: a Bot on the call took another Bot off (update_state target "call"): the host says so,
    // and the call screen follows — the same avatar row, leave sound and spoken line as any other removal.
    const offRoster = subscribeChannel("call-roster", (v) => { if (v?.chatId === botId && v.callId === callIdRef.current) setCallView(v); });
    // Plan item 27: the Bot's voice said nothing to this turn ([quiet]): the call stops waiting for a reply.
    const offQuiet = subscribeChannel("call-quiet", (p) => { if (p?.botId && membersRef.current.includes(p.botId)) { loop.onQuiet(p.botId); setState(loop.state); } });
    const off = onNative<Ev>("dictation", (e) => {
      if (!isOwnSession(e.sessionId, session.current)) return; // the composer mic's session, not ours
      // A fault line is about the turn that just failed; once the user speaks again it is stale.
      // A Bot called and the user picked up: once the helper is up, the Bot opens with why it called.
      if (e.type === "ready") {
        const o = useBotCalls.getState().takeOpening(botId);
        if (o) { openingAt.current = o.acceptedAt; greeted.current = true; loop.onBotText(o.text, botId); }
        // Bug 134 (item 1): the user called: the Bot picks up at once, in its own voice (a pre-rendered
        // greeting from this Mac's cache; Apple's voice if it isn't rendered yet). No tokens.
        if (!greeted.current) {
          greeted.current = true;
          const who = bot?.group ? membersRef.current[0] : botId;
          const text = who ? takeGreeting(who, greetingsFor(who)) : null;
          if (who && text) void loop.say(who, text, "greeting");
        }
      }
      if (e.type === "speak-audio" && !firstAudioMarked.current) {
        firstAudioMarked.current = true;
        if (session.current) void nativeCall("dictation.mark", { sessionId: session.current, what: "call-first-audio", ms: performance.now() - callStartPerf.current }).catch(() => {});
      }
      if (e.type === "speak-audio" && openingAt.current !== null) {
        const ms = performance.now() - openingAt.current;
        openingAt.current = null;
        if (session.current) void nativeCall("dictation.mark", { sessionId: session.current, what: "accept-first-audio", ms }).catch(() => {});
      }
      if (e.type === "speech-start") { setFault(null); loop.onSpeechStart(); }
      if (e.type === "speech-drop") loop.onSpeechDrop();
      if (e.type === "barge-in") loop.onBargeIn();
      const n = deviceNotice(e);
      if (n) setNotice(n);
      // Bug 107: Kokoro couldn't say a line; the helper said it with Apple's voice.
      if (e.type === "tts-fallback") setNotice(STR5.naturalVoiceFellBack);
      // Bug 213: the helper went back to the headset's own mic: its line goes too.
      if (e.type === "mic-choice" && e.reason !== "keep-stereo") setNotice((x) => (x === STR5.micKeepsStereo ? null : x));
      if (e.type === "partial") { setFault(null); setHeard(e.text ?? ""); loop.onPartial(e.text ?? ""); }
      // Bug 142: the helper judged the utterance complete before its silence window ended.
      if (e.type === "likely-end" && e.text) loop.onLikelyEnd(e.text);
      if (e.type === "final") { setHeard(""); if (e.text?.trim()) caption(STR5.callYou, e.text.trim()); loop.onFinal(e.text ?? ""); }
      if (e.type === "speak-audio") loop.onAudioOut();
      if (e.type === "speak-end" && e.id) { speaking.current.get(e.id)?.(); speaking.current.delete(e.id); }
      if (e.type === "level" && typeof e.mic === "number") {
        setMic(levelPercent(e.mic));
        setOutLevel(typeof e.out === "number" ? levelPercent(e.out) : 0);
      }
      // An old-style helper ends on silence with `error` ("No speech detected") then `end`; the
      // loop brings listening back. Any other error ends the call with the helper's own reason.
      if (e.type === "error") {
        const f = dictationFault(e.message ?? "", e.code);
        if (f.notice) loop.onSessionEnd(e.message ?? "No speech detected");
        else { stagedPane.current = f.pane; loop.onFault(f.text); stagedPane.current = null; }
      }
      if (e.type === "end") loop.onSessionEnd();
      setState(loop.state);
    });
    const t = setInterval(() => { loop.tick(); setState(loop.state); setNow(Date.now()); }, 200);
    return () => {
      off(); offLook(); offRoster(); offQuiet(); clearInterval(t); loop.end();
      sharingRef.current = false; // hanging up always stops sharing
      // Hanging up leaves anything the Bot is doing running; only the call ends.
      ended = true;
      const durationMs = Date.now() - began;
      // The hang-up tone: only for a call that actually connected (startCall returned a callId),
      // whatever ended it (the user, the Bot, or the connection itself) — never for one that never did.
      if (callId && soundsOn.current && !phoneCall) playHangUp();
      // Bug 198: the phone learns the call ended here (a no-op when it wasn't the phone's call).
      if (phoneCall) {
        void nativeCall("phone.callEnded", { botId, seq: phoneSeq }).catch(() => {});
        if (usePhoneCall.getState().seq === phoneSeq) usePhoneCall.setState({ botId: null, seq: 0 });
      }
      if (callId) void callQuiet("endCall", { callId, durationMs }).catch(() => {});
      else if (settled) void call("noteVoiceCall", { id: botId, phase: "ended", durationMs }).catch(() => {});
      // Bug 134 (item 4): however the call ended, a substantial one leaves its summary in the chat
      // (one short helper call; the host skips a short or empty call, and never does it twice).
      if (callId && durationMs >= CALL_FEEL.wrapUpMinMs && !wrappingRef.current) void callQuiet("wrapUpCall", { callId, durationMs }).catch(() => {});
      wrappingRef.current = false;
      useCallPresence.getState().set(null, []);
      setCallView(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loop]);

  // Bug 134: who is on the call (the sidebar's "On a call"), each Bot's greetings, and the join / leave sounds.
  const prevMembers = useRef<string[] | null>(null);
  useEffect(() => {
    if (!active) { prevMembers.current = null; return; }
    useCallPresence.getState().set(botId, members);
    const prev = prevMembers.current;
    prevMembers.current = members;
    for (const m of members) {
      const mb = useUi.getState().bots[m];
      if (m in greetings.current || !mb || mb.group) continue;
      greetings.current[m] = [];
      void callQuiet("getCallGreetings", { id: m }).then((g: CallGreetingsView) => {
        if (g && Array.isArray(g.greetings)) { greetings.current[m] = g.greetings; preparePhrases([m]); }
      }).catch(() => {});
    }
    // Bug 213 (review): a 1:1 call that becomes a group call goes spatial once (one rebuild, replayed);
    // it never goes back. The helper also learns who holds a seat, so a Bot that left frees its player.
    if (members.length >= 2 && session.current) {
      if (!spatialOn.current) { spatialOn.current = true; void nativeCall("dictation.spatial", { sessionId: session.current, on: true }).catch(() => {}); }
      void nativeCall("dictation.seats", { sessionId: session.current, ids: members }).catch(() => {});
    }
    if (!prev) return;
    const added = members.filter((m) => !prev.includes(m));
    const left = prev.filter((m) => !members.includes(m));
    if (soundsOn.current && session.current && (added.length || left.length)) void nativeCall("dictation.chime", { sessionId: session.current, kind: added.length ? "join" : "leave" }).catch(() => {});
    // Bug 158: a Bot coming off the call is confirmed out loud, whoever took it off (a spoken command,
    // the ×, the menu, or another Bot) — the leave sound above, then one short line in a Bot still here.
    for (const m of left) {
      const last = lastSpeakerRef.current;
      const who = last && members.includes(last) ? last : members[0];
      if (who) void loop.say(who, STRV.botLeftCall(nameRef.current(m)), "notice");
    }
    // A Bot joining mid-call says a short hello in its own voice.
    for (const m of added) {
      const say = () => { const t = takeGreeting(m, greetingsFor(m), { joining: true }); if (t) void loop.say(m, t, "greeting"); };
      if (greetings.current[m]?.length) say();
      else setTimeout(say, 400);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, memberKey]);
  // The palette's "call A and B" while this call is open: they join it.
  const adding = useVoice((s) => s.adding);
  useEffect(() => {
    if (!active || !callView || !adding.length) return;
    addBotsRef.current(useVoice.getState().takeAdding().filter((id) => !membersRef.current.includes(id)));
  }, [active, callView, adding]);
  // Pre-render once the call's voices are known (Kokoro ready, voices assigned).
  useEffect(() => {
    if (active) preparePhrases(members);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, memberKey, natural, voiceList]);

  // The reply as it streams (typing), for every Bot in the call: spoken sentence by sentence.
  useEffect(() => {
    if (!active) return;
    for (const m of members) loop.onBotStream(m, typing[m]?.typing ? typing[m]!.partialText ?? null : null);
    setState(loop.state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing, active, loop, memberKey]);

  // Final messages (only what the stream didn't already say is spoken), and approvals in the call.
  useEffect(() => {
    if (!active) return;
    for (const e of entries) {
      if (seen.current.has(e.id)) continue;
      seen.current.add(e.id);
      if (e.kind !== "send-message") continue;
      const who = e.author?.id ?? botId;
      // Bug 142: on a fast-path call only the Bot's voice speaks ("vf_" replies); the full session's own messages
      // land in the chat and reach the call through the voice.
      const quiet = callViewRef.current?.fastPath === true && !e.requestId.startsWith("vf_");
      // A reply the loop can speak also clears a stale fault line (e.g. a slow turn that had
      // already timed out): the call is plainly working again.
      if (e.message.type === "text" && !quiet) { setFault(null); loop.onBotText(e.message.content, who, e.id); }
      // Bug 142: a pending card is read aloud as a short question (who gets what); a plain yes / no answers it.
      if (e.message.type === "auto-review-approval" && e.message.approval.status === "pending") {
        pendingApprovalRef.current = { botId: who, approvalId: e.message.approval.approvalId };
        loop.onBotText(approvalQuestion(e.message.approval.summary || e.message.approval.title), who);
      }
    }
    setState(loop.state);
  }, [entries, active, loop, botId]);
  const approvals = useMemo(() => {
    const out: ApprovalCardView[] = [];
    for (const e of entries) if (e.kind === "send-message" && e.message.type === "auto-review-approval" && e.message.approval.status === "pending") out.push(e.message.approval);
    return out.slice(-2);
  }, [entries]);

  // ---- Dialog behaviour (UI audit): Escape closes, focus is trapped and handed back, a click on
  // the covered chat ends the call — what <Dialog>/useOverlayLayer do for every surface.
  const panel = useRef<HTMLDivElement>(null);
  // Bug 134 (item 10): in another chat the call shrinks to a pill; the full screen is in the call's chat.
  const slot = useCallSlot();
  const uiView = useUi((s) => s.view);
  const away = uiView.kind === "new-chat" || (uiView.kind === "chat" && uiView.botId !== botId);
  useOverlayLayer({ active: active && !away, onClose: close, panelRef: panel });
  // Bug 158: "Remove from call" by right-click / long press, on the avatar row (removeBot is defined below).
  const removeRef = useRef<(id: string) => void>(() => {});
  const memberMenu = useCallMemberMenu((id) => removeRef.current(id));

  if (!active || !bot) return null;
  const view = muted ? "muted" : state === "thinking" ? "thinking" : state === "speaking" ? "speaking" : "listening";
  const label = wrapping ? STRV.wrappingUp : { muted: STR5.voiceMuted, thinking: STR5.voiceThinking, speaking: STR5.speaking, listening: STR5.listening }[view];
  // Choosing a device mid-call saves it and the main process hands it to the running helper, which
  // rebuilds its audio path in place: the call (and the recognizer) keeps going.
  const pickDevice = (kind: DeviceKind, value: string) => void audio.choose(kind, value || null);
  const toggleMute = () => { const m = !muted; setMuted(m); if (m) setHeard(""); loop.setMuted(m); };
  // Bug 108: adding and removing is the call's (the host enforces the cap of 6); an older host
  // without calls changes a group's members, as before, and a 1:1 call can't take more Bots.
  const setMembers = (ids: string[]) => void call("setGroupMembers", { id: botId, memberIds: ids }).catch(() => {});
  const canAdd = Boolean(callView) || isGroupChat;
  // Bug 134: by voice, a refusal (the call is full, the Bot you called can't leave) is said, not only shown.
  const refuse = (message: string) => { setNotice(message); const who = lastSpeakerRef.current ?? (isGroupChat ? members[0] : botId); if (who) void loop.say(who, message, "notice"); };
  const addBot = (id: string, byVoice = false) => {
    if (!callView) return setMembers([...members, id]);
    if (byVoice) { void callQuiet("addToCall", { callId: callView.callId, botId: id }).then((v) => { if (v?.callId) setCallView(v); }, (e: unknown) => refuse(e instanceof Error ? e.message : STR5.callFull)); return; }
    void call("addToCall", { callId: callView.callId, botId: id }).then((v) => { if (v?.callId) setCallView(v); }, () => {});
  };
  /** Several Bots by voice, in order: each add waits for the one before, so the roster never goes back a step. */
  const addBots = (ids: string[]) => {
    const cv = callViewRef.current;
    if (!cv) { if (ids.length) setMembers([...membersRef.current, ...ids]); return; }
    void ids.reduce<Promise<unknown>>((p, id) => p.then(() => callQuiet("addToCall", { callId: cv.callId, botId: id })
      .then((v) => { if (v?.callId) setCallView(v); }, (e: unknown) => refuse(e instanceof Error ? e.message : STR5.callFull))), Promise.resolve());
  };
  addBotsRef.current = addBots;
  // The Bot the call started with can't be taken off it (the host refuses too): hang up instead.
  const anchorId = callView ? callView.anchorId : isGroupChat ? null : botId;
  const removable = (id: string) => (callView ? id !== callView.anchorId && members.length > 1 : isGroupChat && members.length > 2);
  const removeBot = (id: string, byVoice = false) => {
    if (!callView) return setMembers(members.filter((x) => x !== id));
    if (byVoice) { void callQuiet("removeFromCall", { callId: callView.callId, botId: id }).then((v) => { if (v?.callId) setCallView(v); }, (e: unknown) => refuse(e instanceof Error ? e.message : "")); return; }
    void call("removeFromCall", { callId: callView.callId, botId: id }).then((v) => { if (v?.callId) setCallView(v); }, () => {});
  };
  removeRef.current = (id) => removeBot(id);
  // Bug 134: "call Nova", "bring in Nova", "hang up on Nova"… — matched in code, never sent as a turn.
  interceptPreviewRef.current = (t) => {
    if (wrappingRef.current) return true;
    if (pendingApprovalRef.current && approvalAnswer(t)) return true;
    if (!callViewRef.current) return false;
    const all = Object.values(useUi.getState().bots).filter((b) => !b.group && !b.archived).map((b) => ({ id: b.id, name: b.profile.name }));
    return parseCallCommand(t, all, membersRef.current) !== null;
  };
  interceptRef.current = (t) => {
    if (wrappingRef.current) return true;
    // Bug 142: a plain yes / no to the pending card, matched in code (never a turn). Anything else goes on as a
    // turn, and on a fast-path call the Bot's voice sees the card and can change it.
    const pa = pendingApprovalRef.current;
    const card = pa ? approvals.find((x) => x.approvalId === pa.approvalId && x.status === "pending") : undefined;
    const answer = pa && card ? approvalAnswer(t) : null;
    if (pa && answer) {
      pendingApprovalRef.current = null;
      void call("resolveAutoReviewApproval", { id: pa.botId, approvalId: pa.approvalId, choice: answer === "yes" ? "once" : "deny" }).catch(() => {});
      void loop.say(pa.botId, answer === "yes" ? STRV.approvalYes : STRV.approvalNo, "notice");
      return true;
    }
    if (!callViewRef.current) return false;
    const all = Object.values(useUi.getState().bots).filter((b) => !b.group && !b.archived).map((b) => ({ id: b.id, name: b.profile.name }));
    const cmd = parseCallCommand(t, all, membersRef.current);
    if (!cmd) return false;
    // Phase 2 (bug 213): "bring in Scout and Otto" — every name in one utterance. Clear ones go at once
    // (one after another, so each answer carries the one before); an ambiguous one asks on screen.
    const names = [{ heard: cmd.heard, matches: cmd.matches }, ...(cmd.also ?? [])];
    const clear = [...new Set(names.filter((n) => n.matches.length === 1).map((n) => n.matches[0]!))];
    const missing = names.find((n) => !n.matches.length);
    const unclear = names.find((n) => n.matches.length > 1);
    if (cmd.kind === "add") addBots(clear.filter((id) => !membersRef.current.includes(id)));
    else for (const id of clear) removeBot(id, true);
    if (missing) refuse(STRV.noBotCalled(missing.heard));
    else if (unclear) setPick({ kind: cmd.kind, ids: unclear.matches });
    return true;
  };
  // Bug 134 (item 4): hang up = a one-line wrap-up in the Bot's voice when the call had substance (one
  // short helper call; a stock goodbye if it isn't back in 4 s), then the call ends. Press again to end now.
  const hangUp = () => {
    if (wrappingRef.current) return close();
    const cid = callIdRef.current;
    const durationMs = Date.now() - startedAtRef.current;
    if (!cid || durationMs < CALL_FEEL.wrapUpMinMs) return close();
    wrappingRef.current = true;
    setWrapping(true);
    void callQuiet("endCall", { callId: cid, durationMs }).catch(() => {});
    const late = new Promise<null>((r) => setTimeout(() => r(null), CALL_FEEL.wrapUpLineWaitMs));
    const asked = callQuiet("wrapUpCall", { callId: cid, durationMs }).catch(() => ({ line: null } as { line: string | null; botId?: string }));
    void Promise.race([asked, late]).then(async (r) => {
      if (!wrappingRef.current) return;
      const who = r?.botId && membersRef.current.includes(r.botId) ? r.botId : lastSpeakerRef.current ?? (isGroupChat ? membersRef.current[0] : botId);
      const line = r === null ? STRV.goodbyes[Math.floor(Math.random() * STRV.goodbyes.length)]! : r.line;
      if (line && who) await Promise.race([loop.say(who, line, "wrap-up"), new Promise((res) => setTimeout(res, 15_000))]);
      if (wrappingRef.current) close();
    });
  };
  const addMenu = canAdd ? <CallAddMenu bots={bots} onCall={callView ? members : [...members, botId]} onPick={addBot} /> : null;
  // The speaking Bot's avatar moves with its voice (a spring, not a jump): the halo swells and the
  // mouth opens with the output level; while the call is thinking, the face thinks too.
  const talking = (id: string) => state === "speaking" && (speaker === id || (!isGroup && id === botId));
  const pulse = (id: string) => (talking(id) ? 1 + Math.min(outLevel, 100) / 250 : 1);
  const halo = (id: string) => <span className="call-halo" aria-hidden="true" style={{ ["--level" as string]: String(pulse(id)) }} />;
  const avatar = (id: string, size: number) => {
    const b = bots[id] ?? bot;
    return <ShapeAvatar shape={b.profile.avatarShape} color={b.profile.avatarColor} size={size} seedKey={id}
      presence={view === "thinking" && (!isGroup || id === speaker) ? "thinking" : "idle"} speakingLevel={talking(id) ? Math.min(outLevel, 100) / 100 : null} listening={view === "listening"}
      // Bug 232: listeners glance at the speaker's seat; the avatar joins the living bus (touch, the nod, hand-offs).
      look={isGroup && state === "speaking" ? seatGlance(seatOrder, speaker, id) : null} living={id} />;
  };
  if (away) {
    return (
      <MiniCall bots={seatOrder.map((m) => bots[m]).filter((b): b is NonNullable<typeof b> => Boolean(b))} speaking={state === "speaking" ? speaker : null}
        muted={muted} timer={STR5.callTimer(now - startedAt)} chatName={bot.profile.name}
        anchorId={anchorId} removable={removable} onRemove={(id) => removeBot(id)}
        onReturn={() => void useUi.getState().openBot(botId)} onMute={toggleMute} onHangUp={hangUp} />
    );
  }
  const screenEl = (
    <div className="voice-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={STR5.startVoiceChat} className="voice-overlay call-screen" data-state={fault ? "fault" : view}>
        <button type="button" className="icon-btn voice-close" aria-label="Close voice chat" onClick={close}><CloseIcon /></button>
        <span className="call-timer" data-testid="call-timer">{STR5.callTimer(now - startedAt)}</span>
        {isGroup ? (
          <div className="call-members" role="list" aria-label={STR5.callParticipants}>
            {seatOrder.map((m) => (
              <div key={m} role="listitem" className="call-member" data-speaking={state === "speaking" && speaker === m} aria-label={nameOf(m)}
                // Bug 158: the anchor shows no dead × — its avatar says why it stays, and it has no menu.
                title={removable(m) ? undefined : anchorId === m ? STR5.callCantRemoveAnchor(nameOf(m)) : undefined}
                {...memberMenu.triggerProps({ id: m, name: nameOf(m) }, removable(m))}>
                <div className="voice-avatar">{halo(m)}{avatar(m, 64)}{hands.some((h) => h.botId === m) && <RaisedHand name={nameOf(m)} onGoAhead={() => loop.goAhead(m)} />}</div>
                <span className="call-member-name">{nameOf(m)}</span>
                {removable(m) && <button type="button" className="icon-btn call-member-remove" aria-label={STR5.callRemoveBot(nameOf(m))} title={STR5.callRemoveBot(nameOf(m))}
                  {...memberMenu.triggerProps({ id: m, name: nameOf(m) }, true)} onClick={() => removeBot(m)}><CloseIcon size={11} /></button>}
              </div>
            ))}
            {addMenu}
            {memberMenu.element}
          </div>
        ) : (
          <div className="call-members call-solo">
            <div className="voice-avatar">{halo(botId)}{avatar(botId, 120)}</div>
            {addMenu}
          </div>
        )}
        {fault
          ? <>
              <span className="voice-state voice-fault" role="alert">{fault}</span>
              {faultPane && <PrivacySettingsButton pane={faultPane} />}
            </>
          : <span className="voice-state" data-testid="voice-state" aria-live="polite">{label}</span>}
        <CallMeter level={mic} muted={muted} label={STR5.callMicLevel} />
        <div className="call-captions" aria-label={STR5.callCaptions} aria-live="polite">
          {captions.map((c, i) => <p key={i} className="call-caption"><b>{c.who}</b> {c.text}</p>)}
        </div>
        <span className="voice-heard" data-testid="voice-heard" aria-hidden={!heard}>{view === "listening" ? heard : ""}</span>
        {pick && <CallPicker kind={pick.kind} options={pick.ids.map((id) => ({ id, name: nameOf(id) }))}
          onPick={(id) => { const k = pick.kind; setPick(null); if (k === "add") addBot(id, true); else removeBot(id, true); }} onDismiss={() => setPick(null)} />}
        {approvals.length > 0 && <div className="call-approvals">{approvals.map((a) => <ApprovalCard key={a.approvalId} botId={botId} approval={a} />)}</div>}
        <div className="voice-controls">
          <button type="button" className={muted ? "round-btn dark" : "round-btn"} aria-pressed={muted}
            aria-label={muted ? STR5.voiceUnmute : STR5.voiceMute} onClick={toggleMute}>{muted ? <MicOffIcon /> : <MicIcon />}</button>
          <button type="button" className="round-btn" aria-label={STR5.audioDevices} aria-expanded={devicesOpen} aria-controls="voice-devices"
            onClick={() => setDevicesOpen((o) => !o)}><GearIcon /></button>
          <button type="button" className={sharing ? "round-btn dark" : "round-btn"} aria-pressed={sharing}
            aria-label={sharing ? STRV.stopSharing : STRV.shareScreen} title={sharing ? STRV.stopSharing : STRV.shareScreen} onClick={() => setShare(!sharing)}><ScreenShareIcon /></button>
          <button type="button" className="round-btn hang-up" aria-label={STR5.endVoiceChat} title={STR5.endVoiceChat} onClick={hangUp}><HangUpIcon /></button>
        </div>
        {devicesOpen && (
          <div id="voice-devices" className="voice-devices">
            {(["input", "output"] as const).map((kind) => (
              <select key={kind} className="dropdown" aria-label={kind === "input" ? STR5.microphone : STR5.speaker} value={audio.prefs[kind] ?? ""} onChange={(e) => pickDevice(kind, e.target.value)}>
                {deviceOptions(audio.devices, kind, audio.prefs[kind]).map((o) => <option key={o.value || "default"} value={o.value}>{o.label}</option>)}
              </select>
            ))}
          </div>
        )}
        {notice && <span className="voice-notice" role="status">{notice}</span>}
        {sharing && <span className="voice-notice call-sharing" role="status" data-testid="call-sharing">{isGroup ? STRV.sharingScreenRoom : STRV.sharingScreen(nameOf(botId))}</span>}
        {snapAt > 0 && <span className="voice-notice call-snap" role="status" data-testid="call-snap"><CheckIcon /> {STRV.snapshotSent}</span>}
        {lookAsked && !sharing && !isGroup && <span className="voice-notice" role="status" data-testid="call-look-ask">{STRV.botWantsToLook(nameOf(botId))}</span>}
        {shareIssue && (
          <>
            <span className="voice-notice" role="alert">{shareIssue.text}</span>
            {shareIssue.pane && <PrivacySettingsButton pane={shareIssue.pane} />}
          </>
        )}
      </div>
    </div>
  );
  return slot.el && slot.botId === botId ? createPortal(screenEl, slot.el) : screenEl;
}
