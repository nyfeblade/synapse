import { describe, expect, it } from "vitest";
import { headlineRate, isRegion, taxFor } from "../src/tax";

describe("taxFor", () => {
  it("charges California sales tax on goods but not services or food", () => {
    expect(taxFor("US-CA", "standard", 9998)).toEqual({ parts: [{ name: "Sales tax", rate: 7.25, cents: 725 }], total: 725 });
    expect(taxFor("US-CA", "services", 12000).total).toBe(0);
    expect(taxFor("US-CA", "food", 12000).parts).toEqual([]);
  });
  it("splits New York into state and city parts, each rounded", () => {
    const r = taxFor("US-NY", "standard", 1001);
    expect(r.parts.map((p) => p.cents)).toEqual([40, 45]);
    expect(r.total).toBe(85);
  });
  it("handles Canadian GST/QST and HST", () => {
    expect(taxFor("CA-QC", "standard", 75800).parts.map((p) => [p.name, p.cents])).toEqual([["GST", 3790], ["QST", 7561]]);
    expect(taxFor("CA-ON", "books", 10000).total).toBe(500);
    expect(taxFor("CA-ON", "standard", 10000).total).toBe(1300);
  });
  it("zero-rates UK food and books, reduces German food and books", () => {
    expect(taxFor("GB", "books", 6250).total).toBe(0);
    expect(taxFor("GB", "services", 195000).total).toBe(39000);
    expect(taxFor("DE", "food", 34200).total).toBe(2394);
    expect(taxFor("DE", "services", 2500).total).toBe(475);
  });
  it("charges nothing in Oregon", () => {
    expect(taxFor("US-OR", "standard", 50000)).toEqual({ parts: [], total: 0 });
  });
  it("reports headline rates", () => {
    expect(headlineRate("US-NY", "standard")).toBe(8.5);
    expect(headlineRate("GB", "food")).toBe(0);
    expect(isRegion("FR")).toBe(false);
  });
});
