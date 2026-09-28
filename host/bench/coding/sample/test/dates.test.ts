import { describe, expect, it } from "vitest";
import { addBusinessDays, addDays, DateError, endOfMonth, isValidDate, isWeekend, maxDate, parseDate } from "../src/dates";

describe("dates", () => {
  it("parses ISO dates and rejects impossible ones", () => {
    expect(parseDate("2025-01-01")).toBe(Date.UTC(2025, 0, 1));
    expect(() => parseDate("2025-02-30")).toThrow(DateError);
    expect(() => parseDate("2025-1-1")).toThrow(DateError);
    expect(isValidDate("2024-02-29")).toBe(true);
    expect(isValidDate("2025-02-29")).toBe(false);
  });
  it("adds days across month and year ends", () => {
    expect(addDays("2025-01-31", 1)).toBe("2025-02-01");
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01");
    expect(addDays("2025-03-01", -1)).toBe("2025-02-28");
  });
  it("knows weekends and business days", () => {
    expect(isWeekend("2025-03-08")).toBe(true); // Saturday
    expect(isWeekend("2025-03-10")).toBe(false); // Monday
    expect(addBusinessDays("2025-03-07", 1)).toBe("2025-03-10"); // Fri + 1 = Mon
    expect(addBusinessDays("2025-03-08", 0)).toBe("2025-03-10"); // Sat counts from Mon
    expect(addBusinessDays("2025-03-10", 5)).toBe("2025-03-17");
  });
  it("finds month ends and the latest date", () => {
    expect(endOfMonth("2024-02-10")).toBe("2024-02-29");
    expect(endOfMonth("2025-12-01")).toBe("2025-12-31");
    expect(maxDate("2025-01-02", "2025-03-01", "2024-12-31")).toBe("2025-03-01");
  });
});
