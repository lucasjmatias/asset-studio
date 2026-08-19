import { describe, expect, it } from "vitest";
import type { SvgGroup } from "./model";
import { remapGroupRecord, replacementGroupMap } from "./relink";

const group = (key: string, label: string, sourceId: string | null, parentKey: string | null = null): SvgGroup => ({
  key, label, sourceId, parentKey, depth: parentKey ? 1 : 0,
});

describe("replacement SVG relinking", () => {
  it("keeps bindings on SVG ids when document order changes", () => {
    const previous = [group("group-0", "Arm", "arm"), group("group-1", "Hand", "hand", "group-0")];
    const next = [group("group-0", "Decoration", "decoration"), group("group-1", "Arm", "arm"), group("group-2", "Hand", "hand", "group-1")];
    expect(replacementGroupMap(previous, next)).toEqual({ "group-0": "group-1", "group-1": "group-2" });
  });

  it("uses hierarchy to distinguish repeated labels", () => {
    const previous = [group("group-0", "Left", null), group("group-1", "Hand", null, "group-0")];
    const next = [group("group-0", "Extra", null), group("group-1", "Left", null), group("group-2", "Hand", null, "group-1")];
    expect(replacementGroupMap(previous, next)).toEqual({ "group-0": "group-1", "group-1": "group-2" });
  });

  it("drops state for groups that no longer exist", () => {
    expect(remapGroupRecord({ "group-0": 10, "group-1": 20 }, { "group-1": "group-4" })).toEqual({ "group-4": 20 });
  });
});
