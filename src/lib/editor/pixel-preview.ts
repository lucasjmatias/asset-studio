import CanvasKitInit from "canvaskit-wasm/bin/full/canvaskit.js";
import canvasKitWasmUrl from "canvaskit-wasm/bin/full/canvaskit.wasm?url";

let canvasKitPromise: Promise<any> | null = null;

export type PixelRenderOptions = {
  antiAlias: number;
  resizeMode: "contain" | "stretch";
};

export function loadCanvasKit(): Promise<any> {
  canvasKitPromise ??= CanvasKitInit({ locateFile: () => canvasKitWasmUrl });
  return canvasKitPromise;
}

function drawRect(sourceWidth: number, sourceHeight: number, width: number, height: number, resizeMode: PixelRenderOptions["resizeMode"]) {
  if (resizeMode === "stretch") return { x: 0, y: 0, width, height };
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const fittedWidth = sourceWidth * scale;
  const fittedHeight = sourceHeight * scale;
  return { x: (width - fittedWidth) / 2, y: (height - fittedHeight) / 2, width: fittedWidth, height: fittedHeight };
}

export function hardenAlpha(canvas: HTMLCanvasElement, antiAlias: number) {
  const strength = Math.max(0, Math.min(100, antiAlias)) / 100;
  if (strength >= 1) return;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    const alpha = pixels.data[offset + 3];
    const binary = alpha >= 128 ? 255 : 0;
    pixels.data[offset + 3] = Math.round(binary * (1 - strength) + alpha * strength);
  }
  context.putImageData(pixels, 0, 0);
}

export async function rasterizeSvg(svg: string, width: number, height: number, options: PixelRenderOptions): Promise<HTMLCanvasElement> {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Unable to create a raster preview canvas.");
    context.clearRect(0, 0, width, height);
    const rect = drawRect(image.naturalWidth || width, image.naturalHeight || height, width, height, options.resizeMode);
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    hardenAlpha(canvas, options.antiAlias);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function renderFallback(source: HTMLCanvasElement, target: HTMLCanvasElement) {
  const context = target.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, target.width, target.height);
  context.imageSmoothingEnabled = false;
  const scale = Math.max(1, Math.floor(Math.min(target.width / source.width, target.height / source.height)));
  const width = source.width * scale;
  const height = source.height * scale;
  context.drawImage(source, Math.floor((target.width - width) / 2), Math.floor((target.height - height) / 2), width, height);
}

export async function renderEncodedPixelPreview(
  png: Uint8Array,
  target: HTMLCanvasElement,
  pixelWidth: number,
  pixelHeight: number,
): Promise<void> {
  const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
  const displayWidth = Math.max(1, Math.round(target.clientWidth * devicePixelRatio));
  const displayHeight = Math.max(1, Math.round(target.clientHeight * devicePixelRatio));
  target.width = displayWidth;
  target.height = displayHeight;
  const context = target.getContext("2d");
  if (!context) throw new Error("Unable to present the refined pixel preview.");
  context.clearRect(0, 0, displayWidth, displayHeight);
  context.imageSmoothingEnabled = false;
  const scale = Math.max(1, Math.floor(Math.min(displayWidth / pixelWidth, displayHeight / pixelHeight)));
  const width = pixelWidth * scale;
  const height = pixelHeight * scale;
  context.drawImage(bitmap, Math.floor((displayWidth - width) / 2), Math.floor((displayHeight - height) / 2), width, height);
  bitmap.close();
}

export async function renderPixelPreview(
  svg: string,
  width: number,
  height: number,
  target: HTMLCanvasElement,
  options: PixelRenderOptions,
): Promise<"canvaskit" | "canvas"> {
  const source = await rasterizeSvg(svg, width, height, options);
  const displayWidth = Math.max(1, Math.round(target.clientWidth * devicePixelRatio));
  const displayHeight = Math.max(1, Math.round(target.clientHeight * devicePixelRatio));
  if (target.width !== displayWidth || target.height !== displayHeight) {
    target.width = displayWidth;
    target.height = displayHeight;
  }

  try {
    const CanvasKit = await loadCanvasKit();
    const png = await new Promise<Blob>((resolve, reject) =>
      source.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG encoding failed."))), "image/png"),
    );
    const image = CanvasKit.MakeImageFromEncoded(new Uint8Array(await png.arrayBuffer()));
    const surface = CanvasKit.MakeSurface(target.width, target.height);
    if (!image || !surface) throw new Error("CanvasKit surface creation failed.");
    const canvas = surface.getCanvas();
    canvas.clear(CanvasKit.TRANSPARENT);
    const scale = Math.max(1, Math.floor(Math.min(target.width / width, target.height / height)));
    const displayW = width * scale;
    const displayH = height * scale;
    const destination = CanvasKit.XYWHRect(
      Math.floor((target.width - displayW) / 2),
      Math.floor((target.height - displayH) / 2),
      displayW,
      displayH,
    );
    const sourceRect = CanvasKit.XYWHRect(0, 0, width, height);
    const paint = new CanvasKit.Paint();
    canvas.drawImageRectOptions(
      image,
      sourceRect,
      destination,
      CanvasKit.FilterMode.Nearest,
      CanvasKit.MipmapMode.None,
      paint,
    );
    surface.flush();
    const snapshot = surface.makeImageSnapshot();
    const encoded = snapshot.encodeToBytes();
    if (!encoded) throw new Error("CanvasKit preview encoding failed.");
    const rendered = await createImageBitmap(new Blob([encoded], { type: "image/png" }));
    const targetContext = target.getContext("2d");
    if (!targetContext) throw new Error("Unable to present the CanvasKit preview.");
    targetContext.clearRect(0, 0, target.width, target.height);
    targetContext.drawImage(rendered, 0, 0);
    rendered.close();
    paint.delete();
    image.delete();
    snapshot.delete();
    surface.delete();
    return "canvaskit";
  } catch (error) {
    console.warn("CanvasKit preview fallback", error);
    renderFallback(source, target);
    return "canvas";
  }
}
