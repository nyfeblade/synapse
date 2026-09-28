import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayError } from "../../gateway/errors";
import { Catalog, type CuratedEntry } from "../../marketplace/catalog";
import { CatalogIndex } from "../../marketplace/catalog-index";
import { createMarketplaceModule } from "../../marketplace/module";
import { createMcpServices } from "../../mcp/module";
import { HostSettingsStore } from "../../store/host-settings";

const curated: CuratedEntry[] = [
  { id: "curated:linear", name: "Linear", description: "Issues and projects", category: "Code", via: "remote", url: "https://mcp.linear.app/mcp" },
];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mktmod-"));
  const ctx = {
    cfg: { hostPrivate: dir, workspace: dir },
    hub: { publish: () => {} },
    settings: new HostSettingsStore(path.join(dir, "s.json")),
    now: () => 1,
    flags: () => ({}),
  } as never;
  const mcp = createMcpServices(ctx, { connect: async () => { throw new Error("401 Unauthorized"); } });
  const catalog = new Catalog({ curated, mcp, plugins: () => null, templates: () => ({ list: () => [] }), index: new CatalogIndex(path.join(dir, "catalog-index.db")) });
  return { module: createMarketplaceModule(ctx, catalog) };
}

describe("marketplace module", () => {
  it("getCatalogEntry throws a GatewayError NOT_FOUND (404) for an unknown id, like catalog.detail does", () => {
    const { module } = setup();
    let caught: unknown;
    try {
      module.handlers.getCatalogEntry!({ id: "curated:nonexistent" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayError);
    expect(caught).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("getCatalogEntry returns entry and detail for a known id", () => {
    const { module } = setup();
    const r = module.handlers.getCatalogEntry!({ id: "curated:linear" }) as { entry: { id: string }; detail: unknown };
    expect(r.entry.id).toBe("curated:linear");
    expect(r.detail).toBeTruthy();
  });
});
