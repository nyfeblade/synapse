import { useEffect, useRef, useState } from "react";
import { DEFAULT_BOT_MODEL, STR, STR5, STRL, modelLabel } from "@synapse/shared";
import { call, GatewayCallError } from "../bridge";
import { BudgetAskCard } from "./BudgetAskCard";
import { composerState, useComposer, type PendingAttachment } from "../composer-store";
import { usePendingSends } from "../pending-sends";
import { useDictation } from "../voice/useDictation";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { MicIcon, SendIcon, StopIcon } from "./Icons";
import { useUi } from "../store";
import { extractMentions, mentionQuery, MentionPicker, useMentionNames } from "./MentionPicker";
import { PrivacySettingsButton } from "../voice/PrivacySettingsButton";
import { ReplyChip } from "./ReplyChip";
import { SkillChips, SkillPicker } from "./SkillPicker";

/** What this message will be answered with: the Bot's model and its permission mode, each opening the
 *  Bot's settings where it is changed. Data, not decoration — the look study's composer pills. */
function ModelModePills({ botId }: { botId: string }) {
  const bot = useUi((s) => s.bots[botId]);
  const setPanel = useUi((s) => s.setPanel);
  if (!bot || bot.group) return null;
  const model = modelLabel(bot.profile.model ?? DEFAULT_BOT_MODEL);
  const mode = { ask: STR5.permModeAsk, "accept-edits": STR5.permModeAcceptEdits, "full-auto": STR5.permModeFullAuto }[bot.settings.permMode ?? "ask"];
  return (
    <>
      <button type="button" className="composer-pill" onClick={() => setPanel("settings")}>{model}</button>
      <button type="button" className="composer-pill" onClick={() => setPanel("settings")}>{mode}</button>
    </>
  );
}

const DRAFT_KEY = (botId: string) => `draft:${botId}`;
const NO_ATTACHMENTS: PendingAttachment[] = [];

