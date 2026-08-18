declare module "canvaskit-wasm/bin/full/canvaskit.js" {
  const CanvasKitInit: (options?: { locateFile?: (file: string) => string }) => Promise<any>;
  export default CanvasKitInit;
}
