/**
 * Round-3 security review: files a program writes through its own options (not redirects), for `writes:<path>`
 * signals. Outside /workspace the analyzer gives them the overwrite floor (F4), like any overwrite there.
 * git `--output`/`-O` (diff, log -p, show), `sort -o`/`--output`, find `-fprint`/`-fprint0`/`-fls`/`-fprintf`,
 * and tar extraction into `-C`/`--directory`.
 */
export function writeTargets(prog: string, args: string[]): string[] {
  const out: string[] = [];
  const longValue = (name: string) => {
    args.forEach((a, i) => {
      if (a === name && args[i + 1] !== undefined) out.push(args[i + 1] as string);
      else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
    });
  };
  if (prog === "git") {
    longValue("--output");
    args.forEach((a, i) => {
      const m = /^-[A-Za-z]*O(.*)$/.exec(a);
      if (!m || a.startsWith("--")) return;
      const v = m[1] || args[i + 1];
      if (v !== undefined) out.push(v);
    });
  }
  if (prog === "sort") {
    longValue("--output");
    longValue("--temporary-directory");
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (a === "--") break;
      if (!a.startsWith("-") || a.startsWith("--") || a === "-") continue;
      for (let k = 1; k < a.length; k++) {
        const c = a[k] as string;
        // Fix round 2: -T names the folder sort writes its temp files to.
        if (c === "T") { const v = a.slice(k + 1) || args[i + 1]; if (v !== undefined) out.push(v); if (k === a.length - 1) i++; break; }
        if ("ktS".includes(c)) { if (k === a.length - 1) i++; break; }
        if (c === "o") {
          const v = a.slice(k + 1) || args[i + 1];
          if (v !== undefined) out.push(v);
          if (k === a.length - 1) i++;
          break;
        }
      }
    }
  }
  if (prog === "find") {
    args.forEach((a, i) => {
      if (["-fprint", "-fprint0", "-fls", "-fprintf"].includes(a) && args[i + 1] !== undefined) out.push(args[i + 1] as string);
    });
  }
  if (prog === "tar") {
    const extract = tarExtracts(args);
    // An absolute-names extraction may write anywhere: `/` stands for its targets (outside the workspace: F4).
    if (tarAbsoluteExtract(args)) out.push("/");
    if (extract) {
      longValue("--directory");
      args.forEach((a, i) => {
        if (a === "-C" && args[i + 1] !== undefined) out.push(args[i + 1] as string);
        else if (/^-C./.test(a)) out.push(a.slice(2));
      });
    }
  }
  // speed-fastpath (security probe): an option VALUE that names where a program writes — `cp -t/etc x`,
  // `mv --target-directory=/etc x`, `curl -o/etc/foo URL`, `wget -O /etc/foo URL`, `wget -P /etc URL`.
  out.push(...optionWrites(prog, args).targets);
  return out;
}

interface OptTable {
  /** Boolean short letters. */
  flags: string;
  /** Short letters that take a value (attached or the next argument); `writes` ones name a written file/dir. */
  values: string;
  writes: string;
  /** Long options: boolean, value-taking, and value-taking ones that name a written file/dir. `--x=v` only for the latter two. */
  long: string[];
  longValues: string[];
  longWrites: string[];
  /** Long options whose value is optional (`--backup`, `--backup=numbered`). */
  longOptional?: string[];
}

