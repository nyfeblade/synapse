import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Bug 3 (hand-test after a long engineering build): pip was missing on the box, so a Bot's `pip3 install`/
// `pip3 show` (bug-log 194's full-auto commands checked for `playwright` this way) always failed. provision.sh
// installs `python3` for Phase 3 desktop/perception (AT-SPI bindings, OCR) but never python3-pip or
// python3-venv, so there is no way to install a Python package on a provisioned box at all. This asserts the
// apt package list carries both, next to python3, following the file's existing install -y --no-install-recommends
// pattern (grep "widget option format" for the schema-doc pattern used elsewhere; this one follows the packages
// pattern already established at "python3 curl jq" a few lines up).
const script = fs.readFileSync(path.resolve(__dirname, "../../../box/provision.sh"), "utf8");

describe("provision.sh installs pip alongside python3 (bug 3: pip missing on the box)", () => {
  it("the package list includes python3-pip", () => {
    expect(script).toMatch(/\bpython3-pip\b/);
  });
  it("the package list includes python3-venv", () => {
    expect(script).toMatch(/\bpython3-venv\b/);
  });
  it("installs them the normal way (apt-get install, not a one-off pip bootstrap)", () => {
    const idx = script.indexOf("python3-pip");
    expect(idx).toBeGreaterThan(-1);
    // Portable install: every apt call carries $APT (dpkg lock timeout, download retries).
    const stmt = script.slice(script.lastIndexOf("apt-get", idx), idx + 40);
    expect(stmt).toMatch(/apt-get (\$APT )?install -y --no-install-recommends/);
  });
});
