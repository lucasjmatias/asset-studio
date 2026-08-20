import type { NodeMode } from "./model";

export type PathCommand = {
  type: "M" | "L" | "C" | "Q" | "A" | "Z";
  values: number[];
};

export type PathHandle = {
  id: string;
  commandIndex: number;
  valueOffset: number;
  kind: "anchor" | "control";
  x: number;
  y: number;
};

export type ControlGuide = {
  nodeIndex: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type Point = { x: number; y: number };

export type PathBoneInfluence = {
  start: Point;
  end: Point;
  matrix: [number, number, number, number, number, number];
};

const parameterCount: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

const numberPattern = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:e[+-]?\d+)?$/i;

function isCommand(value: string | undefined): boolean {
  return Boolean(value && /^[a-z]$/i.test(value));
}

function pointFor(command: PathCommand | undefined): { x: number; y: number } | null {
  if (!command || command.type === "Z") return null;
  const values = command.values;
  return { x: values.at(-2) ?? 0, y: values.at(-1) ?? 0 };
}

export function parsePathData(path: string): PathCommand[] {
  const tokens = path.match(/[a-zA-Z]|[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g) ?? [];
  const commands: PathCommand[] = [];
  let cursor = 0;
  let rawCommand = "";
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  let previousCubicControl: { x: number; y: number } | null = null;
  let previousQuadraticControl: { x: number; y: number } | null = null;

  while (cursor < tokens.length) {
    if (isCommand(tokens[cursor])) rawCommand = tokens[cursor++];
    if (!rawCommand) throw new Error("Path data starts without a command.");
    const upper = rawCommand.toUpperCase();
    const relative = rawCommand !== upper;
    const count = parameterCount[upper];
    if (count === undefined) throw new Error(`Unsupported SVG path command: ${rawCommand}`);

    if (upper === "Z") {
      commands.push({ type: "Z", values: [] });
      current = { ...subpathStart };
      previousCubicControl = null;
      previousQuadraticControl = null;
      rawCommand = "";
      continue;
    }

    let firstMove = upper === "M";
    let consumed = false;
    while (cursor < tokens.length && !isCommand(tokens[cursor])) {
      const chunk = tokens.slice(cursor, cursor + count);
      if (chunk.length < count || chunk.some((value) => !numberPattern.test(value))) {
        throw new Error(`Incomplete SVG path command: ${rawCommand}`);
      }
      cursor += count;
      consumed = true;
      const values = chunk.map(Number);
      const origin = { ...current };

      if (upper === "M" || upper === "L") {
        const x = values[0] + (relative ? origin.x : 0);
        const y = values[1] + (relative ? origin.y : 0);
        const type = upper === "M" && firstMove ? "M" : "L";
        commands.push({ type, values: [x, y] });
        current = { x, y };
        if (type === "M") subpathStart = { ...current };
        firstMove = false;
      } else if (upper === "H") {
        const x = values[0] + (relative ? origin.x : 0);
        commands.push({ type: "L", values: [x, origin.y] });
        current = { x, y: origin.y };
      } else if (upper === "V") {
        const y = values[0] + (relative ? origin.y : 0);
        commands.push({ type: "L", values: [origin.x, y] });
        current = { x: origin.x, y };
      } else if (upper === "C") {
        const absolute = values.map((value, index) => value + (relative ? (index % 2 === 0 ? origin.x : origin.y) : 0));
        commands.push({ type: "C", values: absolute });
        previousCubicControl = { x: absolute[2], y: absolute[3] };
        current = { x: absolute[4], y: absolute[5] };
      } else if (upper === "S") {
        const reflected = previousCubicControl
          ? { x: 2 * origin.x - previousCubicControl.x, y: 2 * origin.y - previousCubicControl.y }
          : origin;
        const x2 = values[0] + (relative ? origin.x : 0);
        const y2 = values[1] + (relative ? origin.y : 0);
        const x = values[2] + (relative ? origin.x : 0);
        const y = values[3] + (relative ? origin.y : 0);
        commands.push({ type: "C", values: [reflected.x, reflected.y, x2, y2, x, y] });
        previousCubicControl = { x: x2, y: y2 };
        current = { x, y };
      } else if (upper === "Q") {
        const absolute = values.map((value, index) => value + (relative ? (index % 2 === 0 ? origin.x : origin.y) : 0));
        commands.push({ type: "Q", values: absolute });
        previousQuadraticControl = { x: absolute[0], y: absolute[1] };
        current = { x: absolute[2], y: absolute[3] };
      } else if (upper === "T") {
        const reflected: { x: number; y: number } = previousQuadraticControl
          ? { x: 2 * origin.x - previousQuadraticControl.x, y: 2 * origin.y - previousQuadraticControl.y }
          : origin;
        const x = values[0] + (relative ? origin.x : 0);
        const y = values[1] + (relative ? origin.y : 0);
        commands.push({ type: "Q", values: [reflected.x, reflected.y, x, y] });
        previousQuadraticControl = reflected;
        current = { x, y };
      } else if (upper === "A") {
        const x = values[5] + (relative ? origin.x : 0);
        const y = values[6] + (relative ? origin.y : 0);
        commands.push({ type: "A", values: [Math.abs(values[0]), Math.abs(values[1]), values[2], values[3] ? 1 : 0, values[4] ? 1 : 0, x, y] });
        current = { x, y };
      }

      if (upper !== "C" && upper !== "S") previousCubicControl = null;
      if (upper !== "Q" && upper !== "T") previousQuadraticControl = null;
    }
    if (!consumed) throw new Error(`SVG path command ${rawCommand} has no parameters.`);
  }
  return commands;
}

function rounded(value: number): string {
  const normalized = Math.abs(value) < 0.00005 ? 0 : Number(value.toFixed(4));
  return String(normalized);
}

export function serializePathData(commands: PathCommand[]): string {
  return commands.map((command) => command.type === "Z"
    ? "Z"
    : `${command.type}${command.values.map(rounded).join(" ")}`,
  ).join(" ");
}

function pointsMatch(left: Point | null, right: Point | null, epsilon = 0.0001): boolean {
  return Boolean(left && right && Math.hypot(left.x - right.x, left.y - right.y) <= epsilon);
}

function subpathStartIndex(commands: PathCommand[], commandIndex: number): number | null {
  for (let cursor = commandIndex; cursor >= 0; cursor -= 1) {
    if (commands[cursor]?.type === "M") return cursor;
    if (commands[cursor]?.type === "Z") break;
  }
  return null;
}

function subpathCloseIndex(commands: PathCommand[], startIndex: number): number | null {
  for (let cursor = startIndex + 1; cursor < commands.length; cursor += 1) {
    if (commands[cursor].type === "Z") return cursor;
    if (commands[cursor].type === "M") return null;
  }
  return null;
}

function explicitClosingIndex(commands: PathCommand[], commandIndex: number): number | null {
  const startIndex = subpathStartIndex(commands, commandIndex);
  if (startIndex === null) return null;
  const closeIndex = subpathCloseIndex(commands, startIndex);
  if (closeIndex === null || closeIndex <= startIndex + 1) return null;
  const candidate = closeIndex - 1;
  return pointsMatch(pointFor(commands[candidate]), pointFor(commands[startIndex])) ? candidate : null;
}

function endpointOwnerIndex(commands: PathCommand[], commandIndex: number): number {
  const closingIndex = explicitClosingIndex(commands, commandIndex);
  if (closingIndex === commandIndex) return subpathStartIndex(commands, commandIndex) ?? commandIndex;
  return commandIndex;
}

function isClosingDuplicate(commands: PathCommand[], commandIndex: number): boolean {
  return explicitClosingIndex(commands, commandIndex) === commandIndex;
}

export function pathHandles(commands: PathCommand[]): PathHandle[] {
  return commands.flatMap((command, commandIndex): PathHandle[] => {
    if (command.type === "Z") return [];
    const anchorOffset = command.values.length - 2;
    const handles: PathHandle[] = isClosingDuplicate(commands, commandIndex) ? [] : [{
      id: `${commandIndex}:anchor`, commandIndex, valueOffset: anchorOffset, kind: "anchor",
      x: command.values[anchorOffset], y: command.values[anchorOffset + 1],
    }];
    if (command.type === "C") {
      handles.unshift(
        { id: `${commandIndex}:control-1`, commandIndex, valueOffset: 0, kind: "control", x: command.values[0], y: command.values[1] },
        { id: `${commandIndex}:control-2`, commandIndex, valueOffset: 2, kind: "control", x: command.values[2], y: command.values[3] },
      );
    } else if (command.type === "Q") {
      handles.unshift({ id: `${commandIndex}:control`, commandIndex, valueOffset: 0, kind: "control", x: command.values[0], y: command.values[1] });
    }
    return handles;
  });
}

function previousAnchorIndex(commands: PathCommand[], index: number): number | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (commands[cursor].type !== "Z") return cursor;
  }
  return null;
}

