import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_VOICES, RUNTIME_PATHS, forbiddenAsarEntries, helperProblems, missingRuntimePaths, packedNativeEntries, parseMinos, unsignedMachO, verifyBundle } from "../../scripts/verify-bundle.mjs";

/** A bundle fixture: every path the real checks look at, all correct, so a test can break exactly one. */
function goodBundle() {
  return {
    app: "/out/Synapse.app",
    files: new Set([
      "/out/Synapse.app/Contents/Resources/box/deploy.sh",
      "/out/Synapse.app/Contents/Resources/box/provision-from-mac.sh",
      "/out/Synapse.app/Contents/Resources/box/orb.sh",
      "/out/Synapse.app/Contents/Resources/box/route.env",
      "/out/Synapse.app/Contents/Resources/box/desktop.env",
      "/out/Synapse.app/Contents/Resources/box/files",
      "/out/Synapse.app/Contents/Resources/box/host-dist.tgz",
      "/out/Synapse.app/Contents/Resources/host/dist/host.mjs",
      "/out/Synapse.app/Contents/Resources/host/node_modules/libsodium-wrappers/package.json",
      "/out/Synapse.app/Contents/Resources/host/node_modules/libsodium/package.json",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/bots-dictation",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/fake-dictation.sh",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/kokoro_server.py",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/f5_server.py",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/qwen_server.py",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/voice-selftest.wav",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/bots-mac",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/fake-macapp.sh",
      "/out/Synapse.app/Contents/Resources/box/provision.sh",
      "/out/Synapse.app/Contents/Resources/box/check-gateway.sh",
      "/out/Synapse.app/Contents/Resources/box/verify-box.sh",
      "/out/Synapse.app/Contents/Resources/kokoro/python/bin/python3.12",
      "/out/Synapse.app/Contents/Resources/kokoro/python/lib/libpython3.12.dylib",
      "/out/Synapse.app/Contents/Resources/kokoro/python/lib/python3.12/site-packages/mlx_audio",
      "/out/Synapse.app/Contents/Resources/kokoro/python/lib/python3.12/site-packages/en_core_web_sm",
      "/out/Synapse.app/Contents/Resources/kokoro/python/lib/python3.12/site-packages/espeakng_loader/espeak-ng-data/en_dict",
      "/out/Synapse.app/Contents/Resources/kokoro/model/config.json",
      "/out/Synapse.app/Contents/Resources/kokoro/model/kokoro-v1_0.safetensors",
      "/out/Synapse.app/Contents/Resources/kokoro/manifest.json",
      "/out/Synapse.app/Contents/Resources/THIRD-PARTY-NOTICES.txt",
      "/out/Synapse.app/Contents/Resources/LICENSE",
      "/out/Synapse.app/Contents/Resources/NOTICE",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/qwen-requirements.lock",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/f5-requirements.lock",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/f5-requirements-sdist.lock",
      ...BUNDLED_VOICES.map((v) => `/out/Synapse.app/Contents/Resources/kokoro/model/voices/${v}.safetensors`),
    ]),
    executable: new Set([
      "/out/Synapse.app/Contents/Resources/kokoro/python/bin/python3.12",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/bots-dictation",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/fake-dictation.sh",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/kokoro_server.py",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/f5_server.py",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/qwen_server.py",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/bots-mac",
      "/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/fake-macapp.sh",
    ]),
    asar: [
      { path: "/package.json" },
      { path: "/dist/main.cjs" },
      { path: "/dist/preload.cjs" },
      { path: "/dist/coordinator.cjs" },
      { path: "/dist/renderer/index.html" },
      { path: "/dist/node_modules/libsodium-wrappers/package.json" },
      { path: "/dist/node_modules/libsodium/package.json" },
      { path: "/dist/native/bots-dictation", unpacked: true },
      { path: "/dist/native/fake-dictation.sh", unpacked: true },
      { path: "/dist/native/kokoro_server.py", unpacked: true },
      { path: "/dist/native/f5_server.py", unpacked: true },
      { path: "/dist/native/qwen_server.py", unpacked: true },
      { path: "/dist/native/voice-selftest.wav", unpacked: true },
      { path: "/dist/native/bots-mac", unpacked: true },
      { path: "/dist/native/fake-macapp.sh", unpacked: true },
    ],
  };
}

