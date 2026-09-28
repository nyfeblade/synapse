/**
 * SEC-05 + security fix I3 (06:45 ruling): a secret becomes an environment variable of the Bot's CLI and
 * shells, so its name must not steer a program (git, bash startup, dynamic loaders, runtimes, proxies,
 * locale, the CLI itself). A strict format plus a prefix/name denylist; validated at store time AND at
 * env time (host/brain/spawn-options.ts buildBotEnv, and read by the Mac app to list a stored name as unusable), because a denylist alone can go stale.
 */
const NAME_FORMAT = /^[A-Z][A-Z0-9_]{0,63}$/;

export const RESERVED_PREFIXES = [
  "GIT_", "BASH_", "LD_", "DYLD_", "NODE_", "NPM_CONFIG_", "PYTHON", "PERL", "RUBY", "JAVA_", "SSL_", "CURL_", "XDG_", "LC_",
  "CLAUDE_", "ANTHROPIC_", "MCP_", "OTEL_", "DISABLE_", "ENABLE_", "MAX_", "BOT_",
  // security re-review item 8: package-manager and toolchain config
  "YARN_", "PIP_", "GEM_", "CARGO_", "CGO_",
] as const;

/** Security re-review item 8: names with these endings configure a program (a path it loads, options, a pager, a helper it runs). */
export const RESERVED_SUFFIXES = ["_PATH", "_OPTIONS", "_OPTS", "_CONF", "_CONFIG", "PAGER", "ASKPASS", "WRAPPER", "_FLAGS", "RC"] as const;

export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "ENV", "BASH_ENV", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "IFS", "TMPDIR",
  "PAGER", "EDITOR", "VISUAL", "LESSOPEN", "LANG", "XAUTHORITY", "DISPLAY", "TERM", "PWD",
  // security re-review item 8
  "GCONV_PATH", "OPENSSL_CONF", "JDK_JAVA_OPTIONS", "GLIBC_TUNABLES", "LESSCLOSE", "CDPATH", "BROWSER", "MANPAGER", "SYSTEMD_PAGER",
  "SSH_ASKPASS", "SUDO_ASKPASS", "HOSTALIASES", "LOCPATH", "NLSPATH", "MALLOC_CONF", "RUSTC_WRAPPER", "PS1", "PS2", "PS3", "HISTFILE", "WGETRC",
  "TERMINFO", "TERMINFO_DIRS", "MANPATH", "RUSTC", "RUSTDOC", "RUSTFLAGS", "RUSTDOCFLAGS", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "MAKEFLAGS",
  "CC", "CXX", "CPP", "LD", "AR", "AS", "MAKE",
  "GOFLAGS", "GOPROXY", "GOROOT", "GOPATH", "GOENV", "GOTOOLCHAIN", "GOBIN", "GOCACHE", "GOMODCACHE", "GOTMPDIR", "GOPRIVATE", "GONOPROXY",
  "GONOSUMDB", "GONOSUMCHECK", "GOSUMDB", "GOINSECURE", "GOEXPERIMENT", "GOOS", "GOARCH", "GO111MODULE", "GODEBUG", "GOGC", "GOMAXPROCS",
  "GOTRACEBACK", "GOVCS", "GOWORK", "GOAUTH", "GCCGO",
]);

export const SECRET_NAME_FORMAT_ERROR = "Secret names use capital letters, digits and underscores, start with a letter, and are at most 64 characters (like STRIPE_KEY).";

/** null when the name is usable as a Bot env var; otherwise the user-facing reason. Lowercase names (e.g. https_proxy) fail the format. */
export function validateSecretName(name: string): string | null {
  if (RESERVED_NAMES.has(name)) return `${name} is reserved.`;
  if (!NAME_FORMAT.test(name)) return SECRET_NAME_FORMAT_ERROR;
  const p = RESERVED_PREFIXES.find((x) => name.startsWith(x));
  if (p) return `Names starting with ${p} are reserved.`;
  const sfx = RESERVED_SUFFIXES.find((x) => name.endsWith(x));
  return sfx ? `Names ending in ${sfx} are reserved.` : null;
}