export function nodeIndexForHandle(commands: PathCommand[], handle: PathHandle): number {
  if (handle.kind === "anchor") return endpointOwnerIndex(commands, handle.commandIndex);
  if (handle.valueOffset === 0 && commands[handle.commandIndex]?.type === "C") {
    return previousAnchorIndex(commands, handle.commandIndex) ?? handle.commandIndex;
  }
  return endpointOwnerIndex(commands, handle.commandIndex);
}

export function pathControlGuides(commands: PathCommand[]): ControlGuide[] {
  const guides: ControlGuide[] = [];
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  for (const [commandIndex, command] of commands.entries()) {
    if (command.type === "M") {
      current = { x: command.values[0], y: command.values[1] };
      subpathStart = { ...current };
    } else if (command.type === "C") {
      guides.push({ nodeIndex: previousAnchorIndex(commands, commandIndex) ?? commandIndex, x1: current.x, y1: current.y, x2: command.values[0], y2: command.values[1] });
      guides.push({ nodeIndex: endpointOwnerIndex(commands, commandIndex), x1: command.values[4], y1: command.values[5], x2: command.values[2], y2: command.values[3] });
      current = { x: command.values[4], y: command.values[5] };
    } else if (command.type === "Q") {
      guides.push({ nodeIndex: previousAnchorIndex(commands, commandIndex) ?? commandIndex, x1: current.x, y1: current.y, x2: command.values[0], y2: command.values[1] });
      guides.push({ nodeIndex: endpointOwnerIndex(commands, commandIndex), x1: command.values[2], y1: command.values[3], x2: command.values[0], y2: command.values[1] });
      current = { x: command.values[2], y: command.values[3] };
    } else if (command.type === "Z") {
      current = { ...subpathStart };
    } else {
      current = pointFor(command) ?? current;
    }
  }
  return guides;
}