const run = (b: ReturnType<typeof goodBundle>) =>
  verifyBundle({
    app: b.app,
    exists: (p: string) => b.files.has(p),
    isExecutable: (p: string) => b.executable.has(p),
    asarEntries: () => b.asar,
  });

describe("verifyBundle", () => {
  it("passes a correct bundle", () => {
    expect(run(goodBundle())).toEqual([]);
  });

  // Defect 2: gateway-bootstrap computes …/Contents/Resources/host/dist/host.mjs and the packager
  // never shipped it. The old checks only grepped the asar header for two package names, so the
  // packager happily produced a bundle that could not start its own host.
  it("fails when a path the running code computes is not in the bundle", () => {
    const b = goodBundle();
    b.files.delete("/out/Synapse.app/Contents/Resources/host/dist/host.mjs");
    expect(run(b)).toEqual(["missing from the bundle: Contents/Resources/host/dist/host.mjs"]);
  });

  it("checks every runtime-resolved path, not just a couple", () => {
    for (const rel of RUNTIME_PATHS) {
      const b = goodBundle();
      b.files.delete(`${b.app}/${rel}`);
      expect(run(b)).toEqual([`missing from the bundle: ${rel}`]);
    }
    expect(RUNTIME_PATHS).toContain("Contents/Resources/host/dist/host.mjs");
    expect(RUNTIME_PATHS).toContain("Contents/Resources/host/node_modules/libsodium-wrappers/package.json");
    expect(RUNTIME_PATHS).toContain("Contents/Resources/box/route.env");
  });

  // Electron can only spawn() an executable outside app.asar, and only one that kept its ad-hoc
  // signature — so every dist/native entry must be unpacked AND executable, not just the two the
  // old check happened to name.
  it("fails when anything under dist/native is packed into the archive", () => {
    const b = goodBundle();
    b.asar.push({ path: "/dist/native/new-helper", unpacked: false });
    expect(run(b)).toContain("dist/native must be unpacked, but app.asar packs: /dist/native/new-helper");
  });

  it("fails when an unpacked native helper is not executable", () => {
    const b = goodBundle();
    b.executable.delete("/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/bots-dictation");
    expect(run(b)).toContain("not executable: Contents/Resources/app.asar.unpacked/dist/native/bots-dictation");
  });

  it("fails when an unpacked native helper is missing from disk entirely", () => {
    const b = goodBundle();
    b.files.delete("/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/fake-dictation.sh");
    b.executable.delete("/out/Synapse.app/Contents/Resources/app.asar.unpacked/dist/native/fake-dictation.sh");
    expect(run(b)).toContain("missing from the bundle: Contents/Resources/app.asar.unpacked/dist/native/fake-dictation.sh");
  });

  it("fails when the runtime-required packages are not in the archive", () => {
    const b = goodBundle();
    b.asar = b.asar.filter((e) => !e.path.includes("libsodium-wrappers"));
    expect(run(b)).toContain("app.asar is missing node_modules/libsodium-wrappers — the app will crash on launch");
  });

  // main.cjs.map alone carries the whole TypeScript source of the Mac side, including the updater's
  // signing logic and the local-exec policy. It has no business in a shipped bundle.
  it("fails when source maps, test output or build configs are shipped", () => {
    const b = goodBundle();
    b.asar.push({ path: "/dist/main.cjs.map" }, { path: "/test-results/phase5/trace.zip" }, { path: "/vite.config.ts" });
    expect(run(b)).toContain("app.asar must not ship: /dist/main.cjs.map, /test-results/phase5/trace.zip, /vite.config.ts");
  });
});

