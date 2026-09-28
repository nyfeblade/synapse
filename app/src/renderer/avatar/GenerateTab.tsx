import { useState } from "react";
import { STR5 } from "@synapse/shared";
import { call } from "../bridge";

export function GenerateTab({ botId, onPreview }: { botId: string; onPreview(p: { mime: string; bytesBase64: string }): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call("generateAgentAvatar", { id: botId, prompt: text.trim() });
      setSvg(r.svg);
      onPreview({ mime: "image/svg+xml", bytesBase64: btoa(unescape(encodeURIComponent(r.svg))) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="avatar-tab">
      <textarea aria-label={STR5.describeAvatar} placeholder={STR5.describeAvatar} className="text-area" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" className="btn-primary" aria-label={STR5.generate} disabled={!text.trim() || busy} onClick={() => void go()}>
        {busy ? STR5.generating : STR5.generate}
      </button>
      {svg && <img alt="" className="avatar-preview" src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} />}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}
