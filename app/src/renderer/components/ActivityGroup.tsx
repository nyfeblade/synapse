import { useRef, useState } from "react";
import { useExpandFlip } from "../flip";
import { loopInView } from "../ambient-pause";
import type { CSSProperties, ReactElement } from "react";
import { STR, type ActivityIcon } from "@synapse/shared";
import type { TranscriptItem } from "../transcript-items";
import { CalendarIcon, CheckIcon, ChevronDownIcon, EditIcon, FileIcon, GlobeIcon, MailIcon, SearchIcon, TerminalIcon, ThoughtIcon, ToolIcon } from "./Icons";
import { StepBodyView } from "./StepBody";

const ICON: Record<ActivityIcon, () => ReactElement> = {
  mail: () => <MailIcon />, calendar: () => <CalendarIcon />, terminal: () => <TerminalIcon />, file: () => <FileIcon />, edit: () => <EditIcon />,
  search: () => <SearchIcon />, globe: () => <GlobeIcon />, tool: () => <ToolIcon />, thought: () => <ThoughtIcon />,
};

/**
 * `ActivityIcon` is a compile-time claim about a string that arrives from the HOST at runtime, and
 * the two are updated independently — a host newer than this build sends an icon name that is not
 * in the map, `ICON[name]` is undefined, and `undefined()` threw straight through the transcript
 * and (before the root boundary) took the whole window down. Nobody can enforce "the host only
 * sends names this build knows" across two processes, so the renderer stops requiring it: an
 * unknown name draws the generic tool glyph, which is exactly what a step with no better icon
 * already draws.
 */
function iconFor(name: ActivityIcon): ReactElement {
  return (ICON[name] ?? ICON.tool)();
}

/** "Read [icon] 48 emails" rows (Main.dc.html); click expands to the CHAT-05 step list. */
export function ActivityGroup({ item }: { item: Extract<TranscriptItem, { kind: "activity" }> }) {
  const [open, setOpen] = useState(false);
  // bug 198: a step's body (a Read's file, a Bash's command+output, an Edit's diff) is lazy twice
  // over — the whole `ol.steps` list only exists once `open`, and within it, a given step's own body
  // only mounts once THAT row is expanded, so a 500-line Read never renders a single line until the
  // user asks for it, however many steps its turn has.
  const [expandedSteps, setExpandedSteps] = useState<ReadonlySet<string>>(new Set());
  const toggleStep = (id: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const ref = useRef<HTMLDivElement>(null);
  useExpandFlip(ref, open);
  return (
    <div ref={ref} className="activity">
      <button type="button" className="activity-rows" aria-expanded={open} aria-label={open ? "Hide steps" : "Show steps"} onClick={() => setOpen(!open)}>
        {/* Where the run stands, as one 14px mark: still going, or finished. The look study puts it
            at the head of the summary line, and it is the only colour the card carries. */}
        <span ref={item.running ? loopInView : undefined} className={`activity-mark ${item.running ? "running" : "done"}`} aria-hidden="true">
          {!item.running && <CheckIcon size={9} />}
        </span>
        <span className="activity-lines">
          {item.rows.map((r, i) => (
            <span key={i} ref={r.live ? loopInView : undefined} className={r.live ? "activity-row live" : "activity-row"}>
              {r.noun ? `${r.verb} ${r.count} ${r.noun}` : r.verb}
            </span>
          ))}
          {item.more > 0 && <span className="activity-row">{STR.moreSteps(item.more)}</span>}
        </span>
        <ChevronDownIcon className="activity-chev" />
      </button>
      {open && (
        <ol className="steps">
          {item.steps.map((s, i) => {
            if (!s.body) return <li key={s.id} className={`step ${s.status}`} style={{ "--i": i } as CSSProperties}>{iconFor(s.icon)} {s.step}</li>;
            const stepOpen = expandedSteps.has(s.id);
            return (
              <li key={s.id} className={`step ${s.status}`} style={{ "--i": i } as CSSProperties}>
                <button type="button" className="step-toggle" aria-expanded={stepOpen} onClick={() => toggleStep(s.id)}>
                  {iconFor(s.icon)} <span className="step-text">{s.step}</span>
                </button>
                {stepOpen && <StepBodyView body={s.body} />}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
