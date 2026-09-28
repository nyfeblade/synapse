import { useUi } from "../store";
import { ShapeAvatar } from "./ShapeAvatar";

/** CHAT-03 mini-avatars: 14 px shapes with a 1 px ring (16 pt), −4 px overlap, at most 3 — as Group.dc.html draws them. */
export function MiniAvatars({ ids, max = 3 }: { ids: string[]; max?: number }) {
  const bots = useUi((s) => s.bots);
  return (
    <span className="mini-avatars" aria-hidden="true">
      {ids.slice(0, max).map((id, i) => {
        const b = bots[id];
        return (
          <span key={id} className="mini-avatar" style={{ marginLeft: i === 0 ? 0 : -4 }}>
            <ShapeAvatar shape={b?.profile.avatarShape ?? "pebble"} color={b?.profile.avatarColor ?? "#777777"} size={14} presence={b?.presence ?? "idle"} seedKey={id} />
          </span>
        );
      })}
    </span>
  );
}
