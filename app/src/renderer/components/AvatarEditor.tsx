import { useLayoutEffect, useRef, useState } from "react";
import { AVATAR_COLOR_NAMES, AVATAR_COLORS, AVATAR_EDITOR_SHAPES, AVATAR_SHAPE_LABELS, STR, STR5, type AvatarShape, type BotSummary } from "@synapse/shared";
import { call } from "../bridge";
import { GenerateTab } from "../avatar/GenerateTab";
import { UploadTab } from "../avatar/UploadTab";
import { useOverlayLayer } from "./Dialog";
import { ShapeAvatar } from "./ShapeAvatar";

type Tab = "bot" | "generate" | "upload";
type Pending = { mime: string; bytesBase64: string } | null;
/** Local label: shared/src/strings.ts belongs to another track this cycle. */
const REMOVE_PHOTO = "Remove photo";

export function AvatarEditor({ botId, shape, color, hasImage, allowShapes = true, onSave, onImageSaved, onCancel }: {
  botId: string;
  shape: AvatarShape;
  color: string;
  hasImage: boolean;
  /** Groups render a stack of their members' avatars, so a shape/colour they can never show isn't offered. */
  allowShapes?: boolean;
  onSave(s: AvatarShape, c: string): void;
  onImageSaved(agent: BotSummary): void;
  onCancel(): void;
}) {
  const first: Tab = allowShapes ? "bot" : "generate";
  const [tab, setTab] = useState<Tab>(first);
  const [s, setS] = useState(shape);
  const [c, setC] = useState(color.toLowerCase());
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shapeChanged = s !== shape || c !== color.toLowerCase();
  const changed = shapeChanged || pending !== null;
  const ariaLabel = tab === "generate" ? "Edit avatar, Generate tab" : tab === "upload" ? "Edit avatar, Upload tab" : "Edit avatar";
  // The audit found this one already trapping correctly (16 consecutive stops inside) and restoring
  // its trigger; its only gap was focus-in, which the hook supplies. It renders INSIDE another sheet,
  // so it is the layer above: pushing it on the stack is what lets that sheet drop its `!editingAvatar`
  // predicate and still keep Escape unwinding one layer at a time.
  const panel = useRef<HTMLDivElement>(null);
  useOverlayLayer({ onClose: onCancel, panelRef: panel });

  // Reset sits beside Cancel and "Set avatar", so it reads as "undo my unsaved edits" — and that is all it does.
  // Deleting the stored picture is a separate, labelled action, because Cancel cannot bring the picture back.
  const reset = () => {
    setS(shape);
    setC(color.toLowerCase());
    setPending(null);
    setTab(first);
    setError(null);
  };

  const removePhoto = () => {
    setPending(null);
    setError(null);
    void call("clearAgentAvatar", { id: botId })
      .then((r) => onImageSaved(r.agent))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : STR.statusUnavailable));
  };

  const set = async () => {
    if (pending) {
      setBusy(true);
      setError(null);
      try {
        const r = await call("setAgentAvatarBytes", { id: botId, mime: pending.mime, bytesBase64: pending.bytesBase64 });
        onImageSaved(r.agent);
      } catch (e) {
        setError(e instanceof Error ? e.message : STR.statusUnavailable);
      } finally {
        setBusy(false);
      }
      return;
    }
    onSave(s, c);
  };

  return (
    <div ref={panel} role="dialog" aria-label={ariaLabel} tabIndex={-1} className="avatar-editor">
      <div role="tablist" aria-label="Avatar source" className="tabs">
        {allowShapes && <button type="button" role="tab" aria-selected={tab === "bot"} className={tab === "bot" ? "tab active" : "tab"} onClick={() => { setTab("bot"); setPending(null); }}>{STR5.avatarTabBot}</button>}
        <button type="button" role="tab" aria-selected={tab === "generate"} className={tab === "generate" ? "tab active" : "tab"} onClick={() => setTab("generate")}>{STR5.avatarTabGenerate}</button>
        <button type="button" role="tab" aria-selected={tab === "upload"} className={tab === "upload" ? "tab active" : "tab"} onClick={() => setTab("upload")}>{STR5.avatarTabUpload}</button>
        <span style={{ flexGrow: 1 }} />
        {hasImage && <button type="button" className="link-btn" onClick={removePhoto}>{REMOVE_PHOTO}</button>}
        <button type="button" className="link-btn" onClick={reset}>{STR.reset}</button>
      </div>
      {allowShapes && tab === "bot" && (
        <>
          <div className="avatar-live" aria-hidden="true">
            <ShapeAvatar shape={s} color={c} size={72} seedKey={botId} />
          </div>
          <div className="shape-grid">
            {AVATAR_EDITOR_SHAPES.map((x) => (
              <button key={x} type="button" aria-label={`${AVATAR_SHAPE_LABELS[x]} shape`} aria-pressed={x === s} className={x === s ? "shape-btn on" : "shape-btn"}
                onClick={() => { setS(x); setPending(null); }}>
                <ShapeAvatar shape={x} color={c} size={36} still />
              </button>
            ))}
          </div>
          <div className="swatches">
            {AVATAR_COLORS.map((x, i) => (
              <button key={x} type="button" aria-label={AVATAR_COLOR_NAMES[i]} aria-pressed={x === c} className={x === c ? "swatch on" : "swatch"} style={{ background: x }}
                onClick={() => { setC(x); setPending(null); }} />
            ))}
          </div>
        </>
      )}
      {tab === "generate" && <GenerateTab botId={botId} onPreview={setPending} />}
      {tab === "upload" && <UploadTab onPreview={setPending} />}
      {error && <span className="error" role="alert">{error}</span>}
      <div className="editor-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>{STR.cancel}</button>
        <button type="button" className="btn-primary" disabled={!changed || busy} onClick={() => void set()}>{STR.setAvatar}</button>
      </div>
    </div>
  );
}
