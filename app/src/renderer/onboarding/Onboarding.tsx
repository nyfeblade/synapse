import { useEffect, useMemo, useRef, useState } from "react";
import { STRSH, STR_AUTH, APP_NAME, AVATAR_COLOR_NAMES, AVATAR_COLORS, DEFAULT_AVATAR_COLOR, AVATAR_EDITOR_SHAPES, AVATAR_SHAPE_LABELS, STR, STR5, STRC, type AvatarShape, type StarterView } from "@synapse/shared";
import { useAsync } from "../async-resource";
import { call, callQuiet } from "../bridge";
import { Async } from "../components/Async";
import { ShapeAvatar } from "../components/ShapeAvatar";
import { AccountPanel } from "../components/settings/AccountSection";
import { ONBOARDING_TOOLS } from "./tools";
import { nativeCall } from "../native";
import { useTemplates } from "../templates/store";
import { noteIfSlow, SIGN_IN_TIMEOUT_MS } from "../within-time";
import mark from "../assets/synapse-mark.png";

type Step = "splash" | "setup" | "tour" | "tools" | "new-bot";

export function Onboarding({ onDone, initialStep = "splash", timeoutMs = SIGN_IN_TIMEOUT_MS }: {
  onDone(botId: string): void; initialStep?: Step;
  /** Tests only: how long the first button's ask may take before it fails with a plain line. */
  timeoutMs?: number;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [page, setPage] = useState(0);
  const [tokenOk, setTokenOk] = useState(false);
  const [q, setQ] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [shape, setShape] = useState<AvatarShape>("pebble");
  const [color, setColor] = useState<string>(DEFAULT_AVATAR_COLOR);
  // New-user walk, finding 5: a suggestion card selects a teammate (filling in the Bot below); Get started is the only commit.
  const [picked, setPicked] = useState<StarterView | null>(null);
  // Creating a Bot (or importing a starter) is a round trip: without a guard a second click before the first
  // one lands ran the whole thing again and left two Bots behind. A ref, because two clicks in the same tick
  // both read the pre-render state value.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const once = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  // callQuiet: a background probe for the Sign in button's destination; the button re-asks when it
  // is pressed, and that ask is the one whose failure the user is told about.
  useEffect(() => { void callQuiet("getOnboarding", {}).then((o) => setTokenOk(o.tokenConfigured)).catch(() => {}); }, []);
  // Was `.catch(() => {})` into an empty array: a failed starter list rendered as a carousel with a
  // heading and no cards, indistinguishable from a build that ships no starters.
  // callQuiet: the carousel presents this one itself, where the cards would have been.
  const starters = useAsync(() => callQuiet("listStarterTemplates", {}).then((r) => r.starters ?? []), []);
  const shown = useMemo(() => ONBOARDING_TOOLS.filter((t) => t.toLowerCase().includes(q.toLowerCase())), [q]);
  const finish = async (id: string) => {
    await call("completeOnboarding", {});
    void globalThis.Notification?.requestPermission?.().catch(() => {}); // ONB-06 (NTF-01 owns delivery)
    onDone(id);
  };
  const create = async () => {
    const { id } = await call("createAgent", { name: name.trim() || undefined, description: tools.length ? STR5.toolsAppend(tools) : undefined, avatarShape: shape, avatarColor: color, isKickstartRequested: true });
    await finish(id);
  };
  const meet = async (s: StarterView) => {
    const { token } = await call("previewTemplateImport", { starterId: s.id });
    const { id } = await call("importTemplate", { token });
    const edits = {
      ...(name.trim() && name.trim() !== s.name ? { name: name.trim() } : {}),
      ...(shape !== s.avatarShape ? { avatarShape: shape } : {}),
      ...(color !== s.avatarColor ? { avatarColor: color } : {}),
    };
    if (Object.keys(edits).length) await call("updateAgent", { id, ...edits });
    await finish(id);
  };
  // Bot sharing (no app installed yet): the website copied the Bot's link on Download. The clipboard is read only
  // here, on this click, and only a Bot link comes back; the Bot is added through the same confirm sheet, and adding
  // it finishes onboarding with it.
  const pasteLink = async () => {
    const { fragment } = await nativeCall<{ fragment: string | null }>("clipboard.botLink");
    if (!fragment) { setError(STRSH.noBotLink); return; }
    useTemplates.setState({ afterAdd: (id) => void once(() => finish(id)) });
    await useTemplates.getState().importShare(fragment, { now: true });
  };
  const pick = (s: StarterView) => {
    if (picked?.id === s.id) { setPicked(null); setName(""); setShape("pebble"); setColor(DEFAULT_AVATAR_COLOR); return; }
    setPicked(s);
    setName(s.name);
    setShape(s.avatarShape);
    setColor(s.avatarColor);
  };

  if (step === "splash") return (
    <main className="onb splash">
      <div className="onb-logo"><img src={mark} alt="" width={88} height={88} className="onb-mark" /><span className="wordmark">{APP_NAME}</span></div>
      <p className="tagline">{STR5.taglineLine1}<br />{STR5.taglineLine2}</p>
      {/* THE FIRST BUTTON IN THE APP, and a rejected getOnboarding made it do nothing whatsoever —
          no next screen, no message, no way to tell a slow box from a broken one. It now runs
          through `once`, which owns the busy guard and the error line below. */}
      <button type="button" className="pill-light" disabled={busy}
        onClick={() => void once(async () => { const o = await noteIfSlow(call("getOnboarding", {}), timeoutMs, () => setError(STR.hostTimeout)); setError(null); setStep(o.tokenConfigured || tokenOk ? "tour" : "setup"); })}>{STR5.signIn}</button>
      {error && <span className="error" role="alert">{error}</span>}
    </main>
  );
  if (step === "setup") return (
    <main className="onb">
      {/* First run: the Anthropic API key, the only sign-in. New-user walk, finding 17: one heading, no status line
          that never moved ("Starting your computer…"), and the panel without its "No API key saved yet". */}
      <h1>{STR_AUTH.firstRunTitle}</h1>
      <AccountPanel firstRun onReady={() => { setTokenOk(true); setStep("tour"); }} />
      <div className="onb-nav"><button type="button" className="btn-outline" onClick={() => setStep("splash")}>{STR5.back}</button></div>
    </main>
  );
  if (step === "tour") {
    const p = STR5.tourPages[page]!;
    return (
      <main className="onb"><h1>{STR5.meetApp}</h1>
        {/* An illustration of the composer, above the explanation: it read as a real input when it sat
            between the text and the buttons. */}
        <div className="fake-composer" aria-hidden="true"><span className="typing-text">{STR5.tourComposer}</span></div>
        <section aria-label={p.title} className="tour-page"><h2>{p.title}</h2><p>{p.body}</p></section>
        <div className="onb-dots" aria-hidden="true">{STR5.tourPages.map((t, i) => <i key={t.title} className={i === page ? "on" : ""} />)}</div>
        <div className="onb-nav">
          {page > 0 && <button type="button" className="btn-outline" onClick={() => setPage(page - 1)}>{STR5.back}</button>}
          <button type="button" className="btn-primary" onClick={() => (page < STR5.tourPages.length - 1 ? setPage(page + 1) : setStep("tools"))}>{STR5.next}</button>
        </div>
      </main>
    );
  }
  if (step === "tools") return (
    <main className="onb"><h1>{STR5.whatDoYouUse}</h1>
      <input type="search" aria-label={STR5.searchTools} placeholder={STR5.searchTools} className="text-input" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="tool-grid">
        {shown.map((t) => (
          <label key={t} className={tools.includes(t) ? "tool-cell on" : "tool-cell"}>
            <input type="checkbox" aria-label={t} checked={tools.includes(t)} onChange={() => setTools(tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t])} />{t}
          </label>
        ))}
      </div>
      {/* New-user walk, finding 18: an explicit way on with no tools picked. */}
      <div className="onb-nav"><button type="button" className="btn-secondary" onClick={() => setStep("tour")}>{STR5.back}</button><button type="button" className="btn-outline" onClick={() => { setTools([]); setStep("new-bot"); }}>{STRC.skip}</button><button type="button" className="btn-primary" onClick={() => setStep("new-bot")}>{STR5.next}</button></div>
    </main>
  );
  return (
    <main className="onb">
      {/* New-user walk, findings 5 and 19: a grid of six picks (no sideways scroller), each a radio that
          fills in the Bot below. The labelled region keeps the Async failure state inside it. */}
      <section aria-label={STR5.suggestions} className="onb-suggest">
        <h2>{STR5.meetTeammate}</h2>
        <Async resource={starters} label={STR5.suggestions}>{(list) => (
          <div role="radiogroup" aria-label={STR5.suggestions} className="starter-grid">
            {list.slice(0, 6).map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={picked?.id === s.id} aria-label={s.name} className="starter-card" disabled={busy} onClick={() => pick(s)}>
                <ShapeAvatar shape={s.avatarShape} color={s.avatarColor} size={32} still /><span className="starter-name">{s.name}</span><span className="muted">{s.blurb}</span>
                <span className="chips">{s.tools.map((t) => <span key={t} className="chip">{t}</span>)}</span>
              </button>
            ))}
          </div>
        )}</Async>
      </section>
      <h1>{picked ? picked.name : STR5.createYourOwn}</h1>
      <ShapeAvatar shape={shape} color={color} size={120} />
      <div role="radiogroup" aria-label="Color" className="onb-swatches">
        {AVATAR_COLORS.slice(1).map((c, i) => <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={AVATAR_COLOR_NAMES[i + 1]} className="onb-swatch" style={{ background: c }} onClick={() => setColor(c)} />)}
      </div>
      <div role="radiogroup" aria-label="Shape" className="shapes">
        {AVATAR_EDITOR_SHAPES.map((s) => <button key={s} type="button" role="radio" aria-checked={s === shape} aria-label={`${AVATAR_SHAPE_LABELS[s]} shape`} className="onb-shape" onClick={() => setShape(s)}><ShapeAvatar shape={s} color={color} size={28} still /></button>)}
      </div>
      <label htmlFor="onb-name">{STR.name}</label>
      <input id="onb-name" className="text-input" value={name} placeholder={STR.newBotName} onChange={(e) => setName(e.target.value)} />
      {error && <span className="error" role="alert">{error}</span>}
      <div className="onb-nav">
        <button type="button" className="btn-outline" disabled={busy} onClick={() => setStep("tools")}>{STR5.back}</button>
        <button type="button" className="btn-outline" disabled={busy} onClick={() => void once(pasteLink)}>{STRSH.pasteBotLink}</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void once(() => (picked ? meet(picked) : create()))}>{STR5.getStarted}</button>
      </div>
    </main>
  );
}
