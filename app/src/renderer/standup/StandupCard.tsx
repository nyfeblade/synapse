import { useState } from "react";
import { STRS, type StandupCard as Card } from "@synapse/shared";
import { BotAvatar } from "../components/GroupAvatarStack";
import { useUi } from "../store";
import { cancelSpeech } from "../voice/tts";
import { playStandup, useStandup } from "./store";

const when = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ms);
const said = (s: string) => s && s.toLowerCase() !== "nothing";

/** One "Team standup" card: a line per active Bot (did · blocked on · needs from you), idle Bots named at the end. */
export function StandupCard({ card }: { card: Card }) {
  const bots = useUi((s) => s.bots);
  const openBot = useUi((s) => s.openBot);
  const [playing, setPlaying] = useState(false);
  const running = useStandup((s) => s.running);
  const runNow = useStandup((s) => s.runNow);
  const play = () => {
    if (playing) { cancelSpeech(); setPlaying(false); return; }
    setPlaying(true);
    void playStandup(card).finally(() => setPlaying(false));
  };
  return (
    <section className="standup-card" aria-label={STRS.teamStandup}>
      <header className="standup-head">
        <span className="standup-title">{STRS.teamStandup}</span>
        <span className="muted">{when(card.scheduledFor)}{card.caughtUp ? ` · ${STRS.standupCaughtUp}` : ""}</span>
        <span style={{ flexGrow: 1 }} />
        {card.lines.length > 0 && (
          <button type="button" className="btn-outline small" aria-pressed={playing} onClick={play}>{playing ? "Stop" : STRS.standupPlay}</button>
        )}
      </header>
      {/* Bug 115: a failed standup says so, with Run now, instead of reading like a quiet morning. */}
      {card.error && (
        <p className="standup-error" role="alert">{card.error}</p>
      )}
      {card.error && (
        <button type="button" className="btn-outline small standup-retry" disabled={running} onClick={() => void runNow().catch(() => {})}>{STRS.standupRunNow}</button>
      )}
      {!card.error && card.lines.length === 0 && <p className="muted">{STRS.standupAllIdle}</p>}
      <ul className="standup-lines">
        {card.lines.map((l) => {
          const bot = bots[l.botId];
          return (
            <li key={l.botId} className="standup-line">
              <button type="button" className="standup-who" onClick={() => void openBot(l.botId)} disabled={!bot}>
                {bot && <BotAvatar bot={bot} size={20} />}
                <span className="standup-name">{bot?.profile.name ?? l.name}</span>
              </button>
              <span className="standup-text">
                <span>{l.did}</span>
                {said(l.blocked) && <span className="standup-flag">{STRS.standupBlocked}: {l.blocked}</span>}
                {said(l.needs) && <span className="standup-flag needs">{STRS.standupNeeds}: {l.needs}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {card.idle.length > 0 && <p className="muted standup-idle">{STRS.standupIdle(card.idle)}</p>}
    </section>
  );
}
