import { useEffect, useState } from "react";
import { STR, type AvatarShape } from "@synapse/shared";
import { call } from "../bridge";
import { acceptAgent, useUi } from "../store";
import { AvatarEditor } from "./AvatarEditor";
import { Dialog } from "./Dialog";
import { CloseIcon } from "./Icons";
import { BotAvatar } from "./GroupAvatarStack";

/** GRP-02 gear: name, avatar and members. Membership rules (2–6, no groups) are enforced by the host; its message is shown inline. */
export function GroupSettingsSheet({ groupId, onClose }: { groupId: string; onClose(): void }) {
  const { bots, setGroupMembers } = useUi();
  const group = bots[groupId];
  // Hooks must run in the same order on every render, so they're called unconditionally, before the
  // "not found" guard below — see that guard's comment for why `group` can go missing mid-session.
  const [name, setName] = useState(group?.profile.name ?? "");
  const [picked, setPicked] = useState<string[]>(group?.group?.memberIds ?? []);
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The `!editingAvatar` predicate that used to live here is gone: the nested AvatarEditor pushes its
  // own layer, so Escape unwinds one at a time by construction rather than by this sheet knowing
  // which of its children happens to be open.

  // GroupPanel only mounts this sheet while its own `bots[groupId]` lookup resolves, but the sheet
  // stays open across store updates (it's gated by GroupPanel's local `sheet` state, not by the bots
  // map), so a real-time delete or removal could land while it's up. Fold quietly rather than assert
  // past a lookup that's gone stale — same class of bug as the Sidebar fix. (After the hooks above, so
  // hook call order/count never changes across renders.)
  if (!group) return null;

  const choices = Object.values(bots).filter((b) => !b.group).sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const saveAvatar = async (shape: AvatarShape, color: string) => {
    setEditingAvatar(false);
    const { agent } = await call("updateAgent", { id: groupId, avatarShape: shape, avatarColor: color });
    acceptAgent(agent);
  };
  const save = async () => {
    setError(null);
    // Fire the name update and the membership update as two independent requests (neither
    // depends on the other's result) rather than sequentially awaiting one before starting
    // the next, so both reach the host in the same tick.
    const tasks: Promise<unknown>[] = [];
    if (name.trim() && name.trim() !== group.profile.name) {
      tasks.push(call("updateAgent", { id: groupId, name: name.trim() }).then(({ agent }) => {
        acceptAgent(agent);
      }));
    }
    const current = group.group?.memberIds ?? [];
    const ordered = [...current.filter((id) => picked.includes(id)), ...picked.filter((id) => !current.includes(id))];
    if (ordered.join() !== current.join()) tasks.push(setGroupMembers(groupId, ordered));
    try {
      await Promise.all(tasks);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog label={STR.groupSettings} onClose={onClose} className="sheet">
      <>
        <div className="sheet-head">
          <span className="card-title">{STR.groupSettings}</span>
          <button type="button" className="icon-btn" aria-label={STR.close} onClick={onClose}><CloseIcon /></button>
        </div>
        {editingAvatar ? (
          <AvatarEditor botId={group.id} shape={group.profile.avatarShape} color={group.profile.avatarColor} hasImage={group.profile.avatarKind === "image"} allowShapes={false}
            onSave={(s, c) => void saveAvatar(s, c)} onCancel={() => setEditingAvatar(false)}
            onImageSaved={(agent) => { acceptAgent(agent); setEditingAvatar(false); }} />
        ) : (
          <button type="button" className="avatar-btn" aria-label={STR.setAvatar} onClick={() => setEditingAvatar(true)}><BotAvatar bot={group} size={52} /></button>
        )}
        <label className="field">
          <span>{STR.name}</span>
          <input type="text" aria-label={STR.name} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset className="field">
          <legend>{STR.members}</legend>
          {choices.map((b) => (
            <label key={b.id} className="check-row">
              <input type="checkbox" aria-label={b.profile.name} checked={picked.includes(b.id)} onChange={() => toggle(b.id)} />
              <span>{b.profile.name}</span>
            </label>
          ))}
        </fieldset>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="sheet-actions">
          <button type="button" className="btn-outline" onClick={onClose}>{STR.cancel}</button>
          <button type="button" className="btn-primary" onClick={() => void save()}>Save</button>
        </div>
      </>
    </Dialog>
  );
}
