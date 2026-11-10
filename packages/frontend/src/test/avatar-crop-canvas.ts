const decoded = new WeakMap<
  HTMLImageElement,
  { width: number; height: number }
>();

function pointerEventsWork(): boolean {
  if (typeof PointerEvent !== "function") return false;
  try {
    return new PointerEvent("pointermove", { clientX: 70 }).clientX === 70;
  } catch {
    return false;
  }
}

/** jsdom has no PointerEvent. The dialog still has to be dragged in tests. */
function installPointerEvents(): () => void {
  if (
    pointerEventsWork() &&
    typeof Element.prototype.setPointerCapture === "function"
  )
    return () => {};
  class CropPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(
      type: string,
      init: MouseEventInit & { pointerId?: number } = {},
    ) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  const previousPointer = window.PointerEvent;
  const hadPointer = pointerEventsWork();
  if (!hadPointer) {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      writable: true,
      value: CropPointerEvent,
    });
  }
  const hadCapture = typeof Element.prototype.setPointerCapture === "function";
  const previousCapture = Element.prototype.setPointerCapture;
  if (!hadCapture)
    Element.prototype.setPointerCapture = function setPointerCapture() {};
  return () => {
    if (!hadPointer) Reflect.deleteProperty(window, "PointerEvent");
    else window.PointerEvent = previousPointer;
    if (!hadCapture)
      Reflect.deleteProperty(Element.prototype, "setPointerCapture");
    else Element.prototype.setPointerCapture = previousCapture;
  };
}

export interface CropDraw {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dw: number;
  dh: number;
  mime: string;
  source: string;
}

export function setDecodedSize(
  img: HTMLImageElement,
  width: number,
  height: number,
) {
  decoded.set(img, { width, height });
}

export function blobBytes(blob: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Bytes the test canvas returns for one draw. Not a real PNG; the crop window is in the payload. */
export function encodeCropDraw(
  draw: { sx: number; sy: number; sw: number; sh: number } | undefined,
  type: string,
): Uint8Array {
  const bytes = new Uint8Array(28);
  const jpeg = type === "image/jpeg";
  bytes.set(
    jpeg
      ? [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]
      : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  const view = new DataView(bytes.buffer);
  view.setFloat32(8, draw?.sx ?? Number.NaN);
  view.setFloat32(12, draw?.sy ?? Number.NaN);
  view.setFloat32(16, draw?.sw ?? Number.NaN);
  view.setFloat32(20, draw?.sh ?? Number.NaN);
  view.setUint16(24, jpeg ? 1 : 2);
  return bytes;
}

export function installAvatarCanvas(): {
  draws: CropDraw[];
  restore: () => void;
} {
  const restorePointer = installPointerEvents();
  const draws: CropDraw[] = [];
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  const hadToBlob = Object.prototype.hasOwnProperty.call(
    HTMLCanvasElement.prototype,
    "toBlob",
  );
  const widthDesc = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    "naturalWidth",
  );
  const heightDesc = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    "naturalHeight",
  );

  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get() {
      return decoded.get(this as HTMLImageElement)?.width ?? 0;
    },
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", {
    configurable: true,
    get() {
      return decoded.get(this as HTMLImageElement)?.height ?? 0;
    },
  });

  HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      fillStyle: "",
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
      fillRect() {},
      drawImage(image: CanvasImageSource, ...rest: number[]) {
        // A full-image snapshot uses fewer arguments. Only the saved crop is recorded.
        if (rest.length !== 8) return;
        const [sx, sy, sw, sh, , , dw, dh] = rest;
        const source = image instanceof Element ? image.tagName : "";
        draws.push({ sx, sy, sw, sh, dw, dh, mime: "", source });
      },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type) {
    const draw = draws.at(-1);
    const mime = type || "image/png";
    if (draw) draw.mime = mime;
    const bytes = encodeCropDraw(draw, mime);
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    callback(new Blob([copy], { type: mime }));
  };

  return {
    draws,
    restore() {
      restorePointer();
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      if (hadToBlob) HTMLCanvasElement.prototype.toBlob = originalToBlob;
      else Reflect.deleteProperty(HTMLCanvasElement.prototype, "toBlob");
      if (widthDesc)
        Object.defineProperty(
          HTMLImageElement.prototype,
          "naturalWidth",
          widthDesc,
        );
      if (heightDesc)
        Object.defineProperty(
          HTMLImageElement.prototype,
          "naturalHeight",
          heightDesc,
        );
    },
  };
}
