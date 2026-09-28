import { describe, expect, it } from "vitest";
import { profileName } from "../../src/main/profile";

describe("APP_PROFILE", () => {
  it("selects a safe profile name and defaults otherwise", () => {
    expect(profileName({ APP_PROFILE: "fuzz" })).toBe("fuzz");
    expect(profileName({})).toBe("default");
    expect(profileName({ APP_PROFILE: "../etc" })).toBe("default");
  });
});
