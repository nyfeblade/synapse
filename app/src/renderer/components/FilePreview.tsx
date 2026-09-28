import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import readXlsxFile from "read-excel-file";
import { STR } from "@synapse/shared";
import { loadFile, parseCsv, previewKind, previewMaxBytes } from "../file-loader";
import { languageName } from "../voice/speech-text";
import { CodeCardBody, sentenceCase } from "./CodeBlock";
import { Dialog } from "./Dialog";
import { CloseIcon } from "./Icons";

/** bug 198: a text-file attachment used to land here as a bare `<pre className="mono">` — no fold, no
 *  copy, no language label — the exact "code-like content with no card" this bug is about, and the
 *  one place in the renderer that can genuinely show hundreds of lines at once (a Bot's own stored
 *  reply tops out around 2.7k characters; an attached file has no such ceiling). Reuses bug 193's
 *  CodeCardBody instead of a second bespoke box, keyed off the file's own extension. */
function extLanguage(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return ext ? sentenceCase(languageName(ext) || ext) : "";
}

function Table({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows.slice(0, 501);
  return (
    <table className="preview-table">
      <thead><tr>{(head ?? []).map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
      <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}

type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; url?: string; text?: string; rows?: string[][]; tooLarge?: boolean };

export function FilePreview({ path, name, mime, onClose }: { path: string; name: string; mime: string; onClose(): void }) {
  const kind = previewKind(mime, name);
  // `null` meant "still reading" and every failure branch meant "read it and failed", but the
  // render only ever asked `state?.error` / `state?.rows` — so while the read was in flight, and
  // forever if it hung, the dialog body was empty with nothing to say the file was being fetched.
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = () => {
    setSaveError(null);
    window.synapse.saveFile({ path, name }).catch((e) => setSaveError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    let url: string | undefined;
    setState({ status: "loading" }); // a new file must not show the previous one's contents
    void (async () => {
      try {
        // Past the cap the loader hands back the first N bytes; rendering those as the file gave a
        // video that stops mid-way and a PDF that won't open, with nothing on screen to explain it.
        const { bytes, truncated } = await loadFile(path, previewMaxBytes(kind));
        if (truncated) { setState({ status: "ready", tooLarge: true }); return; }
        const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
        if (kind === "csv") setState({ status: "ready", rows: parseCsv(new TextDecoder().decode(bytes), mime.includes("tab") ? "\t" : ",") });
        else if (kind === "xlsx") setState({ status: "ready", rows: (await readXlsxFile(blob)).map((r) => r.map((c) => (c === null ? "" : String(c)))) });
        else if (kind === "markdown" || kind === "text" || kind === "html") setState({ status: "ready", text: new TextDecoder().decode(bytes) });
        else { url = URL.createObjectURL(blob); setState({ status: "ready", url }); }
      } catch (e) {
        setState({ status: "error", message: (e as Error).message });
      }
    })();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [path, mime, kind]);
  return (
    <Dialog label={name} onClose={onClose} className="modal preview">
      <>
        <header className="modal-head"><h2>{name}</h2>
          <button type="button" className="btn-outline" onClick={save}>{STR.save}</button>
          <button type="button" className="icon-btn" aria-label={STR.close} onClick={onClose}><CloseIcon /></button>
        </header>
        {saveError && <div role="alert" className="card-error">{saveError}</div>}
        <div className="preview-body">
          {state.status === "loading" && <p role="status" className="muted">{STR.loading}</p>}
          {state.status === "error" && <div role="alert" className="card-error">{state.message}</div>}
          {state.status === "ready" && (
            <>
              {state.tooLarge && <p className="muted preview-too-large">{STR.tooLargeToPreview}</p>}
              {state.rows && <Table rows={state.rows} />}
              {state.text !== undefined && kind === "markdown" && <div className="markdown"><Markdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]}>{state.text}</Markdown></div>}
              {state.text !== undefined && kind === "text" && <CodeCardBody language={extLanguage(name)} code={state.text} />}
              {state.text !== undefined && kind === "html" && <iframe title={name} sandbox="" srcDoc={state.text} className="preview-frame" />}
              {state.url && kind === "image" && <img src={state.url} alt={name} className="preview-img" />}
              {state.url && kind === "pdf" && <iframe title={name} src={state.url} className="preview-frame" />}
              {state.url && kind === "audio" && <audio controls src={state.url} />}
              {state.url && kind === "video" && <video controls src={state.url} className="preview-img" />}
            </>
          )}
        </div>
      </>
    </Dialog>
  );
}
