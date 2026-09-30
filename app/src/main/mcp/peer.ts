import { execFile, spawn } from "node:child_process";
import type { Socket } from "node:net";

/** Who is on the other end of a Unix socket, read from the kernel, never from anything the peer sent. */
export interface PeerCred { uid: number; pid: number }
export type PeerLookup = (sock: Socket) => Promise<PeerCred>;

/**
 * 0.1.4 — macOS's getsockopt(SOL_LOCAL, LOCAL_PEERCRED) (a struct xucred: version, uid, …) and LOCAL_PEERPID. Node
 * has no binding for either, so the accepted socket is shared with /usr/bin/perl (part of macOS) as fd 3 for the
 * one call. ~10 ms, once per connection. Node pauses a socket it shares as stdio: the caller resumes it.
 */
const SCRIPT = 'open(my $s, "+<&=3") or exit 2; my $c = getsockopt($s, 0, 1); defined $c or exit 3; my $p = getsockopt($s, 0, 2); defined $p or exit 4; my (undef, $u) = unpack("I I", $c); my ($pid) = unpack("i", $p); print "$u $pid\\n";';

export const kernelPeer: PeerLookup = (sock) => new Promise((resolve, reject) => {
  const c = spawn("/usr/bin/perl", ["-e", SCRIPT], { stdio: ["ignore", "pipe", "ignore", sock], env: {} });
  let out = "";
  const t = setTimeout(() => { c.kill(); reject(new Error("peer check timed out")); }, 5_000);
  c.stdout!.on("data", (d: Buffer) => { out += String(d); });
  c.on("error", (e) => { clearTimeout(t); reject(e); });
  c.on("close", (code) => {
    clearTimeout(t);
    const m = /^(\d+) (\d+)\n$/.exec(out);
    if (code !== 0 || !m) return reject(new Error(`peer check failed (${code})`));
    resolve({ uid: Number(m[1]), pid: Number(m[2]) });
  });
});

const ps = (args: string[]) => new Promise<string>((resolve) => {
  execFile("/bin/ps", args, { timeout: 3_000, env: {} }, (e, so) => resolve(e ? "" : String(so).trim()));
});

/** The executable of the process that launched `pid` (the MCP client that started the helper), for the card. */
export async function launcherOf(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const ppid = Number(await ps(["-o", "ppid=", "-p", String(pid)]));
  if (!Number.isInteger(ppid) || ppid <= 1) return null;
  const exe = await ps(["-o", "comm=", "-p", String(ppid)]);
  return exe ? appPath(exe) : null;
}

/** "/Applications/Claude.app/Contents/MacOS/Claude" → "/Applications/Claude.app"; anything else as it is. */
export function appPath(exe: string): string {
  const i = exe.indexOf(".app/Contents/");
  return (i >= 0 ? exe.slice(0, i + 4) : exe).slice(0, 300);
}