function oppositeControl(commands: PathCommand[], handle: PathHandle): { commandIndex: number; valueOffset: number } | null {
  const owner = nodeIndexForHandle(commands, handle);
  if (handle.valueOffset === 0 && commands[handle.commandIndex]?.type === "C") {
    const startIndex = subpathStartIndex(commands, owner);
    const incomingIndex = owner === startIndex ? explicitClosingIndex(commands, owner) : owner;
    const incoming = incomingIndex === null ? null : commands[incomingIndex];
    return incoming?.type === "C" ? { commandIndex: incomingIndex!, valueOffset: 2 } : null;
  }
  const outgoing = commands[owner + 1];
  return outgoing?.type === "C" ? { commandIndex: owner + 1, valueOffset: 0 } : null;
}

export function movePathHandle(commands: PathCommand[], handle: PathHandle, x: number, y: number, mode: NodeMode = "sharp"): PathCommand[] {
  const next = commands.map((command) => ({ ...command, values: [...command.values] }));
  const command = next[handle.commandIndex];
  if (!command || command.type === "Z") return next;
  const oldX = command.values[handle.valueOffset];
  const oldY = command.values[handle.valueOffset + 1];
  const dx = x - oldX;
  const dy = y - oldY;
  command.values[handle.valueOffset] = x;
  command.values[handle.valueOffset + 1] = y;

  if (handle.kind === "anchor") {
    if (command.type === "C") {
      command.values[2] += dx;
      command.values[3] += dy;
    } else if (command.type === "Q") {
      command.values[0] += dx;
      command.values[1] += dy;
    }
    const following = next[handle.commandIndex + 1];
    if (following?.type === "C" || following?.type === "Q") {
      following.values[0] += dx;
      following.values[1] += dy;
    }
    if (command.type === "M") {
      const closingIndex = explicitClosingIndex(next, handle.commandIndex);
      const incoming = closingIndex === null ? undefined : next[closingIndex];
      if (incoming?.type === "C") {
        incoming.values[2] += dx;
        incoming.values[3] += dy;
        incoming.values[4] += dx;
        incoming.values[5] += dy;
      } else if (incoming?.type === "Q") {
        incoming.values[0] += dx;
        incoming.values[1] += dy;
        incoming.values[2] += dx;
        incoming.values[3] += dy;
      }
    }
  } else if (mode === "smart") {
    const ownerIndex = nodeIndexForHandle(next, handle);
    const owner = pointFor(next[ownerIndex]);
    const opposite = oppositeControl(next, handle);
    if (owner && opposite) {
      const oppositeCommand = next[opposite.commandIndex];
      const oldOpposite = {
        x: oppositeCommand.values[opposite.valueOffset],
        y: oppositeCommand.values[opposite.valueOffset + 1],
      };
      const movedVector = { x: x - owner.x, y: y - owner.y };
      const movedLength = Math.max(0.001, Math.hypot(movedVector.x, movedVector.y));
      const oppositeLength = mode === "smart" ? movedLength : Math.max(0.001, Math.hypot(oldOpposite.x - owner.x, oldOpposite.y - owner.y));
      oppositeCommand.values[opposite.valueOffset] = owner.x - movedVector.x / movedLength * oppositeLength;
      oppositeCommand.values[opposite.valueOffset + 1] = owner.y - movedVector.y / movedLength * oppositeLength;
    }
  }
  return next;
}

