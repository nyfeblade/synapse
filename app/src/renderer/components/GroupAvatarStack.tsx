import { useUi } from "../store";
import { ShapeAvatar } from "./ShapeAvatar";

/** Stacked member avatars. Sidebar cluster (size ≥ 36, Group.dc.html line 50) or header row (line 78). */
export function GroupAvatarStack({ memberIds, size, className }: { memberIds: string[]; size: number; className?: string }) {
  const bots = useUi((s) => s.bots);
  const ids = memberIds.slice(0, 3);
  const av = (id: string, px: number) => {
    const b = bots[id];
    return <ShapeAvatar shape={b?.profile.avatarShape ?? "pebble"} color={b?.profile.avatarColor ?? "#777777"} size={px} presence={b?.presence ?? "idle"} seedKey={id} />;
  };
  if (size >= 36) {
    const a = Math.round((size * 20) / 36);
    const pos = [{ left: 0, top: 0 }, { right: 0, top: Math.round((size * 4) / 36) }, { left: Math.round((size * 7) / 36), bottom: 0 }];
    return (
      <span className={["group-stack", "cluster", className].filter(Boolean).join(" ")} style={{ width: size, height: size }} aria-hidden="true">
        {ids.map((id, i) => <span key={id} className="avatar-ring" style={{ position: "absolute", ...pos[i] }}>{av(id, a)}</span>)}
      </span>
    );
  }
  return (
    <span className={["group-stack", "row-stack", className].filter(Boolean).join(" ")} aria-hidden="true">
      {ids.map((id, i) => <span key={id} className="avatar-ring" style={{ marginLeft: i === 0 ? 0 : -6 }}>{av(id, size)}</span>)}
    </span>
  );
}

/** One BotAvatar for the app (Phase 5's image avatars + Phase 4's group stacks): avatar/BotAvatar.tsx. */
export { BotAvatar } from "../avatar/BotAvatar";
