import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug 295 follow-up: install.sh maps whisper.cpp's source and build paths away (-ffile-prefix-map) so the helper never
 * carries the builder's absolute path. The first version put those paths into CMAKE_C_FLAGS, a string CMake splits on
 * spaces, so a checkout under a folder with a space in its name (".../Project 1/...") could not build at all.
 *
 * This runs the real install.sh with the real cmake and clang against a tiny stand-in for the whisper.cpp source (same
 * layout, a C, a C++ and an Objective-C file that each keep __FILE__), under a root whose path has spaces. No network:
 * the source is already in place, so nothing is fetched. Skipped where there is no cmake or Xcode toolchain.
 */
const repo = path.resolve(__dirname, "../../..");
const install = path.join(repo, "app", "native", "whisper", "install.sh");

function findCmake(): string | null {
  const onPath = spawnSync("sh", ["-c", "command -v cmake"], { encoding: "utf8" }).stdout.trim();
  if (onPath) return onPath;
  const tools = path.join(repo, ".build-cache", "whisper", "tools");
  try {
    for (const d of fs.readdirSync(tools)) {
      const c = path.join(tools, d, "CMake.app", "Contents", "bin", "cmake");
      if (fs.existsSync(c)) return c;
    }
  } catch { /* no cache */ }
  return null;
}
function hasToolchain(): boolean {
  const dev = spawnSync("xcode-select", ["-p"], { encoding: "utf8" }).stdout?.trim();
  return !!dev && fs.existsSync(path.join(dev, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "clang"));
}
const cmake = process.platform === "darwin" ? findCmake() : null;

function stubSource(src: string): void {
  const w = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), body); };
  w("CMakeLists.txt", [
    "cmake_minimum_required(VERSION 3.20)",
    "project(whisper.cpp C CXX OBJC)",
    "add_subdirectory(ggml)",
    'configure_file(src/gen.c.in "${CMAKE_BINARY_DIR}/gen/whisper-gen.c")',
    'add_library(whisper STATIC src/whisper.cpp "${CMAKE_BINARY_DIR}/gen/whisper-gen.c")',
    "",
  ].join("\n"));
  w("src/whisper.cpp", 'extern "C" const char *whisper_where(void) { return __FILE__; }\n');
  w("src/gen.c.in", "const char *whisper_gen_where(void) { return __FILE__; }\n");
  w("include/whisper.h", "const char *whisper_where(void);\n");
  w("ggml/CMakeLists.txt", "project(ggml C OBJC)\nadd_library(ggml STATIC src/ggml.c src/ggml-metal.m)\n");
  w("ggml/src/ggml.c", "const char *ggml_where(void) { return __FILE__; }\n");
  w("ggml/src/ggml-metal.m", "const char *ggml_metal_where(void) { return __FILE__; }\n");
  w("ggml/include/ggml.h", "const char *ggml_where(void);\n");
}

describe.skipIf(!cmake || !hasToolchain())("whisper install.sh under a path with spaces (bug 295)", () => {
  it("builds, and no library carries the build path", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wh "));
    const root = path.join(base, "Project 1", "whisper root");
    stubSource(path.join(root, "build", "whisper.cpp-1.9.4"));
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(cmake!, path.join(bin, "cmake"));
    const r = spawnSync("bash", [install, "--libs-only", "--root", root], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 180_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const libs = fs.readdirSync(path.join(root, "lib")).sort();
    expect(libs).toEqual(["libggml.a", "libwhisper.a"]);
    expect(fs.existsSync(path.join(root, "include", "whisper.h"))).toBe(true);
    const all = libs.map((l) => execFileSync("strings", ["-a", path.join(root, "lib", l)], { encoding: "utf8" })).join("\n");
    expect(all).not.toContain(base);
    expect(all).not.toContain(fs.realpathSync(base));
    // The mapped names are there, so __FILE__ still says which file, just not where it was built.
    for (const f of ["whisper.cpp/src/whisper.cpp", "whisper.cpp/ggml/src/ggml.c", "whisper.cpp/ggml/src/ggml-metal.m", "gen/whisper-gen.c"]) expect(all).toContain(f);
  }, 200_000);
});