function segmentStart(commands: PathCommand[], commandIndex: number): Point | null {
  const previous = previousAnchorIndex(commands, commandIndex);
  return previous === null ? null : pointFor(commands[previous]);
}

function cubicSegment(command: PathCommand, start: Point): PathCommand {
  const end = pointFor(command) ?? start;
  if (command.type === "C") return { ...command, values: [...command.values] };
  if (command.type === "Q") {
    const control = { x: command.values[0], y: command.values[1] };
    return { type: "C", values: [
      start.x + (control.x - start.x) * 2 / 3,
      start.y + (control.y - start.y) * 2 / 3,
      end.x + (control.x - end.x) * 2 / 3,
      end.y + (control.y - end.y) * 2 / 3,
      end.x, end.y,
    ] };
  }
  if (command.type === "L") {
    return { type: "C", values: [
      start.x + (end.x - start.x) / 3, start.y + (end.y - start.y) / 3,
      start.x + (end.x - start.x) * 2 / 3, start.y + (end.y - start.y) * 2 / 3,
      end.x, end.y,
    ] };
  }
  return { ...command, values: [...command.values] };
}

function ensureCubicClosure(commands: PathCommand[], nodeIndex: number): number | null {
  const startIndex = subpathStartIndex(commands, nodeIndex);
  if (startIndex === null) return null;
  const closeIndex = subpathCloseIndex(commands, startIndex);
  if (closeIndex === null) return null;
  const existing = explicitClosingIndex(commands, nodeIndex);
  if (existing !== null) {
    const start = segmentStart(commands, existing);
    if (start && ["L", "Q", "C"].includes(commands[existing].type)) commands[existing] = cubicSegment(commands[existing], start);
    return existing;
  }
  const lastIndex = closeIndex - 1;
  const from = pointFor(commands[lastIndex]);
  const to = pointFor(commands[startIndex]);
  if (!from || !to) return null;
  const closing: PathCommand = { type: "C", values: [
    from.x + (to.x - from.x) / 3,
    from.y + (to.y - from.y) / 3,
    from.x + (to.x - from.x) * 2 / 3,
    from.y + (to.y - from.y) * 2 / 3,
    to.x,
    to.y,
  ] };
  commands.splice(closeIndex, 0, closing);
  return closeIndex;
}

