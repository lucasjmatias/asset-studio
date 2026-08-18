export type HistoryEntry<T> = {
  label: string;
  before: T;
  after: T;
};

export function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function snapshotsEqual<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function appendHistory<T>(
  stack: HistoryEntry<T>[],
  entry: HistoryEntry<T>,
  limit = 100,
): HistoryEntry<T>[] {
  const keep = Math.max(0, Math.max(1, limit) - 1);
  return [...(keep ? stack.slice(-keep) : []), entry];
}
