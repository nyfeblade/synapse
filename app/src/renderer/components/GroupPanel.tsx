import { useState } from "react";
import { LIMITS, STR } from "@synapse/shared";
import { useUi } from "../store";
import { CollapseIcon, GearIcon, PlusIcon } from "./Icons";
import { Menu } from "./Menus";
import { GroupSettingsSheet } from "./GroupSettingsSheet";
import { ShapeAvatar } from "./ShapeAvatar";

/** Group right panel (GRP-02, Group.dc.html line 88): gear, close, "Members", + Add Member. */
export function GroupPanel({ groupId }: { groupId: string }) {
  const { bots, setPanel, openBot, setGroupMembers } = useUi();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  const group = bots[groupId];
  if (!group?.group) return null;
  const members = group.group.memberIds.filter((id) => bots[id]);
  const candidates = Object.values(bots).filter((b) => !b.group && !members.includes(b.id)).sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  const full = members.length >= LIMITS.groupMaxMembers;
  return (
    <aside aria-label="Conversation details" className="panel group-panel">
      <div className="panel-tools">
        <button type="button" className="icon-btn" aria-label={STR.groupSettings} onClick={() => setSheet(true)}><GearIcon /></button>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={() => setPanel("closed")}><CollapseIcon /></button>
      </div>
      <div className="panel-heading">{STR.members}</div>
      {/* `members` is already filtered to ids present in `bots` (above), so re-indexing here is safe —
          but it's resolved into a local once and reused instead of asserting on a second lookup, so a
          later refactor of `members` can't quietly turn this back into an unsafe assertion. */}
      {members.flatMap((id) => {
        const b = bots[id];
        if (!b) return [];
        return [(
          <a key={id} href="#" className="member-row" onClick={(e) => { e.preventDefault(); void openBot(id); }}>
            <ShapeAvatar shape={b.profile.avatarShape} color={b.profile.avatarColor} size={24} />
            <span>{b.profile.name}</span>
          </a>
        )];
      })}
      <button type="button" className="member-row add" disabled={full || candidates.length === 0} title={full ? STR.groupMembersRange : undefined}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); }}>
        <span className="add-ring"><PlusIcon /></span>{STR.addMember}
      </button>
      {menu && (
        <Menu label={STR.addMember} x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          items={candidates.map((b) => ({
            label: b.profile.name,
            // The client-side `full`/candidate guard above can still race a server-side check
            // (e.g. the member cap), so a host rejection here must surface like every other
            // action error rather than becoming a silent unhandled rejection.
            onSelect: () => {
              setGroupMembers(groupId, [...members, b.id]).catch((e) => {
                useUi.setState({ actionError: e instanceof Error ? e.message : String(e) });
              });
            },
          }))} />
      )}
      {sheet && <GroupSettingsSheet groupId={groupId} onClose={() => setSheet(false)} />}
    </aside>
  );
}