export function configurePathNode(commands: PathCommand[], nodeIndex: number, mode: NodeMode): PathCommand[] {
  const next = commands.map((command) => ({ ...command, values: [...command.values] }));
  if (!next[nodeIndex] || next[nodeIndex].type === "Z") return next;
  const anchor = pointFor(next[nodeIndex]);
  if (!anchor) return next;
  const startIndex = subpathStartIndex(next, nodeIndex);
  const closingIndex = ensureCubicClosure(next, nodeIndex);
  const incomingIndex = nodeIndex === startIndex ? closingIndex : nodeIndex;
  const outgoingIndex = nodeIndex + 1;
  if (mode === "sharp") {
    // A Corner node has no local pullers. Cubic segments remain cubic so the
    // neighboring nodes keep their curvature, but both controls at this node
    // collapse exactly onto the anchor to form a cusp/square corner.
    if (incomingIndex !== null && next[incomingIndex]?.type === "Q") {
      const start = segmentStart(next, incomingIndex);
      if (start) next[incomingIndex] = cubicSegment(next[incomingIndex], start);
    }
    if (next[outgoingIndex]?.type === "Q") next[outgoingIndex] = cubicSegment(next[outgoingIndex], anchor);
    if (incomingIndex !== null && next[incomingIndex]?.type === "C") {
      next[incomingIndex].values[2] = anchor.x;
      next[incomingIndex].values[3] = anchor.y;
    }
    if (next[outgoingIndex]?.type === "C") {
      next[outgoingIndex].values[0] = anchor.x;
      next[outgoingIndex].values[1] = anchor.y;
    }
    return next;
  }
  if (incomingIndex !== null && ["L", "Q", "C"].includes(next[incomingIndex]?.type)) {
    const start = segmentStart(next, incomingIndex);
    if (start) next[incomingIndex] = cubicSegment(next[incomingIndex], start);
  }
  if (next[outgoingIndex] && ["L", "Q", "C"].includes(next[outgoingIndex].type)) {
    const start = pointFor(next[nodeIndex]);
    if (start) next[outgoingIndex] = cubicSegment(next[outgoingIndex], start);
  }
  const incoming = incomingIndex !== null && next[incomingIndex]?.type === "C" ? { command: next[incomingIndex], offset: 2 } : null;
  const outgoing = next[outgoingIndex]?.type === "C" ? { command: next[outgoingIndex], offset: 0 } : null;
  // Smooth intentionally exposes two independent pullers. Converting line or
  // quadratic segments above creates them without changing the current curve.
  if (mode === "smooth") return next;
  if (!anchor || !incoming || !outgoing) return next;
  const incomingVector = { x: incoming.command.values[2] - anchor.x, y: incoming.command.values[3] - anchor.y };
  const outgoingVector = { x: outgoing.command.values[0] - anchor.x, y: outgoing.command.values[1] - anchor.y };
  const incomingLength = Math.max(0.001, Math.hypot(incomingVector.x, incomingVector.y));
  const outgoingLength = Math.max(0.001, Math.hypot(outgoingVector.x, outgoingVector.y));
  const directionSource = outgoingLength > 0.001 ? outgoingVector : { x: -incomingVector.x, y: -incomingVector.y };
  const directionLength = Math.max(0.001, Math.hypot(directionSource.x, directionSource.y));
  const unit = { x: directionSource.x / directionLength, y: directionSource.y / directionLength };
  const sharedLength = (incomingLength + outgoingLength) / 2;
  const leftLength = sharedLength;
  const rightLength = sharedLength;
  incoming.command.values[2] = anchor.x - unit.x * leftLength;
  incoming.command.values[3] = anchor.y - unit.y * leftLength;
  outgoing.command.values[0] = anchor.x + unit.x * rightLength;
  outgoing.command.values[1] = anchor.y + unit.y * rightLength;
  return next;
}

