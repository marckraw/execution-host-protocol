import { describe, expect, it } from "vitest";
import { normalizeOriginKey } from "../src/index.js";

/**
 * Every spelling of one remote, so the property below has something to be a
 * property about. The credentialed forms are placeholders — the point is that
 * the key drops them, so nothing here is a secret in the first place.
 */
const SPELLINGS_OF_ONE_REMOTE = [
  "git@github.com:marckraw/new-blok.git",
  "git@github.com:marckraw/new-blok",
  "ssh://git@github.com/marckraw/new-blok.git",
  "https://github.com/marckraw/new-blok.git",
  "https://github.com/marckraw/new-blok",
  "https://github.com/marckraw/new-blok/",
  "https://github.com/marckraw/new-blok.git/",
  "https://user:placeholder@github.com/marckraw/new-blok.git",
  "https://GitHub.com/MarcKraw/New-Blok.git",
  "git://github.com/marckraw/new-blok.git",
  "  https://github.com/marckraw/new-blok.git  ",
];

describe("normalizeOriginKey", () => {
  it("collapses every form of the same remote onto one key", () => {
    const keys = new Set(SPELLINGS_OF_ONE_REMOTE.map(normalizeOriginKey));

    expect([...keys]).toEqual(["github.com/marckraw/new-blok"]);
  });

  it("keeps different repositories apart", () => {
    const distinct = [
      "git@github.com:marckraw/new-blok.git",
      "git@github.com:marckraw/emergence.git",
      "git@gitlab.com:marckraw/new-blok.git",
      "git@github.com:someone-else/new-blok.git",
    ].map(normalizeOriginKey);

    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it("drops embedded credentials rather than normalizing them into the key", () => {
    const key = normalizeOriginKey(
      "https://x-access-token:placeholder@github.com/marckraw/new-blok.git",
    );

    expect(key).toBe("github.com/marckraw/new-blok");
    expect(key).not.toContain("placeholder");
    expect(key).not.toContain("@");
  });

  it("keeps nested groups, which are part of the repository's identity", () => {
    expect(normalizeOriginKey("https://gitlab.com/group/sub/repo.git")).toBe(
      "gitlab.com/group/sub/repo",
    );
    expect(normalizeOriginKey("git@gitlab.com:group/sub/repo.git")).toBe(
      "gitlab.com/group/sub/repo",
    );
  });

  it("strips a port from URL form, where a port is a port", () => {
    expect(
      normalizeOriginKey("ssh://git@github.com:22/marckraw/new-blok.git"),
    ).toBe("github.com/marckraw/new-blok");
  });

  it("has no key for anything that names no remote", () => {
    for (const value of [
      null,
      undefined,
      "",
      "   ",
      "/Users/marckraw/Projects/new-blok",
      "not a url",
      "https://github.com",
      "https://github.com/",
      "file:///Users/marckraw/Projects/new-blok",
    ]) {
      expect(normalizeOriginKey(value)).toBeNull();
    }
  });

  it("is idempotent — a key normalizes to itself", () => {
    for (const spelling of SPELLINGS_OF_ONE_REMOTE) {
      const key = normalizeOriginKey(spelling) as string;
      expect(normalizeOriginKey(key)).toBe(key);
    }
  });
});
