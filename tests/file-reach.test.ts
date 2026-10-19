import { describe, expect, it } from "vitest";
import {
  confirmsExecutionFileReach,
  decodeExecutionFileReachRefusal,
  decodeExecutionHostFileReach,
  decodeExecutionHostProfile,
  decodeExecutionStartRequest,
  encodeExecutionStartRequest,
  EXECUTION_FILE_REACH_MIN_LANDLOCK_ABI,
  EXECUTION_FILE_REACH_PROBLEMS,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  executionFileReachProblems,
  isExecutionFileReach,
  parseExecutionFileReachPath,
  type ExecutionFileReach,
  type ExecutionHostFileReach,
} from "../src/index.js";
import { startRequestWithEnvironmentFixture } from "./fixtures/contract-fixtures.js";
import {
  fencingHostProfileFixture,
  linuxHostProfileFixture,
} from "./fixtures/host-profile-fixtures.js";

const fencing: ExecutionHostFileReach = fencingHostProfileFixture.fileReach;
const reach = (
  ...entries: Array<[string, "read" | "write"]>
): ExecutionFileReach => ({
  entries: entries.map(([path, access]) => ({ path, access })),
});

describe("a reach path (MAR-4352)", () => {
  it.each([
    ["{worktree}", "worktree", []],
    ["{worktree}/apps/server/src", "worktree", ["apps", "server", "src"]],
    ["{worktree}/apps/server/src/**", "worktree", ["apps", "server", "src"]],
    // The place itself, "and everything in it", as the grammar says.
    ["{worktree}/**", "worktree", []],
    ["{home}/.cache", "home", [".cache"]],
    ["{tmp}/a_b-c@1+2", "tmp", ["a_b-c@1+2"]],
    ["{future}/x", "future", ["x"]],
  ])(
    "reads %s as a place and the segments below it",
    (path, place, segments) => {
      expect(parseExecutionFileReachPath(path)).toEqual({
        ok: true,
        place,
        segments,
      });
    },
  );

  it.each([
    "/etc",
    "/",
    "{worktree}/..",
    "{worktree}/a/../../b",
    "{worktree}/.",
    "{worktree}/",
    "{worktree}//a",
    "{worktree}//**",
    "{worktree}/**/",
    "{worktree}/**/a",
    "{worktree}/*.ts",
    "{worktree}/a b",
    "{worktree}/~",
    "{worktree}/a\\b",
    "{worktree}/a\u0000b",
  ])("refuses %j as escaping its place", (path) => {
    expect(parseExecutionFileReachPath(path)).toEqual({
      ok: false,
      problem: "escapes-place",
    });
  });

  it.each([
    "worktree",
    "{}",
    "{}/a",
    "~/x",
    "./x",
    "{work/tree}",
    "x{worktree}",
  ])("refuses %j as naming no place", (path) => {
    expect(parseExecutionFileReachPath(path)).toEqual({
      ok: false,
      problem: "unknown-place",
    });
  });
});