export function addPathNodeAfter(commands: PathCommand[], nodeIndex: number): { commands: PathCommand[]; nodeIndex: number } | null {
  const next = commands.map((command) => ({ ...command, values: [...command.values] }));
  const start = pointFor(next[nodeIndex]);
  const segmentIndex = nodeIndex + 1;
  const segment = next[segmentIndex];
  if (!start || !segment) return null;
  if (segment.type === "Z") {
    const first = next.find((command) => command.type === "M");
    const end = pointFor(first);
    if (!end) return null;
    next.splice(segmentIndex, 0, { type: "L", values: [(start.x + end.x) / 2, (start.y + end.y) / 2] });
    return { commands: next, nodeIndex: segmentIndex };
  }
  const end = pointFor(segment);
  if (!end) return null;
  if (segment.type === "L") {
    next.splice(segmentIndex, 0, { type: "L", values: [(start.x + end.x) / 2, (start.y + end.y) / 2] });
  } else if (segment.type === "C") {
    const p1 = { x: segment.values[0], y: segment.values[1] };
    const p2 = { x: segment.values[2], y: segment.values[3] };
    const a = { x: (start.x + p1.x) / 2, y: (start.y + p1.y) / 2 };
    const b = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const c = { x: (p2.x + end.x) / 2, y: (p2.y + end.y) / 2 };
    const d = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const e = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
    const midpoint = { x: (d.x + e.x) / 2, y: (d.y + e.y) / 2 };
    next.splice(segmentIndex, 1,
      { type: "C", values: [a.x, a.y, d.x, d.y, midpoint.x, midpoint.y] },
      { type: "C", values: [e.x, e.y, c.x, c.y, end.x, end.y] },
    );
  } else if (segment.type === "Q") {
    const control = { x: segment.values[0], y: segment.values[1] };
    const a = { x: (start.x + control.x) / 2, y: (start.y + control.y) / 2 };
    const b = { x: (control.x + end.x) / 2, y: (control.y + end.y) / 2 };
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    next.splice(segmentIndex, 1,
      { type: "Q", values: [a.x, a.y, midpoint.x, midpoint.y] },
      { type: "Q", values: [b.x, b.y, end.x, end.y] },
    );
  } else if (segment.type === "A") {
    const samples = arcPoints(start, segment.values, 64);
    const midpoint = samples[Math.max(0, Math.floor((samples.length - 1) / 2))];
    const [rx, ry, rotation, , sweep] = segment.values;
    next.splice(segmentIndex, 1,
      { type: "A", values: [rx, ry, rotation, 0, sweep, midpoint.x, midpoint.y] },
      { type: "A", values: [rx, ry, rotation, 0, sweep, end.x, end.y] },
    );
  } else return null;
  return { commands: next, nodeIndex: segmentIndex };
}

export function removePathNode(commands: PathCommand[], nodeIndex: number): { commands: PathCommand[]; nodeIndex: number | null } | null {
  const anchors = commands.filter((command) => command.type !== "Z");
  if (anchors.length <= 3 || !commands[nodeIndex] || commands[nodeIndex].type === "Z") return null;
  const next = commands.map((command) => ({ ...command, values: [...command.values] }));
  if (nodeIndex === 0) {
    const following = next[1];
    const endpoint = pointFor(following);
    if (!following || following.type === "Z" || !endpoint) return null;
    next.splice(0, 2, { type: "M", values: [endpoint.x, endpoint.y] });
    return { commands: next, nodeIndex: 0 };
  }
  next.splice(nodeIndex, 1);
  return { commands: next, nodeIndex: Math.max(0, nodeIndex - 1) };
}