describe("forbiddenAsarEntries", () => {
  it("catches .map, test-results/ and *.config.ts anywhere in the archive", () => {
    expect(forbiddenAsarEntries([
      { path: "/dist/main.cjs" },
      { path: "/dist/main.cjs.map" },
      { path: "/dist/renderer/assets/index-abc.js.map" },
      { path: "/test-results/.last-run.json" },
      { path: "/a/test-results/b.png" },
      { path: "/vitest.config.ts" },
      { path: "/e2e/playwright.config.ts" },
    ])).toEqual(["/dist/main.cjs.map", "/dist/renderer/assets/index-abc.js.map", "/test-results/.last-run.json", "/a/test-results/b.png", "/vitest.config.ts", "/e2e/playwright.config.ts"]);
  });

  it("does not trip over an innocent name that merely contains the words", () => {
    expect(forbiddenAsarEntries([{ path: "/dist/sitemap.js" }, { path: "/dist/roadmap.json" }, { path: "/src/config.tsx" }])).toEqual([]);
  });
});

describe("packedNativeEntries", () => {
  it("lists dist/native entries the archive packed instead of unpacking", () => {
    expect(packedNativeEntries([
      { path: "/dist/native/a", unpacked: true },
      { path: "/dist/native/b" },
      { path: "/dist/other/c" },
    ])).toEqual(["/dist/native/b"]);
  });
});

describe("missingRuntimePaths", () => {
  it("returns the relative paths, in the order the app needs them", () => {
    expect(missingRuntimePaths("/A.app", () => false)).toEqual(RUNTIME_PATHS);
    expect(missingRuntimePaths("/A.app", () => true)).toEqual([]);
  });
});

// Portable install: the bundle carries a Python runtime (≈110 Mach-O files: the interpreter, libpython, every
// extension module, espeak's dylib, MLX) and the Kokoro model.
describe("the bundled voice runtime", () => {
  it("fails without the runtime, the model or any of the voices the app offers", () => {
    for (const rel of ["Contents/Resources/kokoro/python/bin/python3.12", "Contents/Resources/kokoro/model/kokoro-v1_0.safetensors", "Contents/Resources/kokoro/python/lib/python3.12/site-packages/en_core_web_sm"]) {
      const b = goodBundle();
      b.files.delete(`${b.app}/${rel}`);
      expect(run(b)).toEqual([`missing from the bundle: ${rel}`]);
    }
    const b = goodBundle();
    b.files.delete(`${b.app}/Contents/Resources/kokoro/model/voices/bm_george.safetensors`);
    expect(run(b)).toEqual(["missing from the bundle: Contents/Resources/kokoro/model/voices/bm_george.safetensors"]);
  });

  it("the interpreter must be executable", () => {
    const b = goodBundle();
    b.executable.delete(`${b.app}/Contents/Resources/kokoro/python/bin/python3.12`);
    expect(run(b)).toEqual(["not executable: Contents/Resources/kokoro/python/bin/python3.12"]);
  });

  it("no source map next to the local host, no vitest cache in the archive", () => {
    const b = goodBundle();
    b.asar.push({ path: "/node_modules/.vite/vitest/results.json" });
    expect(verifyBundle({ app: b.app, exists: (p) => b.files.has(p), isExecutable: (p) => b.executable.has(p), asarEntries: () => b.asar, resourceFiles: () => ["Contents/Resources/host/dist/host.mjs.map"] }))
      .toEqual(["app.asar must not ship: /node_modules/.vite/vitest/results.json", "must not ship: Contents/Resources/host/dist/host.mjs.map"]);
  });
});

describe("every Mach-O is signed by the one identity", () => {
  const authority = "Synapse Local Signing";
  const signed = `Identifier=x\nAuthority=${authority}\nSignature size=1`;
  it("passes when every file verifies and names the identity", () => {
    expect(unsignedMachO(["/a.so", "/b.dylib"], { authority, verify: () => {}, describe: () => signed })).toEqual([]);
  });
  it("names a file that doesn't verify, is ad hoc, or is signed by someone else", () => {
    const problems = unsignedMachO(["/bad.so", "/adhoc.so", "/other.so"], {
      authority,
      verify: (f: string) => { if (f === "/bad.so") throw new Error("code object is not signed at all"); },
      describe: (f: string) => (f === "/adhoc.so" ? "Signature=adhoc" : "Authority=Someone Else"),
    });
    expect(problems).toEqual([
      "/bad.so: signature does not verify (code object is not signed at all)",
      "/adhoc.so: signed by no authority (ad hoc), not Synapse Local Signing",
      "/other.so: signed by Someone Else, not Synapse Local Signing",
    ]);
  });
});

