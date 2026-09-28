// ---------- Per-Bot GitHub sign-in (bug-log 195) ----------
// A Bot's `gh` CLI signs in with GitHub's own browser device flow, run as the Bot's OS account on the box, so the
// login lands in that Bot's ~/.config/gh/hosts.yml. The token never leaves the Bot's home: none of these views or
// events carry it.

export const GITHUB_DEVICE_URL = "https://github.com/login/device";

/** gh's default login scopes, the only ones a Bot's sign-in may end up with (never workflow or admin:*). */
export const GITHUB_SCOPES = ["repo", "read:org", "gist"] as const;

/** How long a sign-in may wait for the user before the host gives up (GitHub's device codes last 15 minutes). */
export const GITHUB_SIGNIN_TIMEOUT_MS = 15 * 60_000;

export interface GitHubStatusView {
  signedIn: boolean;
  login: string | null;
  /** A sign-in waiting for the user, so a reopened panel shows the same code. */
  pending: { code: string; url: string } | null;
}

export type GitHubSignInEvent =
  | { botId: string; state: "waiting"; code: string; url: string }
  | { botId: string; state: "signed-in"; login: string | null }
  | { botId: string; state: "signed-out" }
  | { botId: string; state: "failed" | "expired"; reason: string };

export type GitHubSseEvent = { channel: "github"; payload: GitHubSignInEvent };

export const STRGH = {
  row: "GitHub",
  signIn: "Sign in",
  signOut: "Sign out",
  copy: "Copy",
  openGitHub: "Open GitHub",
  waiting: "Waiting for GitHub…",
  starting: "Starting…",
  tryAgain: "Try again",
  signedInAs: (login: string | null) => `${login ? `Signed in as ${login}` : "Signed in"} · push from ~/code`,
  expired: "The code expired before GitHub was approved.",
  failed: (reason: string) => `GitHub sign-in failed: ${reason}`,
  needsOwnAccount: "GitHub sign-in needs this Bot's own account on the box, which isn't set up yet.",
  noCode: "GitHub didn't return a sign-in code.",
  cancelled: "Sign-in was cancelled.",
  busy: "Stop the Bot's current work first.",
  cancelledByWork: "Sign-in cancelled because the Bot started working.",
  access: (scopes: readonly string[]) => `Access: ${scopes.join(", ")}`,
  unexpectedScopes: (extra: string[]) => `GitHub gave unexpected permissions (${extra.join(", ")}), so the sign-in was undone.`,
  scopesUnchecked: "Couldn't check the sign-in's permissions, so it was undone.",
};

declare module "./gateway" {
  interface GatewayCommands {
    getGitHubStatus: { args: { id: string }; result: GitHubStatusView };
    /** Starts GitHub's device flow as the Bot's own account; a new start cancels one still waiting. */
    startGitHubSignIn: { args: { id: string }; result: { code: string; url: string } };
    signOutGitHub: { args: { id: string }; result: GitHubStatusView };
  }
}
