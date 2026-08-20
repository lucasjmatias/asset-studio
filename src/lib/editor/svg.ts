import type { SvgGroup, SvgShape } from "./model";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const editableShapeSelector = "path,rect,circle,ellipse,polygon,polyline,line";
const geometryAttributes = new Set(["d", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "rx", "ry", "cx", "cy", "r", "points"]);
const shapeGeometryAttributes = [...geometryAttributes, "transform"].sort();
const shapePresentationAttributes = ["class", "fill", "fill-opacity", "opacity", "paint-order", "stroke", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "stroke-width", "style", "vector-effect"];

function attributeSignature(element: Element, names: string[]): string {
  return names
    .flatMap((name) => {
      const value = element.getAttribute(name)?.trim().replace(/\s+/g, " ");
      return value ? [`${name}=${value}`] : [];
    })
    .join("|");
}

export type PreparedSvg = {
  markup: string;
  groups: SvgGroup[];
  shapes: SvgShape[];
  viewBox: [number, number, number, number];
  warnings: string[];
};

const forbiddenElements = [
  "script",
  "foreignObject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
];

function numberFromLength(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : fallback;
}

function sanitize(document: XMLDocument, warnings: string[]) {
  for (const selector of forbiddenElements) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      element.remove();
      warnings.push(`Removed unsupported <${selector}> content.`);
    }
  }

  for (const element of Array.from(document.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        warnings.push(`Removed event attribute ${attribute.name}.`);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        const safe = value.startsWith("#") || value.startsWith("data:image/");
        if (!safe) {
          element.removeAttribute(attribute.name);
          if (attribute.namespaceURI === XLINK_NS) {
            element.removeAttributeNS(XLINK_NS, "href");
          }
          warnings.push("Removed a remote SVG resource reference.");
        }
      }
      if ((name === "style" || name === "src") && /(?:https?:|javascript:|@import)/i.test(value)) {
        element.removeAttribute(attribute.name);
        warnings.push(`Removed unsafe ${attribute.name} content.`);
      }
    }
  }
}

function elementLabel(element: Element, index: number): string {
  return (
    element.getAttribute("inkscape:label") ||
    element.getAttribute("aria-label") ||
    element.getAttribute("id") ||
    `Group ${String(index + 1).padStart(2, "0")}`
  );
}

function depthFor(element: Element, groupSet: Set<Element>): number {
  let depth = 0;
  let cursor = element.parentElement;
  while (cursor) {
    if (groupSet.has(cursor)) depth += 1;
    cursor = cursor.parentElement;
  }
  return depth;
}

