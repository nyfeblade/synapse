import { STR5, STRV, type BotSummary } from "@synapse/shared";
import { ShapeAvatar } from "../components/ShapeAvatar";
import { CloseIcon, HangUpIcon, MicIcon, MicOffIcon } from "../components/Icons";
import { useCallMemberMenu } from "./CallMemberMenu";

/**
 * Bug 134 (item 10): the call, shrunk to a floating pill while the user is in another chat. It keeps
 * running (the microphone, the Bots' voices, the host's call); a click on the pill goes back to it.
 * Avatars of who is on the call, a speaking indicator, mute and hang up. Flat and opaque, like the rest.
 *
 * Bug 158: one Bot comes off the call from here too — an × on its avatar on hover or keyboard focus,
 * and the same right-click / long-press "Remove from call" menu the full call screen has. The Bot the
 * call started with (`anchorId`) has no × and says why in its tooltip.
 */
export function MiniCall(p: {
  bots: BotSummary[]; speaking: string | null; muted: boolean; timer: string; chatName: string;
  anchorId?: string | null; removable?(botId: string): boolean; onRemove?(botId: string): void;
  onReturn(): void; onMute(): void; onHangUp(): void;
}) {
  const menu = useCallMemberMenu((id) => p.onRemove?.(id));
  const removable = (id: string) => Boolean(p.onRemove && p.removable?.(id));
  return (
    <div className="mini-call" role="region" aria-label={STRV.miniCall} data-testid="mini-call">
      <span className="mini-call-avatars">
        {p.bots.slice(0, 3).map((b) => {
          const name = b.profile.name;
          const can = removable(b.id);
          return (
            <span key={b.id} className="mini-call-avatar" data-speaking={p.speaking === b.id}
              title={can || b.id !== p.anchorId ? name : STR5.callCantRemoveAnchor(name)} {...menu.triggerProps({ id: b.id, name }, can)}>
              <span aria-hidden="true">
                <ShapeAvatar shape={b.profile.avatarShape} color={b.profile.avatarColor} size={22} seedKey={b.id} speakingLevel={p.speaking === b.id ? 0.5 : null} />
              </span>
              {can && (
                <button type="button" className="chip-x mini-call-remove" aria-label={STR5.callRemoveBot(name)} title={STR5.callRemoveBot(name)}
                  onClick={() => p.onRemove!(b.id)}><CloseIcon size={9} /></button>
              )}
            </span>
          );
        })}
      </span>
      <button type="button" className="mini-call-return" aria-label={STRV.returnToCall(p.chatName)} title={STRV.returnToCall(p.chatName)} onClick={p.onReturn}>
        <span className="mini-call-text">
          <span className="mini-call-name">{p.chatName}</span>
          <span className="mini-call-timer">{p.timer}</span>
        </span>
        {p.speaking && <span className="mini-call-speaking" aria-label={STR5.speaking} />}
      </button>
      <button type="button" className={p.muted ? "round-btn dark" : "round-btn"} aria-pressed={p.muted}
        aria-label={p.muted ? STR5.voiceUnmute : STR5.voiceMute} title={p.muted ? STR5.voiceUnmute : STR5.voiceMute} onClick={p.onMute}>
        {p.muted ? <MicOffIcon  /> : <MicIcon  />}
      </button>
      <button type="button" className="round-btn hang-up" aria-label={STR5.endVoiceChat} title={STR5.endVoiceChat} onClick={p.onHangUp}>
        <HangUpIcon  />
      </button>
      {menu.element}
    </div>
  );
}
