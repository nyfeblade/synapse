import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAppSettings } from "../../src/main/app-settings";
import { defaultBoxDir } from "../../src/main/box-lifecycle";

// Controller ruling (2026-09-19): Synapse.app ships box/ in Contents/Resources (packager extraResource);
// in development the repo's box/ is used.
describe("box/ location, packaged and unpacked", () => {
  it("unpacked: the repo's box/ next to the app folder", () => {
    expect(defaultBoxDir("/repo/app")).toBe(path.join("/repo", "box"));
    expect(defaultBoxDir("/repo/app", { isPackaged: false, resourcesPath: "/somewhere/Electron.app/Contents/Resources" })).toBe(path.join("/repo", "box"));
  });

  it("packaged: box/ inside the bundle's resources, whatever the app path is (asar or not)", () => {
    const rt = { isPackaged: true, resourcesPath: "/Applications/Synapse.app/Contents/Resources" };
    expect(defaultBoxDir("/Applications/Synapse.app/Contents/Resources/app.asar", rt)).toBe("/Applications/Synapse.app/Contents/Resources/box");
    expect(defaultBoxDir("/elsewhere/app", rt)).toBe("/Applications/Synapse.app/Contents/Resources/box");
  });

  it("readAppSettings reads route.env from the bundle when packaged and from the repo when not", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boxpaths-"));
    const res = path.join(tmp, "Synapse.app", "Contents", "Resources");
    fs.mkdirSync(path.join(res, "box"), { recursive: true });
    fs.writeFileSync(path.join(res, "box", "route.env"), "GATEWAY_ROUTE=ssh-tunnel\nGATEWAY_HOST=10.0.0.9\n");
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "box"), { recursive: true });
    fs.mkdirSync(path.join(repo, "app"));
    fs.writeFileSync(path.join(repo, "box", "route.env"), "GATEWAY_ROUTE=orb-hostname\nGATEWAY_HOST=box.orb.local\n");
    const ud = path.join(tmp, "ud");
    expect(readAppSettings(ud, path.join(res, "app"), { isPackaged: true, resourcesPath: res })).toMatchObject({ gatewayRoute: "ssh-tunnel", gatewayHost: "10.0.0.9" });
    expect(readAppSettings(ud, path.join(repo, "app"), { isPackaged: false, resourcesPath: res })).toMatchObject({ gatewayRoute: "orb-hostname", gatewayHost: "box.orb.local" });
    expect(readAppSettings(ud, path.join(repo, "app"))).toMatchObject({ gatewayRoute: "orb-hostname" });
  });
});
