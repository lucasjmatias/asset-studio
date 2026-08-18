import { describe, expect, it } from "vitest";

import { appendHistory, cloneSerializable, snapshotsEqual } from "./history";

describe("editor history", () => {
  it("clones snapshots so later pose edits cannot mutate undo state", () => {
    const source = { poses: [{ visibility: { mouthOpen: true } }] };
    const snapshot = cloneSerializable(source);
    source.poses[0].visibility.mouthOpen = false;
    expect(snapshot.poses[0].visibility.mouthOpen).toBe(true);
  });

  it("caps history while preserving the newest command", () => {
    const entries = [0, 1, 2].map((value) => ({ label: String(value), before: value, after: value + 1 }));
    const next = appendHistory(entries, { label: "3", before: 3, after: 4 }, 3);
    expect(next.map((entry) => entry.label)).toEqual(["1", "2", "3"]);
  });

  it("compares serializable document snapshots", () => {
    expect(snapshotsEqual({ visibility: { footA: false } }, { visibility: { footA: false } })).toBe(true);
    expect(snapshotsEqual({ visibility: { footA: false } }, { visibility: { footA: true } })).toBe(false);
  });
});
