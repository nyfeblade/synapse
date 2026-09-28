// Public release: a fresh install checks the public repo for updates without anyone typing a feed in;
// a feed the user saved still wins.
import { describe, expect, it } from "vitest";
import { effectiveFeed, PUBLIC_UPDATE_FEED } from "../../src/main/update-source";
import { validFeed } from "../../src/main/native/updater";

describe("the update feed", () => {
  it("defaults to the public repo", () => {
    expect(PUBLIC_UPDATE_FEED).toBe("nyfeblade/synapse");
    expect(validFeed(PUBLIC_UPDATE_FEED)).toBe(true);
    expect(effectiveFeed(null)).toBe(PUBLIC_UPDATE_FEED);
  });
  it("keeps a feed the user saved", () => {
    expect(effectiveFeed("someone/fork")).toBe("someone/fork");
  });
});