describe("the helpers run on the promised macOS and carry whisper", () => {
  it("reads vtool's minos and refuses a helper built for a newer macOS", () => {
    expect(parseMinos("Load command 10\n      cmd LC_BUILD_VERSION\n  platform MACOS\n    minos 14.0\n      sdk 26.5")).toBe("14.0");
    const ok = helperProblems({ helpers: ["/h/bots-dictation", "/h/bots-mac"], showBuild: () => "minos 14.0", dictation: "/h/bots-dictation", hasWhisper: () => true });
    expect(ok).toEqual([]);
    const bad = helperProblems({ helpers: ["/h/bots-mac"], showBuild: () => "minos 28.0", dictation: "/h/bots-dictation", hasWhisper: () => false });
    expect(bad).toEqual(["bots-mac needs macOS 28.0; the app promises 14.0", "bots-dictation was built without whisper (app/native/whisper/install.sh --libs-only)"]);
  });
});

// Bug 295: whisper.cpp's __FILE__ asserts compiled the builder's absolute path into bots-dictation, so a release built on a
// developer's Mac shipped that developer's home folder. The package check refuses a shipped file that names a home folder.
describe("no builder's home folder in a shipped file", () => {
  it("names each file that carries /Users/<someone>/, and passes clean ones", async () => {
    const { builderPathLeaks } = await import("../../scripts/verify-bundle.mjs");
    const files: Record<string, Buffer> = {
      "/b/bots-dictation": Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]), Buffer.from("GGML_ASSERT failed /Users/someone/src/repo/.build-cache/whisper/build/whisper.cpp-1.9.4/src/whisper.cpp\0")]),
      "/b/host.mjs": Buffer.from("// ../../../../../other-checkout/node_modules/ws/lib/websocket.js\nconst x = 1;\n"),
      "/b/bots-mac": Buffer.from("clean helper ./src/whisper.cpp /usr/lib/libSystem.B.dylib\0"),
    };
    const problems = builderPathLeaks(Object.keys(files), (f: string) => files[f]!);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^\/b\/bots-dictation: .*\/Users\/someone\//);
    expect(problems[1]).toMatch(/^\/b\/host\.mjs: .*other-checkout/);
  });

  it("the whisper build maps its source prefix away and is rebuilt once for it", () => {
    const install = fs.readFileSync(path.join(__dirname, "../../native/whisper/install.sh"), "utf8");
    // As compile options from a CMake include (not a flags string CMake splits on spaces): whisper-install-spaces.test.ts.
    expect(install).toContain('-DCMAKE_PROJECT_INCLUDE="$HERE/prefix-map.cmake"');
    expect(install).not.toMatch(/-DCMAKE_(C|CXX)_FLAGS=/);
    const map = fs.readFileSync(path.join(__dirname, "../../native/whisper/prefix-map.cmake"), "utf8");
    expect(map).toMatch(/-ffile-prefix-map=\$\{CMAKE_SOURCE_DIR\}=/);
    expect(map).toMatch(/-ffile-prefix-map=\$\{CMAKE_BINARY_DIR\}=/);
    expect(install).toMatch(/^BUILD_ID="prefix-map-2"$/m);
    expect(install).toMatch(/echo "whisper \$WHISPER_TAG macos\$MACOS_MIN \$ARM_ARCH \$BUILD_ID" > "\$ROOT\/version"/);
    const build = fs.readFileSync(path.join(__dirname, "../../native/dictation/build.sh"), "utf8");
    expect(build).toMatch(/have_whisper\(\)[^\n]*prefix-map-2/);
  });

  it("package.mjs runs the check on the helpers and the local host bundle", () => {
    const pkg = fs.readFileSync(path.join(__dirname, "../../scripts/package.mjs"), "utf8");
    expect(pkg).toMatch(/builderPathLeaks\(/);
  });
});
