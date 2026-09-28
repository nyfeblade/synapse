---
name: learn-from-demonstration
description: Use this right after a Teach a task recording finishes, to turn the user's demonstration into a reusable draft skill, rehearse it safely and hand it to the user for review.
metadata:
  managed: true
  source: managed
---
<<LEARN_FROM_DEMO_V1>>
The user just showed you how to do a task on your screen. The recording is in
{{sessionDir}}. Run TeachAnalyze on it first; it returns the step trace (trace.json) and
parameter candidates. Then write a reusable skill.

1. Read the user's goal in session.json. The skill must reach that result.
2. Decide the parameters: values that will be different next time (who, what, when, which
   file, how much) become parameters; labels, menus and fixed settings stay literal. A value
   the user named in their goal is always a parameter. Name parameters in snake_case, give
   each a type (string, date, email, number, file, choice, secret) and use the demonstrated
   value as the example (never for secrets).
3. Write the steps as instructions another run of you can follow on a changed page: name
   elements by their role and visible label, not by coordinates. After each step add
   "Expect:" with what should be on screen. Mark every step with an outside effect (send,
   submit, pay, delete, publish, share) as "⚠ Approval point".
4. Where the user paused or chose between options, write the decision rule you can infer,
   and if you can't infer it, write "Ask the user".
5. Save it with update_state target:"workflow" action:"write" using exactly this layout,
   with metadata.status: draft and metadata.parameters filled in:
   ## When to use / ## Inputs and access / ## Steps / ## Decision points / ## Validation /
   ## Output / ## Approval points / ## Failure handling
   Failure handling always includes: if a site blocks you, use request_box_help; if an
   element is missing, take a fresh snapshot and retry once, then ask the user.
6. SendMessage the skill as an attachment with a three-line summary (what it does, its
   parameters, its approval points), then a widget: "Test it on a safe example?" with
   options "Run a rehearsal" and "Not now".

## How to run this in this app

- {{sessionDir}} is the recording folder named in the message that woke you (read-only: the host owns it). Call TeachAnalyze with its session id (the folder name, `teach-…`). TeachAnalyze writes analysis.json and frames there; launch a watchVideo task as it tells you, and wait for that task to write trace.json in your work folder (/workspace/teach-sessions/<session id>, also named in the message; create it if it's missing) before drafting.
- Record `teachSession: <session id>` and `source: teach-a-task` in the skill's metadata, and `checkpoints:` with the number of steps.
- When the user picks "Run a rehearsal": launch mcp__bot__Task with subagent_type browserUse (computerUse if any step is on the desktop) with `rehearsal: true` and the example parameter values, and give it exactly this instruction, followed by the skill's steps: "REHEARSAL. Perform each step up to, but not including, the first step marked ⚠ Approval point. After each step, check its Expect line and record ok or mismatch with what you saw. Stop at the first approval point and report." Tell it to write `{steps: [{n, status: ok|mismatch|stopped_before_commit|skipped, observedUrl, note}]}` to rehearsal.json in your work folder (/workspace/teach-sessions/<session id>).
- When the rehearsal task finishes, call TeachReview with action "rehearsed" and the skill's path. Do what its result says: report the pass to the user, or revise the skill and rehearse again (at most two revisions), or ask the user.
- When the user accepts the skill, call TeachReview with action "accept". The skill is then live and routines can use it.
- If the recording can't be analyzed, fall back to asking the user to describe the task in writing and write the skill from their instructions and a completed run (TCH-05).