describe("what a host would refuse in a reach", () => {
  it("takes a reach within its places and ceiling", () => {
    expect(
      executionFileReachProblems(
        reach(
          ["{worktree}", "read"],
          ["{worktree}/apps/server/src/**", "write"],
          ["{tmp}", "write"],
          ["{clone}", "read"],
          ["{attachments}", "read"],
        ),
        fencing,
      ),
    ).toEqual([]);
  });

  it("refuses a place it doesn't know, naming the entry", () => {
    expect(
      executionFileReachProblems(
        reach(["{worktree}", "write"], ["{secrets}", "read"]),
        fencing,
      ),
    ).toEqual([{ problem: "unknown-place", entry: 1 }]);
  });

  it("refuses an absolute path and one with ..", () => {
    expect(
      executionFileReachProblems(
        reach(["/etc/passwd", "read"], ["{worktree}/../other", "read"]),
        fencing,
      ),
    ).toEqual([
      { problem: "escapes-place", entry: 0 },
      { problem: "escapes-place", entry: 1 },
    ]);
  });

  it("refuses more than the ceiling allows, and a place it never grants", () => {
    expect(
      executionFileReachProblems(
        reach(["{clone}", "write"], ["{attachments}/x", "write"]),
        fencing,
      ),
    ).toEqual([
      { problem: "past-ceiling", entry: 0 },
      { problem: "past-ceiling", entry: 1 },
    ]);
    expect(
      executionFileReachProblems(reach(["{clone}", "read"]), {
        ...fencing,
        ceiling: { worktree: "write" },
      }),
    ).toEqual([{ problem: "past-ceiling", entry: 0 }]);
  });

  it("never takes a ceiling's inherited key for a grant", () => {
    expect(
      executionFileReachProblems(reach(["{constructor}", "read"]), {
        ...fencing,
        places: [...fencing.places, "constructor"],
      }),
    ).toEqual([{ problem: "past-ceiling", entry: 0 }]);
  });

  it("refuses every reach on a host that can't fence, an empty one included", () => {
    const none: ExecutionHostFileReach = {
      fence: "none",
      abi: null,
      places: [...fencing.places],
      ceiling: {},
      floor: [],
      reason: "this host is a Mac",
    };
    expect(executionFileReachProblems(reach(), none)).toEqual([
      { problem: "cannot-fence", entry: null },
    ]);
    expect(
      executionFileReachProblems(reach(["{worktree}", "read"]), {
        ...fencing,
        fence: "container",
      }),
    ).toEqual([{ problem: "cannot-fence", entry: null }]);
  });

  it.each([null, 0, 1, 2, 3])(
    "refuses every reach on a Landlock host whose ABI is %j: below 4 there is no fence",
    (abi) => {
      expect(
        executionFileReachProblems(reach(["{worktree}", "read"]), {
          ...fencing,
          abi,
        }),
      ).toEqual([{ problem: "cannot-fence", entry: null }]);
    },
  );

  it("takes {worktree}/** as {worktree}", () => {
    expect(
      executionFileReachProblems(reach(["{worktree}/**", "write"]), {
        ...fencing,
        abi: 4,
      }),
    ).toEqual([]);
  });
});

describe("a start's reach on the wire", () => {
  const request = {
    ...startRequestWithEnvironmentFixture.value,
    fileReach: reach(["{worktree}", "write"], ["{clone}", "read"]),
  };

  it("round-trips a start carrying a reach, at the top level", () => {
    const decoded = decodeExecutionStartRequest(
      encodeExecutionStartRequest(request),
    );
    expect(decoded).toEqual({ ok: true, value: request });
  });

  it("keeps only an entry's path and access", () => {
    const decoded = decodeExecutionStartRequest(
      JSON.stringify({
        ...request,
        fileReach: {
          entries: [{ path: "{worktree}", access: "read", note: "x" }],
          future: true,
        },
      }),
    );
    expect(decoded.ok && decoded.value.fileReach).toEqual(
      reach(["{worktree}", "read"]),
    );
  });

  it("reads a start without a reach as before", () => {
    const decoded = decodeExecutionStartRequest(
      encodeExecutionStartRequest(startRequestWithEnvironmentFixture.value),
    );
    expect(decoded.ok && decoded.value).not.toHaveProperty("fileReach");
  });

  it.each([
    ["not an object", "{worktree}"],
    ["no entries", {}],
    ["entries not a list", { entries: {} }],
    ["an entry not an object", { entries: ["{worktree}"] }],
    ["an empty path", { entries: [{ path: "", access: "read" }] }],
    [
      "a path past 256",
      { entries: [{ path: `{worktree}/${"a".repeat(250)}`, access: "read" }] },
    ],
    [
      "an unknown access",
      { entries: [{ path: "{worktree}", access: "execute" }] },
    ],
    ["no access", { entries: [{ path: "{worktree}" }] }],
    [
      "33 entries",
      {
        entries: Array.from({ length: 33 }, () => ({
          path: "{worktree}",
          access: "read",
        })),
      },
    ],
  ])("refuses a reach with %s rather than dropping it", (_, fileReach) => {
    expect(isExecutionFileReach(fileReach)).toBe(false);
    expect(
      decodeExecutionStartRequest(JSON.stringify({ ...request, fileReach })),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });

  it("takes an empty reach and 32 entries: what they say is the host's to judge", () => {
    expect(isExecutionFileReach({ entries: [] })).toBe(true);
    expect(
      isExecutionFileReach({
        entries: Array.from({ length: 32 }, () => ({
          path: "/etc",
          access: "write",
        })),
      }),
    ).toBe(true);
  });

  it("names the capability", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain("start.fileReach.v1");
  });
});

