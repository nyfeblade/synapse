import { useMemo, useRef, useState } from "react";
import { STR, type DiffLine, type StepBody as StepBodyData } from "@synapse/shared";
import { languageName } from "../voice/speech-text";
import { useExpandFlip } from "../flip";
import { CodeCardBody, CodeFileCard, CopyButton, COLLAPSE_AFTER, COLLAPSE_TO, FILE_CARD_AFTER, RENDER_CAP, sentenceCase } from "./CodeBlock";

/**
 * bug 198: "like 500 lines of code were not in a box and 30 were." The 30 were a fenced block in a Bot
 * reply, boxed by bug 193's CodeBlock.tsx. No stored reply holds anywhere near 500 lines, so the
 * unboxed code was content the chat shows LIVE — a step's own Read/Write/Edit/Bash body
 * (ActivityGroup.tsx's `ol.steps` only ever carried a one-line summary, never a body). This file is
 * that body's presentation, reusing CodeBlock.tsx's card pieces rather than inventing a second look:
 * a Read/Write is the same `.code-card`/`.file-card` a fenced block gets, a Bash command and its
 * output are each their own code card (language "Shell" / "Output"), and an Edit is a diff card in
 * neutral greys only — no red/green, per the user's own instruction — an addition at full --ink, a
 * removal at --ink-faint with a strikethrough, both keeping their own +/- marker so the shape reads
 * without colour at all.
 */

function displayLanguage(raw: string): string {
  return raw ? sentenceCase(languageName(raw) || raw) : "";
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Read/Write: the same fold-at-18 code card a fenced block gets, or — past FILE_CARD_AFTER lines —
 *  the same file-row-with-inline-expand a long/named fenced block gets (bug 193's CodeFileCard). */
function FileBody({ path, language, content }: { path: string; language: string; content: string }) {
  const lineCount = useMemo(() => content.split("\n").length, [content]);
  const display = displayLanguage(language);
  if (lineCount > FILE_CARD_AFTER) return <CodeFileCard name={basename(path)} language={display} code={content} />;
  return <CodeCardBody language={display} code={content} />;
}

function diffText(diff: DiffLine[]): string {
  return diff.map((l) => `${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`).join("\n");
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return (
    <div className={`diff-line diff-${line.type}`}>
      <span className="diff-marker" aria-hidden="true">{marker}</span>
      <span>{line.text}</span>
    </div>
  );
}

/** Edit: a diff card, folding the same way a code card does (18 → 14, then RENDER_CAP past that) —
 *  neutral tones only, never a layout-property transition (interaction-states.test.ts), so expanding
 *  mounts fresh rows exactly like `.code-card-more` already does. */
function DiffCardBody({ diff }: { diff: DiffLine[] }) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useExpandFlip(ref, expanded || showAll);
  const long = diff.length > COLLAPSE_AFTER;
  const head = long ? diff.slice(0, COLLAPSE_TO) : diff;
  const restAll = long && expanded ? diff.slice(COLLAPSE_TO) : [];
  const capped = restAll.length > RENDER_CAP && !showAll;
  const rest = capped ? restAll.slice(0, RENDER_CAP) : restAll;
  return (
    <div ref={ref} className="code-card diff-card">
      <div className="code-card-head">
        <span className="code-card-lang">Diff</span>
        <CopyButton code={diffText(diff)} />
      </div>
      <div className={`code-card-body${long && !expanded ? " is-collapsed" : ""}`}>
        <div className="diff-lines">{head.map((l, i) => <DiffLineRow key={i} line={l} />)}</div>
        {long && expanded && <div className="diff-lines code-card-more">{rest.map((l, i) => <DiffLineRow key={i} line={l} />)}</div>}
      </div>
      {long && (
        // fix round 1, finding 7: same reset as CodeCardBody's toggle — collapsing also drops `showAll`.
        <button type="button" className="card-link code-card-toggle" onClick={() => { if (expanded) setShowAll(false); setExpanded((e) => !e); }}>
          {expanded ? STR.showLess : STR.showAllLines(diff.length)}
        </button>
      )}
      {expanded && capped && (
        <button type="button" className="card-link code-card-toggle" onClick={() => setShowAll(true)}>
          {STR.showMoreLines(restAll.length - RENDER_CAP)}
        </button>
      )}
    </div>
  );
}

/** The one component ActivityGroup mounts once a step with a body is expanded. */
export function StepBodyView({ body }: { body: StepBodyData }) {
  return (
    <div className="step-body">
      {(body.kind === "read" || body.kind === "write") && <FileBody path={body.path} language={body.language} content={body.content} />}
      {body.kind === "edit" && <DiffCardBody diff={body.diff} />}
      {body.kind === "command" && (
        <>
          <CodeCardBody language="Shell" code={body.command} />
          {body.output !== null && <CodeCardBody language="Output" code={body.output} />}
        </>
      )}
      {body.truncated && <div className="muted small step-body-note">{STR.stepBodyTruncated}</div>}
    </div>
  );
}
