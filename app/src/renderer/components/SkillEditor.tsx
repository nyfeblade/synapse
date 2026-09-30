import { useState } from "react";
import { STR } from "@synapse/shared";

export function SkillEditor({ initial, onSave, onCancel }: { initial: { name: string; description: string; body: string }; onSave(v: { name: string; description: string; body: string }): Promise<void>; onCancel(): void }) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try { await onSave(v); } catch (e) { setError((e as Error).message); }
  };
  return (
    <form className="skill-editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="form-field"><span>{STR.name}</span><input type="text" className="text-input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={80} /></label>
      <label className="form-field"><span>{STR.description}</span><textarea className="text-input" rows={3} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} maxLength={1536} /></label>
      <label className="form-field grow"><span>Skill body (Markdown)</span><textarea className="text-input mono" rows={18} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} aria-label="Skill body (Markdown)" /></label>
      {error && <div role="alert" className="card-error">{error}</div>}
      <div className="card-actions"><button type="button" className="btn-secondary" onClick={onCancel}>{STR.cancel}</button><button type="submit" className="btn-primary">{STR.save}</button></div>
    </form>
  );
}