function arcPoints(start: Point, values: number[], steps = 18): Point[] {
  let [rx, ry, rotation, largeArc, sweep, endX, endY] = values;
  if (rx === 0 || ry === 0 || (start.x === endX && start.y === endY)) return [{ x: endX, y: endY }];
  const phi = rotation * Math.PI / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start.x - endX) / 2;
  const dy = (start.y - endY) / 2;
  const xPrime = cosPhi * dx + sinPhi * dy;
  const yPrime = -sinPhi * dx + cosPhi * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const scale = Math.sqrt(Math.max(1, (xPrime * xPrime) / (rx * rx) + (yPrime * yPrime) / (ry * ry)));
  rx *= scale;
  ry *= scale;
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * yPrime * yPrime - ry * ry * xPrime * xPrime);
  const denominator = rx * rx * yPrime * yPrime + ry * ry * xPrime * xPrime;
  const sign = largeArc === sweep ? -1 : 1;
  const coefficient = denominator === 0 ? 0 : sign * Math.sqrt(numerator / denominator);
  const centerPrime = {
    x: coefficient * rx * yPrime / ry,
    y: coefficient * -ry * xPrime / rx,
  };
  const center = {
    x: cosPhi * centerPrime.x - sinPhi * centerPrime.y + (start.x + endX) / 2,
    y: sinPhi * centerPrime.x + cosPhi * centerPrime.y + (start.y + endY) / 2,
  };
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const length = Math.max(1e-12, Math.hypot(ux, uy) * Math.hypot(vx, vy));
    const value = Math.acos(Math.max(-1, Math.min(1, dot / length)));
    return ux * vy - uy * vx < 0 ? -value : value;
  };
  const ux = (xPrime - centerPrime.x) / rx;
  const uy = (yPrime - centerPrime.y) / ry;
  const vx = (-xPrime - centerPrime.x) / rx;
  const vy = (-yPrime - centerPrime.y) / ry;
  const startAngle = angle(1, 0, ux, uy);
  let delta = angle(ux, uy, vx, vy);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  const count = Math.max(4, Math.ceil(Math.abs(delta) / (Math.PI * 2) * steps));
  return Array.from({ length: count }, (_, index) => {
    const theta = startAngle + delta * (index + 1) / count;
    const x = rx * Math.cos(theta);
    const y = ry * Math.sin(theta);
    return {
      x: center.x + cosPhi * x - sinPhi * y,
      y: center.y + sinPhi * x + cosPhi * y,
    };
  });
}

export function pathArea(commands: PathCommand[], curveSteps = 18): number {
  const lineIntegral = (from: Point, to: Point) => (from.x * to.y - to.x * from.y) / 2;
  const gaussNodes = [-0.906179845938664, -0.538469310105683, 0, 0.538469310105683, 0.906179845938664];
  const gaussWeights = [0.236926885056189, 0.478628670499366, 0.568888888888889, 0.478628670499366, 0.236926885056189];
  const bezierIntegral = (sample: (t: number) => { point: Point; derivative: Point }) => gaussNodes.reduce((sum, node, index) => {
    const { point, derivative } = sample((node + 1) / 2);
    return sum + gaussWeights[index] * (point.x * derivative.y - point.y * derivative.x) / 4;
  }, 0);
  let signedArea = 0;
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let subpathOpen = false;
  const closeSubpath = () => {
    if (!subpathOpen) return;
    signedArea += lineIntegral(current, start);
    current = { ...start };
    subpathOpen = false;
  };
  for (const command of commands) {
    if (command.type === "M") {
      closeSubpath();
      current = { x: command.values[0], y: command.values[1] };
      start = { ...current };
      subpathOpen = true;
    } else if (command.type === "L") {
      const end = { x: command.values[0], y: command.values[1] };
      signedArea += lineIntegral(current, end);
      current = end;
    } else if (command.type === "C") {
      const origin = { ...current };
      signedArea += bezierIntegral((t) => {
        const u = 1 - t;
        return {
          point: {
            x: u ** 3 * origin.x + 3 * u ** 2 * t * command.values[0] + 3 * u * t ** 2 * command.values[2] + t ** 3 * command.values[4],
            y: u ** 3 * origin.y + 3 * u ** 2 * t * command.values[1] + 3 * u * t ** 2 * command.values[3] + t ** 3 * command.values[5],
          },
          derivative: {
            x: 3 * u ** 2 * (command.values[0] - origin.x) + 6 * u * t * (command.values[2] - command.values[0]) + 3 * t ** 2 * (command.values[4] - command.values[2]),
            y: 3 * u ** 2 * (command.values[1] - origin.y) + 6 * u * t * (command.values[3] - command.values[1]) + 3 * t ** 2 * (command.values[5] - command.values[3]),
          },
        };
      });
      current = { x: command.values[4], y: command.values[5] };
    } else if (command.type === "Q") {
      const origin = { ...current };
      signedArea += bezierIntegral((t) => {
        const u = 1 - t;
        return {
          point: {
            x: u ** 2 * origin.x + 2 * u * t * command.values[0] + t ** 2 * command.values[2],
            y: u ** 2 * origin.y + 2 * u * t * command.values[1] + t ** 2 * command.values[3],
          },
          derivative: {
            x: 2 * u * (command.values[0] - origin.x) + 2 * t * (command.values[2] - command.values[0]),
            y: 2 * u * (command.values[1] - origin.y) + 2 * t * (command.values[3] - command.values[1]),
          },
        };
      });
      current = { x: command.values[2], y: command.values[3] };
    } else if (command.type === "A") {
      const arc = arcPoints(current, command.values, curveSteps);
      for (const point of arc) {
        signedArea += lineIntegral(current, point);
        current = point;
      }
      current = { x: command.values[5], y: command.values[6] };
    } else if (command.type === "Z") {
      closeSubpath();
    }
  }
  closeSubpath();
  return Math.abs(signedArea);
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const amount = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - start.x - dx * amount, point.y - start.y - dy * amount);
}

