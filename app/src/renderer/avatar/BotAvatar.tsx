import { useEffect } from "react";
import type { BotSummary } from "@synapse/shared";
import { useKeyedState } from "../async-resource";
import { call } from "../bridge";
import { GroupAvatarStack } from "../components/GroupAvatarStack";
import { ShapeAvatar } from "../components/ShapeAvatar";
import { usePresenceClass } from "../presence-class";
import { loopInView } from "../ambient-pause";
import { currentActionLabel } from "./current-action";
import { useLiving } from "./use-living";

const cache = new Map<string, string>();

export function BotAvatar({ bot, size, className }: { bot: BotSummary; size: number; className?: string }) {
  const presence = usePresenceClass(bot.id, bot.presence);
  const label = currentActionLabel(bot); // bug #55: hover to see its current action
  const living = useLiving(bot); // bug 226: the work pose from the presence stream, and the one lead
  const cls = [presence, className].filter(Boolean).join(" ");
  const key = `${bot.id}:${bot.profile.avatarVersion ?? 0}`;
  // Bug #19's class again, and the one instance of it that is a face: `useState` runs its
  // initialiser once, so the header and chat title — one component instance whose `bot` prop
  // changes — kept showing the PREVIOUS Bot's picture for the new Bot until the new fetch landed,
  // and forever when it failed (the catch below is deliberately silent). Keyed to the cache entry
  // for THIS avatar version: a cached picture is still there on the first render (no flash), an
  // uncached one falls back to the shape avatar rather than to someone else's face.
  const [src, setSrc] = useKeyedState<string | null>(key, cache.get(key) ?? null);
  useEffect(() => {
    if (bot.profile.avatarKind !== "image" || cache.has(key)) return;
    void call("getAgentAvatar", { id: bot.id }).then((r) => {
      if (r.mime) {
        const url = `data:${r.mime};base64,${r.bytesBase64}`;
        cache.set(key, url);
        setSrc(url);
      }
    }).catch(() => {}); // host away: keep the shape avatar
  }, [key, bot.id, bot.profile.avatarKind]);
  // A picture the user set wins everywhere, groups included — the group branch used to short-circuit first,
  // so a group avatar the user uploaded or generated was stored but never shown anywhere in the app.
  if (bot.profile.avatarKind === "image" && src) {
    return <img ref={loopInView} src={src} alt="" width={size} height={size} title={label ?? undefined} className={["avatar-img", cls].join(" ")} style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
  }
  if (bot.group) return <GroupAvatarStack memberIds={bot.group.memberIds} size={size} className={cls} />; // Phase 4 group chats
  return <ShapeAvatar shape={bot.profile.avatarShape} color={bot.profile.avatarColor} size={size} className={cls} presence={bot.presence} seedKey={bot.id} label={label} clips={bot.profile.avatarAnimations} cue={bot.profile.avatarCue}
    act={living.act} lead={living.lead} living={bot.id} />;
}
