import type { SseHub } from "../gateway/sse-hub";
import { hostGuardedFetch } from "../net/guarded-fetch";
import type { CommandHandlers } from "../gateway/server";
import { GatewayError } from "../gateway/errors";
import { fetchSkillText, markdownToSkill } from "./import";
import type { SkillLibrary } from "./library";

export function publishSkills(hub: SseHub, library: SkillLibrary, botIds: string[]): void {
  hub.publish({ channel: "skills", payload: { workflows: library.views(botIds) } });
}

export function createSkillCommands(d: { library: SkillLibrary; botIds(): string[]; fetchFn?: typeof fetch }): CommandHandlers {
  const view = (id: string) => d.library.view(id, d.botIds());
  const need = (id: string) => {
    const r = d.library.read(id);
    if (!r) throw new GatewayError("NOT_FOUND", "No such skill.", 404);
    return r;
  };
  return {
    getWorkflows: () => ({ workflows: d.library.views(d.botIds()) }),
    getWorkflow: (a) => ({ workflow: view(a.workflowId), body: need(a.workflowId).file.body }),
    createWorkflow: (a) => ({ workflow: view(d.library.write({ name: a.name, description: a.description, body: a.body }).id) }),
    updateWorkflow: (a) => {
      const r = need(a.workflowId);
      d.library.write({ id: a.workflowId, name: a.name ?? r.file.name, description: a.description ?? r.file.description, body: a.body ?? r.file.body });
      return { workflow: view(a.workflowId) };
    },
    deleteWorkflow: (a) => {
      if (!d.library.remove(a.workflowId)) throw new GatewayError("NOT_FOUND", "No such skill.", 404);
      return {};
    },
    setAgentWorkflowEnabled: (a) => {
      need(a.workflowId);
      return { disabled: d.library.setEnabled(a.id, a.workflowId, Boolean(a.enabled)) };
    },
    importWorkflowText: (a) => {
      const s = markdownToSkill(a.markdown, a.name);
      return { workflow: view(d.library.write(s).id) };
    },
    importWorkflowUrl: async (a) => {
      // Bug 368: the URL is someone else's choice; the host fetches it through the guarded fetch (never the Mac or LAN).
      const text = await fetchSkillText(a.url, d.fetchFn ?? (hostGuardedFetch() as unknown as typeof fetch));
      const s = markdownToSkill(text, decodeURIComponent(a.url.split("/").pop() ?? "").replace(/\.md$/i, "") || "Imported skill");
      const existing = d.library.findBySource(a.url);
      return { workflow: view(d.library.write({ ...s, source: a.url, ...(existing ? { id: existing } : {}) }).id) };
    },
    importWorkflowFolder: (a) => {
      const main = a.files.find((f) => f.path === "SKILL.md") ?? a.files.find((f) => /\.md$/i.test(f.path));
      if (!main) throw new GatewayError("NO_SKILL_FILE", "The folder has no SKILL.md or Markdown file.");
      const { id } = d.library.write(markdownToSkill(main.text, a.name));
      for (const f of a.files) {
        if (f === main) continue;
        try {
          d.library.writeHelper(id, f.path, f.text);
        } catch (err) {
          // Only an unsafe relative path (../, absolute) is skipped; any other failure (e.g. a real
          // fs error like disk full or EACCES) must not be swallowed like an intentional skip.
          if (err instanceof GatewayError && err.code === "BAD_PATH") continue;
          throw err;
        }
      }
      return { workflow: view(id) };
    },
  };
}