/** Programs that write through an option; anything they pass that is not in their table is not understood. */
const OPTION_WRITERS: Record<string, OptTable> = {
  cp: { flags: "aAbdfHiIlLnPprRsuvxTZ", values: "St", writes: "t", long: ["--archive", "--attributes-only", "--force", "--interactive", "--link", "--dereference", "--no-clobber", "--no-dereference", "--parents", "--recursive", "--remove-destination", "--strip-trailing-slashes", "--symbolic-link", "--update", "--verbose", "--one-file-system", "--no-target-directory", "--debug", "--copy-contents"], longValues: ["--suffix", "--sparse", "--no-preserve"], longWrites: ["--target-directory"], longOptional: ["--backup", "--preserve", "--reflink", "--context", "--update"] },
  mv: { flags: "bfinuvTZ", values: "St", writes: "t", long: ["--force", "--interactive", "--no-clobber", "--strip-trailing-slashes", "--update", "--verbose", "--no-target-directory", "--context", "--debug", "--exchange", "--no-copy"], longValues: ["--suffix"], longWrites: ["--target-directory"], longOptional: ["--backup", "--update"] },
  ln: { flags: "bdFfinLPrsTv", values: "St", writes: "t", long: ["--directory", "--force", "--interactive", "--logical", "--no-dereference", "--physical", "--relative", "--symbolic", "--no-target-directory", "--verbose"], longValues: ["--suffix"], longWrites: ["--target-directory"], longOptional: ["--backup"] },
  install: { flags: "bcCdDpsTvZ", values: "gmoSt", writes: "t", long: ["--compare", "--directory", "--preserve-timestamps", "--strip", "--no-target-directory", "--verbose", "--debug"], longValues: ["--group", "--mode", "--owner", "--suffix", "--strip-program"], longWrites: ["--target-directory"], longOptional: ["--backup", "--context"] },
  curl: {
    flags: "0123456aBfgGiIjJkLlMnNpqRsSvVZ#:O",
    values: "AbcCdDeEFhHKmoPQrtTuUwxXYyz",
    writes: "ocD",
    long: ["--silent", "--show-error", "--fail", "--fail-with-body", "--location", "--insecure", "--verbose", "--include", "--head", "--get", "--compressed", "--remote-name", "--remote-name-all", "--remote-header-name", "--create-dirs", "--no-progress-meter", "--http1.1", "--http2", "--ipv4", "--ipv6", "--globoff", "--no-buffer", "--progress-bar", "--list-only", "--append", "--junk-session-cookies", "--location-trusted", "--no-keepalive", "--raw", "--tcp-nodelay", "--ssl-reqd", "--disable"],
    longValues: ["--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--header", "--request", "--user", "--user-agent", "--referer", "--cookie", "--form", "--form-string", "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--url", "--proxy", "--range", "--upload-file", "--json", "--write-out", "--config", "--cacert", "--capath", "--cert", "--key", "--resolve", "--limit-rate", "--max-filesize", "--oauth2-bearer", "--quote", "--time-cond", "--continue-at", "--interface", "--noproxy", "--variable", "--expand-url"],
    longWrites: ["--output", "--output-dir", "--dump-header", "--cookie-jar", "--trace", "--trace-ascii", "--stderr", "--libcurl", "--etag-save", "--hsts", "--alt-svc"],
  },
  wget: {
    flags: "qvnNcrkKpESLhHd46xmb",
    values: "OoaPtTUlADRQeiwBY",
    writes: "OoaP",
    long: ["--quiet", "--verbose", "--no-verbose", "--continue", "--timestamping", "--recursive", "--convert-links", "--page-requisites", "--no-check-certificate", "--mirror", "--no-parent", "--spider", "--server-response", "--no-clobber", "--content-disposition", "--show-progress", "--no-host-directories", "--force-directories", "--background", "--inet4-only", "--inet6-only"],
    longValues: ["--tries", "--timeout", "--user-agent", "--level", "--accept", "--reject", "--domains", "--header", "--post-data", "--method", "--body-data", "--user", "--password", "--wait", "--limit-rate", "--quota", "--execute", "--input-file", "--base", "--progress", "--referer", "--cut-dirs", "--max-redirect", "--ca-certificate", "--certificate", "--private-key"],
    longWrites: ["--output-document", "--directory-prefix", "--output-file", "--append-output", "--save-cookies", "--save-headers", "--warc-file"],
  },
};

/**
 * speed-fastpath (security probe): the write targets carried by option values, and whether the program passed an
 * option the table does not know (an unknown short letter, or a `--name=value` / `--name` not listed). An unknown
 * option may take a value, so the operands after it can't be told apart: the analyzer then treats the command's
 * targets as unresolved (never fast, at least tier 2, the model sees it). Programs without a table: none, false.
 */
export function optionWrites(prog: string, args: string[]): { targets: string[]; unresolved: boolean } {
  const t = OPTION_WRITERS[prog];
  const targets: string[] = [];
  if (!t) return { targets, unresolved: false };
  let unresolved = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") break;
    if (!a.startsWith("-") || a === "-") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (t.longWrites.includes(name)) {
        const v = eq === -1 ? args[++i] : a.slice(eq + 1);
        if (v !== undefined) targets.push(v);
      } else if (t.longValues.includes(name)) {
        if (eq === -1) i++;
      } else if (t.longOptional?.includes(name)) {
        // value only in the `=` form
      } else if (!(eq === -1 && t.long.includes(name))) unresolved = true;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const c = a[k] as string;
      if (t.values.includes(c)) {
        const attached = a.slice(k + 1);
        const v = attached || args[i + 1];
        if (!attached) i++;
        if (t.writes.includes(c) && v !== undefined) targets.push(v);
        break;
      }
      if (!t.flags.includes(c)) { unresolved = true; break; }
      // curl -O / wget default: the file lands in the cwd under the URL's own name.
      if (prog === "curl" && c === "O") targets.push(".");
    }
  }
  if (prog === "curl" && args.some((a) => a === "--remote-name" || a === "--remote-name-all")) targets.push(".");
  if (prog === "wget" && !targets.length) targets.push(".");
  // wget -r / --mirror / -p / -i write a whole tree (names the server picks) under the cwd or -P: unresolved.
  if (prog === "wget" && args.some((a) => ["--recursive", "--mirror", "--page-requisites", "--input-file"].includes(a.split("=")[0] as string) || /^-[A-Za-z0-9]*[rmpi]/.test(a))) unresolved = true;
  return { targets, unresolved };
}

/** tar extraction (`-x`, `x…` first word, `--extract`, `--get`). */
function tarExtracts(args: string[]): boolean {
  return args.some((a, i) => a === "--extract" || a === "--get" || (/^-[A-Za-z]+$/.test(a) && a.includes("x")) || (i === 0 && /^[A-Za-z]+$/.test(a) && a.includes("x")));
}

/**
 * speed-fastpath (security probe): `tar -xP` / `--absolute-names` keeps absolute member names and `..`, so an
 * extraction writes wherever the archive says. Its targets can't be known from the command.
 */
export function tarAbsoluteExtract(args: string[]): boolean {
  return tarExtracts(args) && args.some((a, i) => a === "--absolute-names" || (/^-[A-Za-z]+$/.test(a) && a.includes("P")) || (i === 0 && /^[A-Za-z]+$/.test(a) && a.includes("P")));
}