export function prepareSvg(source: string): PreparedSvg {
  const parser = new DOMParser();
  const document = parser.parseFromString(source, "image/svg+xml");
  const parseError = document.querySelector("parsererror");
  if (parseError) throw new Error("The selected file is not valid SVG/XML.");

  const root = document.documentElement;
  if (root.localName.toLowerCase() !== "svg") {
    throw new Error("The selected file does not contain an SVG root element.");
  }

  const warnings: string[] = [];
  sanitize(document, warnings);
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("preserveAspectRatio", root.getAttribute("preserveAspectRatio") || "xMidYMid meet");

  let viewBoxValues = (root.getAttribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  if (viewBoxValues.length !== 4 || viewBoxValues[2] <= 0 || viewBoxValues[3] <= 0) {
    const width = numberFromLength(root.getAttribute("width"), 512);
    const height = numberFromLength(root.getAttribute("height"), 512);
    viewBoxValues = [0, 0, width, height];
    root.setAttribute("viewBox", viewBoxValues.join(" "));
    warnings.push("The SVG had no usable viewBox; one was generated from its dimensions.");
  }
  root.removeAttribute("width");
  root.removeAttribute("height");
  root.setAttribute("width", "100%");
  root.setAttribute("height", "100%");

  let sourceGroups = Array.from(root.querySelectorAll("g"));
  if (sourceGroups.length === 0) {
    const synthetic = document.createElementNS(SVG_NS, "g");
    synthetic.setAttribute("id", "artwork");
    const movable = Array.from(root.children).filter(
      (child) => !["defs", "style", "title", "desc", "metadata"].includes(child.localName),
    );
    for (const child of movable) synthetic.appendChild(child);
    root.appendChild(synthetic);
    sourceGroups = [synthetic];
    warnings.push("The SVG had no groups; its drawable artwork was placed in a working group.");
  }

  const groupSet: Set<Element> = new Set(sourceGroups);
  const keys = new Map<Element, string>();
  sourceGroups.forEach((group, index) => keys.set(group, `group-${index}`));

  const groups: SvgGroup[] = sourceGroups.map((group, index) => {
    let parent = group.parentElement;
    while (parent && !groupSet.has(parent)) parent = parent.parentElement;
    return {
      key: keys.get(group)!,
      label: elementLabel(group, index),
      sourceId: group.getAttribute("id"),
      parentKey: parent ? keys.get(parent) || null : null,
      depth: depthFor(group, groupSet),
    };
  });

  // Editing wrappers carry pose transforms. The original group and its attributes remain untouched.
  sourceGroups.forEach((group) => {
    const wrapper = document.createElementNS(SVG_NS, "g");
    wrapper.setAttribute("data-studio-group", keys.get(group)!);
    group.parentNode?.insertBefore(wrapper, group);
    wrapper.appendChild(group);
  });

  let shapeIndex = 0;
  const shapeOrdinals = new Map<string, number>();
  const shapes: SvgShape[] = [];
  for (const shape of Array.from(root.querySelectorAll(editableShapeSelector))) {
    if (shape.closest("defs,clipPath,mask,marker,pattern,symbol")) continue;
    const owner = shape.closest("[data-studio-group]") as SVGElement | null;
    if (!owner?.dataset.studioGroup) continue;
    const key = `shape-${shapeIndex++}`;
    const groupKey = owner.dataset.studioGroup;
    const ordinalInGroup = shapeOrdinals.get(groupKey) ?? 0;
    shapeOrdinals.set(groupKey, ordinalInGroup + 1);
    shape.setAttribute("data-studio-shape", key);
    shape.setAttribute("data-studio-shape-group", groupKey);
    if (shape.localName.toLowerCase() === "path") {
      shape.setAttribute("data-studio-source-d", shape.getAttribute("d") || "");
    }
    shapes.push({
      key,
      groupKey,
      sourceId: shape.getAttribute("id"),
      tagName: shape.localName.toLowerCase(),
      geometrySignature: attributeSignature(shape, shapeGeometryAttributes),
      presentationSignature: attributeSignature(shape, shapePresentationAttributes),
      ordinalInGroup,
    });
  }

  return {
    markup: new XMLSerializer().serializeToString(root),
    groups,
    shapes,
    viewBox: viewBoxValues as [number, number, number, number],
    warnings: [...new Set(warnings)],
  };
}

export function serializeForExport(host: HTMLElement): string {
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("There is no SVG loaded.");
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute("width");
  clone.removeAttribute("height");
  for (const original of Array.from(clone.querySelectorAll("[data-studio-pose-overridden]"))) {
    original.remove();
  }
  for (const element of Array.from(clone.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith("data-studio-")) element.removeAttribute(attribute.name);
    }
  }
  return new XMLSerializer().serializeToString(clone);
}

function numericAttribute(element: Element, name: string, fallback = 0): number {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : fallback;
}

function pathFromPoints(points: string, close: boolean): string | null {
  const values = points.match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
  if (values.length < 4) return null;
  const commands = [`M${values[0]} ${values[1]}`];
  for (let index = 2; index + 1 < values.length; index += 2) commands.push(`L${values[index]} ${values[index + 1]}`);
  if (close) commands.push("Z");
  return commands.join(" ");
}

/** Converts a supported SVG primitive into editable absolute path data. */
export function shapeElementToPathData(element: Element): string | null {
  const name = element.localName.toLowerCase();
  if (name === "path") return element.getAttribute("data-studio-source-d") ?? element.getAttribute("d");
  if (name === "line") return `M${numericAttribute(element, "x1")} ${numericAttribute(element, "y1")} L${numericAttribute(element, "x2")} ${numericAttribute(element, "y2")}`;
  if (name === "polygon" || name === "polyline") return pathFromPoints(element.getAttribute("points") || "", name === "polygon");
  if (name === "rect") {
    const x = numericAttribute(element, "x"), y = numericAttribute(element, "y");
    const width = Math.max(0, numericAttribute(element, "width")), height = Math.max(0, numericAttribute(element, "height"));
    let rx = Math.max(0, numericAttribute(element, "rx"));
    let ry = Math.max(0, numericAttribute(element, "ry"));
    if (rx && !ry) ry = rx;
    if (ry && !rx) rx = ry;
    rx = Math.min(rx, width / 2); ry = Math.min(ry, height / 2);
    if (!rx && !ry) return `M${x} ${y} L${x + width} ${y} L${x + width} ${y + height} L${x} ${y + height} Z`;
    return `M${x + rx} ${y} L${x + width - rx} ${y} Q${x + width} ${y} ${x + width} ${y + ry} L${x + width} ${y + height - ry} Q${x + width} ${y + height} ${x + width - rx} ${y + height} L${x + rx} ${y + height} Q${x} ${y + height} ${x} ${y + height - ry} L${x} ${y + ry} Q${x} ${y} ${x + rx} ${y} Z`;
  }
  if (name === "circle" || name === "ellipse") {
    const cx = numericAttribute(element, "cx"), cy = numericAttribute(element, "cy");
    const rx = Math.max(0, name === "circle" ? numericAttribute(element, "r") : numericAttribute(element, "rx"));
    const ry = Math.max(0, name === "circle" ? numericAttribute(element, "r") : numericAttribute(element, "ry"));
    const k = 0.5522847498307936;
    return `M${cx + rx} ${cy} C${cx + rx} ${cy + k * ry} ${cx + k * rx} ${cy + ry} ${cx} ${cy + ry} C${cx - k * rx} ${cy + ry} ${cx - rx} ${cy + k * ry} ${cx - rx} ${cy} C${cx - rx} ${cy - k * ry} ${cx - k * rx} ${cy - ry} ${cx} ${cy - ry} C${cx + k * rx} ${cy - ry} ${cx + rx} ${cy - k * ry} ${cx + rx} ${cy} Z`;
  }
  return null;
}

