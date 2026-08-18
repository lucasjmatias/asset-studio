import type { SvgGroup } from "./model";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

export type PreparedSvg = {
  markup: string;
  groups: SvgGroup[];
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

  return {
    markup: new XMLSerializer().serializeToString(root),
    groups,
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
  for (const element of Array.from(clone.querySelectorAll("[data-studio-group]"))) {
    element.removeAttribute("data-studio-group");
    element.removeAttribute("data-selected");
    element.removeAttribute("data-bone-bound");
    element.removeAttribute("data-pose-hidden");
  }
  return new XMLSerializer().serializeToString(clone);
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