export function Composer({ botId, name, running }: { botId: string; name: string; running: boolean }) {
  const [text, setText] = useState(() => { try { return localStorage.getItem(DRAFT_KEY(botId)) ?? ""; } catch { return ""; } });
  const [error, setError] = useState<string | null>(null);
  const [budgetAsk, setBudgetAsk] = useState<string | null>(null);
  const textNow = useRef(text);
  textNow.current = text;
  const wrap = useRef<HTMLDivElement>(null);
  // Enter while an attachment is still uploading queues the send; it fires once *those* uploads
  // finish. It holds their uploadIds, not a bare flag, so that a row that is removed or fails is
  // never mistaken for "the upload finished" and used to fire a send the user can no longer see.
  const [queuedFor, setQueuedFor] = useState<string[] | null>(null);
  const attachments = useComposer((s) => s.byBot[botId]?.attachments ?? NO_ATTACHMENTS);
  const [caret, setCaret] = useState(0);
  // Escape dismisses a picker; typing a fresh query brings it back.
  const [dismissed, setDismissed] = useState<"skills" | "mentions" | null>(null);
  const names = useMentionNames();
  const mentionHit = mentionQuery(text, caret);
  const save = (v: string) => { setText(v); setDismissed(null); try { localStorage.setItem(DRAFT_KEY(botId), v); } catch { /* storage unavailable */ } };
  const pickMention = (n: string) => {
    const before = text.slice(0, caret).replace(/@[\p{L}\p{N} _-]{0,40}$/u, `@${n} `);
    save(before + text.slice(caret));
    setCaret(before.length);
  };
  // THE SEND (decisions.md, "send bloop"). Optimistic: the message's bubble goes into the transcript
  // (pending-sends.ts) and the composer clears in the same commit, before the call goes out, so the
  // text is never off screen and never held (the blink, bug #87, cannot come back). Sends do not wait
  // on each other: a second Enter sends a second message, which bloops in below the first.
  const send = async () => {
    const value = textNow.current.trim();
    const c = composerState(botId);
    const ready = c.attachments.filter((a) => a.ref);
    const pending = c.attachments.filter((a) => !a.ref && !a.error);
    if (pending.length) { setQueuedFor(pending.map((a) => a.uploadId)); return; }
    if (!value && !ready.length && !c.skillIds.length) return;
    setError(null);
    setBudgetAsk(null);
    const clientNonce = crypto.randomUUID();
    const mentions = extractMentions(value, names);
    usePendingSends.getState().add({
      nonce: clientNonce, botId, text: value, createdAt: Date.now(),
      attachments: ready.map((a) => ({ attachmentId: a.ref!.attachmentId, name: a.name, size: a.size, mime: a.mime })),
      ...(c.replyToId ? { replyToId: c.replyToId } : {}),
      ...(c.skillIds.length ? { skillIds: c.skillIds } : {}),
    });
    save("");
    textNow.current = "";
    // keepErrored: a file that failed to upload was never sent, so its chip stays for a retry
    // instead of vanishing along with the message that went without it.
    useComposer.getState().clear(botId, true);
    try {
      await call("sendPrompt", {
        id: botId, text: value, clientNonce,
        ...(ready.length ? { attachmentIds: ready.map((a) => a.ref!.attachmentId) } : {}),
        ...(c.replyToId ? { replyToId: c.replyToId } : {}),
        ...(c.skillIds.length ? { skillIds: c.skillIds } : {}),
        ...(mentions.length ? { mentions } : {}),
      });
    } catch (e) {
      // Nothing was sent: the bubble goes (no ghost), and the message comes back to the composer
      // (text, files, reply, skills) under the existing error, ready to retry.
      usePendingSends.getState().drop(botId, [clientNonce]);
      const typed = textNow.current.trim();
      save(typed ? `${value} ${typed}` : value);
      useComposer.getState().restore(botId, { attachments: ready, replyToId: c.replyToId, skillIds: c.skillIds, skillNames: c.skillNames });
      // cost-dashboard: a budget that asks first is a question, not a failure; the card resends on Continue.
      if (e instanceof GatewayCallError && e.code === "BUDGET_ASK") setBudgetAsk(e.message);
      else setError(e instanceof Error ? e.message : STR.statusUnavailable);
    }
  };
  useEffect(() => {
    if (!queuedFor) return;
    const rows = attachments.filter((a) => queuedFor.includes(a.uploadId));
    // A queued upload that was removed or failed cancels the send; it never triggers one.
    if (rows.length !== queuedFor.length || rows.some((a) => a.error)) { setQueuedFor(null); return; }
    if (rows.some((a) => !a.ref)) return; // still uploading
    setQueuedFor(null);
    void send();
    // send reads the latest text and composer store at call time, so it is not a dependency.
  }, [queuedFor, attachments]);
  const interrupt = async () => {
    try {
      await call("interruptAgent", { id: botId });
    } catch (e) {
      setError(e instanceof Error ? e.message : STR.statusUnavailable);
    }
  };
  const showSkillPicker = text.startsWith("/") && !text.slice(1).includes(" ") && dismissed !== "skills";
  // Bug 101: dictation writes into the composer AS you speak. The text typed before the mic was
  // pressed is kept; each partial replaces only the dictated tail after it, and the final stays
  // there unsent (a later utterance appends after it).
  const dictBase = useRef("");
  const withDictation = (t: string) => (dictBase.current.trim() ? `${dictBase.current.replace(/\s+$/, "")} ${t}` : t);
  const dict = useDictation((t) => { const v = withDictation(t); save(v); dictBase.current = v; }, (t) => save(withDictation(t)));
  const startDictation = () => { dictBase.current = text; dict.start(); };
  // Send is live once there is something to send: words, an uploaded file, or a chosen skill.
  const skillCount = useComposer((s) => s.byBot[botId]?.skillIds.length ?? 0);
  const canSend = Boolean(text.trim()) || attachments.some((a) => a.ref) || skillCount > 0;
  return (
    <div ref={wrap} className="composer-wrap">
      {budgetAsk && (
        <BudgetAskCard botId={botId} message={budgetAsk} onCancel={() => setBudgetAsk(null)}
          onContinue={async () => {
            try {
              await call("approveBudget", { botId });
            } catch {
              return; // reported by call(); the card stays so the user can try again
            }
            setBudgetAsk(null);
            void send();
          }} />
      )}
      {error && <span className="error" role="alert">{error}</span>}
      <ReplyChip botId={botId} />
      <SkillChips botId={botId} />
      <ComposerAttachments botId={botId} />
      {queuedFor && (
        <div className="chips-row" role="status">
          <span className="muted small">{STR.sendingAfterUpload}</span>
          <button type="button" className="link-btn" onClick={() => setQueuedFor(null)}>{STR.cancelSend}</button>
        </div>
      )}
      {showSkillPicker && (
        <SkillPicker botId={botId} query={text.slice(1)}
          onPick={(id, skillName) => { useComposer.getState().addSkill(botId, id, skillName); save(""); }}
          onClose={() => setDismissed("skills")} />
      )}
      {!showSkillPicker && mentionHit !== null && dismissed !== "mentions" && (
        <MentionPicker query={mentionHit} names={names} onPick={pickMention} onClose={() => setDismissed("mentions")} />
      )}
      <div className="composer">
        <textarea className="composer-input" rows={1} value={text} placeholder={STR.messagePlaceholder(name)} aria-label={STR.messagePlaceholder(name)}
          onChange={(e) => { save(e.target.value); setCaret(e.target.selectionStart); }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (e.defaultPrevented) return;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
          }} />
        {/* The look study's control row: what the message will be answered with on the left, and Send
            — the one accent in the conversation — on the right. */}
        <div className="composer-row">
          <ComposerPlusMenu botId={botId} />
          <ModelModePills botId={botId} />
          <span className="grow" />
          <button type="button" className={dict.listening ? "round-btn listening" : "round-btn"} aria-label={dict.listening ? STR5.stopVoiceInput : STR5.startVoiceInput}
            aria-pressed={dict.listening} onClick={() => (dict.listening ? dict.stop() : startDictation())}><MicIcon /></button>
          {/* UI polish pass (critique 3.3): Send and Stop share ONE slot. While the Bot runs and there
              is nothing to send, the slot is Stop; the moment there is something to send (a steer),
              it is Send again, and Stop comes back once that message is on its way. Not ready to
              send is a quiet grey block, not a faded copy of the full-ink button. */}
          {running && !canSend
            ? <button type="button" className="send-btn ready stop" aria-label={STR.stop} title={STR.stop} onClick={() => void interrupt()}><StopIcon /></button>
            : <button type="button" className={canSend ? "send-btn ready" : "send-btn"} aria-label={STRL.send} title={STRL.send} disabled={!canSend} onClick={() => void send()}><SendIcon /></button>}
        </div>
      </div>
      {dict.error && <span className="error" role="alert">{dict.error}</span>}
      {dict.notice && <span className="muted small dictation-notice" role="status">{dict.notice}</span>}
      {dict.error && dict.privacyPane && <PrivacySettingsButton pane={dict.privacyPane} />}
    </div>
  );
}