const computedPresentationProperties = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "filter",
  "clip-path", "mask", "mix-blend-mode", "paint-order", "vector-effect",
];

function restorePrimitive(original: SVGElement, rendered: SVGPathElement | null) {
  rendered?.remove();
  original.style.display = original.getAttribute("data-studio-source-inline-display") || "";
  original.removeAttribute("data-studio-source-inline-display");
  original.removeAttribute("data-studio-pose-overridden");
}

export function applyShapePath(host: HTMLElement, key: string, path: string | null) {
  const original = host.querySelector(`[data-studio-shape="${CSS.escape(key)}"]`) as SVGElement | null;
  if (!original) return;
  const rendered = host.querySelector(`[data-studio-shape-render="${CSS.escape(key)}"]`) as SVGPathElement | null;
  if (!path) {
    if (original.localName.toLowerCase() === "path") original.setAttribute("d", original.getAttribute("data-studio-source-d") || "");
    else restorePrimitive(original, rendered);
    return;
  }
  if (original.localName.toLowerCase() === "path") {
    original.setAttribute("d", path);
    return;
  }
  let replacement = rendered;
  if (!replacement) {
    replacement = document.createElementNS(SVG_NS, "path");
    for (const attribute of Array.from(original.attributes)) {
      if (!geometryAttributes.has(attribute.name) && !attribute.name.startsWith("data-studio-")) replacement.setAttribute(attribute.name, attribute.value);
    }
    replacement.setAttribute("data-studio-shape-render", key);
    replacement.setAttribute("data-studio-shape-group", original.getAttribute("data-studio-shape-group") || "");
    const computed = getComputedStyle(original);
    for (const property of computedPresentationProperties) {
      const value = computed.getPropertyValue(property);
      if (value) replacement.style.setProperty(property, value);
    }
    original.parentNode?.insertBefore(replacement, original.nextSibling);
  }
  if (!original.hasAttribute("data-studio-source-inline-display")) {
    original.setAttribute("data-studio-source-inline-display", original.style.display || "");
  }
  // Remove the source primitive from group bounds while its pose-local path is active.
  original.style.display = "none";
  original.setAttribute("data-studio-pose-overridden", "true");
  replacement.setAttribute("d", path);
}

export function applyShapePaths(host: HTMLElement, paths: Record<string, string>) {
  const originals = Array.from(host.querySelectorAll("[data-studio-shape]")) as SVGElement[];
  for (const original of originals) {
    const key = original.dataset.studioShape;
    if (key) applyShapePath(host, key, paths[key] ?? null);
  }
}

export function setWrapperMatrix(host: HTMLElement, key: string, matrix: number[]) {
  const wrapper = host.querySelector(`[data-studio-group="${CSS.escape(key)}"]`);
  if (!wrapper) return;
  wrapper.setAttribute("transform", `matrix(${matrix.map((value) => value.toFixed(6)).join(" ")})`);
}

export function setWrapperVisibility(host: HTMLElement, key: string, visible: boolean) {
  const wrapper = host.querySelector(`[data-studio-group="${CSS.escape(key)}"]`);
  if (!wrapper) return;
  if (visible) {
    wrapper.removeAttribute("visibility");
    wrapper.removeAttribute("data-pose-hidden");
  } else {
    wrapper.setAttribute("visibility", "hidden");
    wrapper.setAttribute("data-pose-hidden", "true");
  }
}

export function highlightBoneWrapper(host: HTMLElement, key: string | null) {
  for (const wrapper of Array.from(host.querySelectorAll("[data-bone-bound]"))) {
    wrapper.removeAttribute("data-bone-bound");
  }
  if (!key) return;
  host.querySelector(`[data-studio-group="${CSS.escape(key)}"]`)?.setAttribute("data-bone-bound", "true");
}

export function selectWrapper(host: HTMLElement, key: string | null) {
  for (const wrapper of Array.from(host.querySelectorAll("[data-selected]"))) {
    wrapper.removeAttribute("data-selected");
  }
  if (!key) return;
  host.querySelector(`[data-studio-group="${CSS.escape(key)}"]`)?.setAttribute("data-selected", "true");
}