describe("a host's fence in its profile", () => {
  it("reads a fencing host's profile whole", () => {
    expect(decodeExecutionHostProfile(fencingHostProfileFixture)).toEqual({
      ok: true,
      value: fencingHostProfileFixture,
    });
  });

  it("reads a host predating fences as one without", () => {
    const decoded = decodeExecutionHostProfile(linuxHostProfileFixture);
    expect(decoded.ok && decoded.value).not.toHaveProperty("fileReach");
  });

  it("reads a host that can't fence, with its reason", () => {
    const none = {
      fence: "none",
      abi: 3,
      places: ["worktree"],
      ceiling: {},
      floor: [],
      reason: "this kernel has Landlock ABI 3; fencing needs 4",
    };
    expect(decodeExecutionHostFileReach(none)).toEqual({
      ok: true,
      value: none,
    });
  });

  it.each([
    ["not an object", "landlock"],
    ["no fence", { ...fencing, fence: undefined }],
    ["an empty fence", { ...fencing, fence: "" }],
    ["a fractional abi", { ...fencing, abi: 4.5 }],
    ["a negative abi", { ...fencing, abi: -1 }],
    ["a Landlock fence with no abi", { ...fencing, abi: null }],
    ["a Landlock fence on ABI 1", { ...fencing, abi: 1 }],
    ["a Landlock fence on ABI 3", { ...fencing, abi: 3 }],
    ["no places", { ...fencing, places: undefined }],
    ["a ceiling list", { ...fencing, ceiling: ["worktree"] }],
    ["no floor", { ...fencing, floor: undefined }],
    ["a reason not a string", { ...fencing, reason: 4 }],
  ])("drops a fence with %s whole, named, as no fence", (_, fileReach) => {
    expect(decodeExecutionHostFileReach(fileReach)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
    const decoded = decodeExecutionHostProfile({
      ...fencingHostProfileFixture,
      fileReach,
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).not.toHaveProperty("fileReach");
    expect(decoded.warnings).toEqual([
      { reason: "dropped-invalid-field", path: "fileReach" },
    ]);
  });

  it("drops an unreadable place, ceiling or floor entry alone, which under-claims", () => {
    const decoded = decodeExecutionHostProfile({
      ...fencingHostProfileFixture,
      fileReach: {
        ...fencing,
        places: ["worktree", 4, "", "tmp", "tmp"],
        ceiling: { worktree: "write", tmp: "execute", ["__proto__"]: "write" },
        floor: [null, "tmp"],
        future: { x: 1 },
      },
    });
    expect(decoded).toEqual({
      ok: true,
      value: {
        ...fencingHostProfileFixture,
        fileReach: {
          ...fencing,
          places: ["worktree", "tmp"],
          ceiling: { worktree: "write" },
          floor: ["tmp"],
        },
      },
      warnings: [
        { reason: "dropped-invalid-field", path: "fileReach.places.1" },
        { reason: "dropped-invalid-field", path: "fileReach.places.2" },
        { reason: "dropped-invalid-field", path: "fileReach.floor.0" },
        { reason: "dropped-invalid-field", path: "fileReach.ceiling.tmp" },
        {
          reason: "dropped-invalid-field",
          path: "fileReach.ceiling.__proto__",
        },
      ],
    });
  });

  it("reads at most 64 places, and names the cut", () => {
    const decoded = decodeExecutionHostFileReach({
      ...fencing,
      places: Array.from({ length: 70 }, (_, index) => `place-${index}`),
    });
    expect(decoded.ok && decoded.value.places).toHaveLength(64);
    expect(decoded.ok && decoded.warnings).toEqual([
      { reason: "dropped-excess-entries", path: "fileReach.places" },
    ]);
  });
});

describe("a host's refusal of a reach", () => {
  it.each(EXECUTION_FILE_REACH_PROBLEMS)(
    "reads a refusal coded %s",
    (problem) => {
      const entry = problem === "cannot-fence" ? null : 0;
      const body = {
        error: `refused: ${problem}`,
        code: "file-reach-refused",
        problems: [{ problem, entry }],
      };
      expect(decodeExecutionFileReachRefusal(body)).toEqual({
        ok: true,
        value: body,
      });
    },
  );

  it("keeps the problems it knows, and words of its own without the host's", () => {
    expect(
      decodeExecutionFileReachRefusal({
        code: "file-reach-refused",
        problems: [
          { problem: "past-ceiling", entry: 2 },
          { problem: "future-problem", entry: 0 },
          { problem: "path-missing", entry: -1 },
          { problem: "path-missing", entry: "1" },
          "unknown-place",
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        error: "The host refused this session's file reach: past-ceiling",
        code: "file-reach-refused",
        problems: [{ problem: "past-ceiling", entry: 2 }],
      },
    });
  });

  it.each([
    ["another code", { code: "requirements-unmet", problems: [] }],
    ["no problems", { code: "file-reach-refused" }],
    [
      "no problem it knows",
      { code: "file-reach-refused", problems: [{ problem: "x", entry: 0 }] },
    ],
    ["an empty list", { code: "file-reach-refused", problems: [] }],
    ["a host predating the code", { error: "Invalid start request" }],
  ])("refuses a body with %s", (_, body) => {
    expect(decodeExecutionFileReachRefusal(body)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});

describe("a host's echo of a reach", () => {
  const asked = reach(["{worktree}", "read"], ["{worktree}/src", "write"]);

  it("confirms the same entries in any order, with an ABI", () => {
    expect(
      confirmsExecutionFileReach(
        {
          fileReach: {
            entries: [...asked.entries].reverse(),
            abi: 4,
          },
        },
        asked,
      ),
    ).toBe(true);
  });

  it.each([
    ["no echo", {}],
    ["a null echo (held to none)", { fileReach: null }],
    ["no ABI", { fileReach: { entries: asked.entries } }],
    ["an ABI of 0", { fileReach: { entries: asked.entries, abi: 0 } }],
    ["an ABI of 1", { fileReach: { entries: asked.entries, abi: 1 } }],
    ["an ABI of 2", { fileReach: { entries: asked.entries, abi: 2 } }],
    ["an ABI of 3", { fileReach: { entries: asked.entries, abi: 3 } }],
    ["a fractional ABI", { fileReach: { entries: asked.entries, abi: 4.5 } }],
    [
      "one entry left out",
      { fileReach: { entries: asked.entries.slice(0, 1), abi: 4 } },
    ],
    [
      "one entry more",
      {
        fileReach: {
          entries: [...asked.entries, { path: "{clone}", access: "read" }],
          abi: 4,
        },
      },
    ],
    [
      "an access widened",
      {
        fileReach: {
          entries: [{ path: "{worktree}", access: "write" }, asked.entries[1]],
          abi: 4,
        },
      },
    ],
    [
      "an unreadable entry",
      { fileReach: { entries: [...asked.entries, 4], abi: 4 } },
    ],
  ])("confirms nothing with %s", (_, answer) => {
    expect(confirmsExecutionFileReach(answer, asked)).toBe(false);
  });
});

describe("the oldest Landlock a fence holds with", () => {
  it("is ABI 4: a Landlock advertisement on it reads, and an echo on it confirms", () => {
    expect(EXECUTION_FILE_REACH_MIN_LANDLOCK_ABI).toBe(4);
    expect(decodeExecutionHostFileReach({ ...fencing, abi: 4 })).toEqual({
      ok: true,
      value: { ...fencing, abi: 4 },
    });
    const asked = reach(["{worktree}", "read"]);
    expect(
      confirmsExecutionFileReach(
        { fileReach: { entries: asked.entries, abi: 4 } },
        asked,
      ),
    ).toBe(true);
  });

  it("is no bar to a host that says it has no fence", () => {
    expect(
      decodeExecutionHostFileReach({
        fence: "none",
        abi: 3,
        places: [],
        ceiling: {},
        floor: [],
      }).ok,
    ).toBe(true);
  });
});
