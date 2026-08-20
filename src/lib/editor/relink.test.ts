import { describe, expect, it } from "vitest";
import type { SvgGroup, SvgShape } from "./model";
import { remapGroupRecord, remapShapeRecord, replacementGroupMap, replacementShapeMap } from "./relink";

const group = (key: string, label: string, sourceId: string | null, parentKey: string | null = null): SvgGroup => ({
  key, label, sourceId, parentKey, depth: parentKey ? 1 : 0,
});
const shape = (key: string, groupKey: string, geometrySignature: string, ordinalInGroup: number, sourceId: string | null = null): SvgShape => ({
  key, groupKey, geometrySignature, ordinalInGroup, sourceId, tagName: "path", presentationSignature: "fill=#fff",
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

  it("keeps a foot pose path on its curve when a new shadow changes document order", () => {
    const previous = [
      shape("shape-10", "foot-old", "d=foot-outline", 0),
      shape("shape-11", "body-old", "d=body", 0),
    ];
    const next = [
      shape("shape-10", "foot-new", "d=new-shadow", 0),
      shape("shape-11", "foot-new", "d=foot-outline", 1),
      shape("shape-12", "body-new", "d=body", 0),
    ];
    const mapping = replacementShapeMap(previous, next, { "foot-old": "foot-new", "body-old": "body-new" });

    expect(mapping).toEqual({ "shape-10": "shape-11", "shape-11": "shape-12" });
    expect(remapShapeRecord({ "shape-10": "posed-foot-path" }, mapping)).toEqual({ "shape-11": "posed-foot-path" });
  });

  it("drops an uncertain override instead of projecting it onto an inserted curve", () => {
    const previous = [shape("shape-2", "foot-old", "d=old-foot", 0)];
    const next = [
      shape("shape-2", "foot-new", "d=shadow", 0),
      shape("shape-3", "foot-new", "d=redrawn-foot", 1),
    ];
    expect(replacementShapeMap(previous, next, { "foot-old": "foot-new" })).toEqual({});
  });
});
