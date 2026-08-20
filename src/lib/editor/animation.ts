export function wrappedPoseNeighbors<T extends { id: string }>(
  poses: T[],
  activeId: string,
): { previous: T; next: T } | null {
  if (poses.length < 2) return null;
  const index = poses.findIndex((pose) => pose.id === activeId);
  if (index < 0) return null;
  return {
    previous: poses[(index - 1 + poses.length) % poses.length],
    next: poses[(index + 1) % poses.length],
  };
}

export function steppedPoseId<T extends { id: string }>(
  poses: T[],
  activeId: string,
  direction: -1 | 1,
): string | null {
  if (poses.length === 0) return null;
  const index = poses.findIndex((pose) => pose.id === activeId);
  if (index < 0) return direction > 0 ? poses[0].id : poses.at(-1)!.id;
  return poses[(index + direction + poses.length) % poses.length].id;
}