function weightedBonePoint(point: Point, influences: PathBoneInfluence[]): Point {
  let total = 0;
  let x = 0;
  let y = 0;
  for (const influence of influences) {
    const boneLength = Math.max(1, Math.hypot(influence.end.x - influence.start.x, influence.end.y - influence.start.y));
    const normalizedDistance = distanceToSegment(point, influence.start, influence.end) / boneLength;
    const weight = 1 / (0.08 + normalizedDistance) ** 2;
    const matrix = influence.matrix;
    x += (matrix[0] * point.x + matrix[2] * point.y + matrix[4]) * weight;
    y += (matrix[1] * point.x + matrix[3] * point.y + matrix[5]) * weight;
    total += weight;
  }
  return total > 0 ? { x: x / total, y: y / total } : point;
}

function coordinateOffsets(command: PathCommand): number[] {
  if (command.type === "M" || command.type === "L") return [0];
  if (command.type === "C") return [0, 2, 4];
  if (command.type === "Q") return [0, 2];
  if (command.type === "A") return [5];
  return [];
}

/**
 * Pose-only linear skinning for SVG path anchors and pullers. Every point is
 * blended by proximity to the rest bones, then a uniform correction restores
 * the exact area the pose had before rig deformation.
 */
export function deformPathWithBones(
  commands: PathCommand[],
  influences: PathBoneInfluence[],
  preserveVolume = true,
): PathCommand[] {
  if (influences.length < 2) return commands.map((command) => ({ ...command, values: [...command.values] }));
  const targetArea = pathArea(commands);
  const next = commands.map((command) => {
    const values = [...command.values];
    for (const offset of coordinateOffsets(command)) {
      const transformed = weightedBonePoint({ x: values[offset], y: values[offset + 1] }, influences);
      values[offset] = transformed.x;
      values[offset + 1] = transformed.y;
    }
    return { ...command, values };
  });
  if (!preserveVolume || targetArea < 1e-8) return next;

  const deformedArea = pathArea(next);
  if (deformedArea < 1e-8) return next;
  const anchors = next.flatMap((command) => {
    if (command.type === "Z") return [];
    const offset = command.type === "A" ? 5 : command.values.length - 2;
    return [{ x: command.values[offset], y: command.values[offset + 1] }];
  });
  if (anchors.length === 0) return next;
  const center = anchors.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  center.x /= anchors.length;
  center.y /= anchors.length;
  const volumeScale = Math.sqrt(targetArea / deformedArea);
  for (const command of next) {
    for (const offset of coordinateOffsets(command)) {
      command.values[offset] = center.x + (command.values[offset] - center.x) * volumeScale;
      command.values[offset + 1] = center.y + (command.values[offset + 1] - center.y) * volumeScale;
    }
    if (command.type === "A") {
      command.values[0] *= volumeScale;
      command.values[1] *= volumeScale;
    }
  }
  return next;
}
