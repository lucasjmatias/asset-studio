import type { SvgGroup } from "./model";

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function uniqueIndex(groups: SvgGroup[], value: (group: SvgGroup) => string): Map<string, string> {
  const candidates = new Map<string, string[]>();
  for (const group of groups) {
    const signature = value(group);
    if (!signature) continue;
    candidates.set(signature, [...(candidates.get(signature) ?? []), group.key]);
  }
  return new Map(
    [...candidates.entries()]
      .filter(([, keys]) => keys.length === 1)
      .map(([signature, keys]) => [signature, keys[0]]),
  );
}

function hierarchySignature(group: SvgGroup, byKey: Map<string, SvgGroup>): string {
  const parts: string[] = [];
  let cursor: SvgGroup | undefined = group;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.key)) {
    visited.add(cursor.key);
    parts.unshift(normalized(cursor.sourceId) || normalized(cursor.label));
    cursor = cursor.parentKey ? byKey.get(cursor.parentKey) : undefined;
  }
  return parts.join("/");
}

/**
 * Matches groups across a source-SVG revision without trusting generated
 * group-N keys. SVG ids win, then an ancestry signature, then a unique label.
 */
export function replacementGroupMap(previous: SvgGroup[], next: SvgGroup[]): Record<string, string> {
  const result: Record<string, string> = {};
  const used = new Set<string>();
  const previousByKey = new Map(previous.map((group) => [group.key, group]));
  const nextByKey = new Map(next.map((group) => [group.key, group]));
  const nextById = uniqueIndex(next, (group) => normalized(group.sourceId));
  const nextByHierarchy = uniqueIndex(next, (group) => hierarchySignature(group, nextByKey));
  const nextByLabel = uniqueIndex(next, (group) => normalized(group.label));

  const link = (oldKey: string, newKey: string | undefined) => {
    if (!newKey || used.has(newKey)) return false;
    result[oldKey] = newKey;
    used.add(newKey);
    return true;
  };

  for (const group of previous) {
    const sourceId = normalized(group.sourceId);
    if (sourceId) link(group.key, nextById.get(sourceId));
  }
  for (const group of previous) {
    if (result[group.key]) continue;
    link(group.key, nextByHierarchy.get(hierarchySignature(group, previousByKey)));
  }
  for (const group of previous) {
    if (result[group.key]) continue;
    const candidate = nextByLabel.get(normalized(group.label));
    const mappedParent = group.parentKey ? result[group.parentKey] : null;
    const candidateGroup = candidate ? nextByKey.get(candidate) : undefined;
    if (candidateGroup && (!group.parentKey || candidateGroup.parentKey === mappedParent)) link(group.key, candidate);
  }
  for (const group of previous) {
    if (result[group.key]) continue;
    const sameOrdinal = nextByKey.get(group.key);
    if (sameOrdinal && normalized(sameOrdinal.label) === normalized(group.label)) link(group.key, sameOrdinal.key);
  }
  return result;
}

export function remapGroupRecord<T>(record: Record<string, T> | undefined, mapping: Record<string, string>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([key, value]) => mapping[key] ? [[mapping[key], value]] : []),
  );
}
