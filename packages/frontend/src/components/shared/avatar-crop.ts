/** Square crop used before an avatar upload. The circle in the dialog is only a preview. */

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_VIEWPORT = 280;
export const AVATAR_OUTPUT_SIZE = 512;
/** Longest side kept in memory for positioning. The saved file is still 512px. */
export const MAX_AVATAR_SOURCE_SIDE = 2048;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;
export const AVATAR_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

const AVATAR_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
export type AvatarMime = (typeof AVATAR_TYPES)[number];

const EXTENSION_TYPES: Record<string, AvatarMime> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

export interface ImageSize {
  width: number;
  height: number;
}

export interface CropState {
  zoom: number;
  /** Image top-left, in viewport pixels. */
  offsetX: number;
  offsetY: number;
}

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** A declared type the upload rejects stays rejected. An empty type uses the extension. */
export function avatarMime(
  file: Pick<File, "type" | "name">,
): AvatarMime | null {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/jpg") return "image/jpeg";
  if ((AVATAR_TYPES as readonly string[]).includes(type))
    return type as AvatarMime;
  if (type && type !== "application/octet-stream") return null;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] ?? null;
}

export function avatarFileProblem(
  file: Pick<File, "type" | "name" | "size">,
): string | null {
  if (!avatarMime(file))
    return "Avatar must be a JPEG, PNG, GIF, or WebP image";
  // The original is refused before it is decoded. A crop is not a way past the limit.
  if (file.size > AVATAR_MAX_BYTES)
    return "Avatar images must be 5 MB or smaller";
  return null;
}

/** GIF and WebP can be chosen, but the stored file is a PNG or JPEG. */
export function avatarOutputMime(
  source: AvatarMime,
): "image/jpeg" | "image/png" {
  return source === "image/jpeg" ? "image/jpeg" : "image/png";
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function coverScale(image: ImageSize, viewport: number): number {
  return Math.max(viewport / image.width, viewport / image.height);
}

export function displayedSize(
  image: ImageSize,
  viewport: number,
  zoom: number,
) {
  const scale = coverScale(image, viewport) * clampZoom(zoom);
  return { scale, width: image.width * scale, height: image.height * scale };
}

export function clampOffset(
  offset: number,
  displayed: number,
  viewport: number,
): number {
  if (displayed <= viewport) return (viewport - displayed) / 2;
  return Math.min(0, Math.max(viewport - displayed, offset));
}

export function initialCrop(
  image: ImageSize,
  viewport = AVATAR_VIEWPORT,
): CropState {
  const shown = displayedSize(image, viewport, MIN_ZOOM);
  return {
    zoom: MIN_ZOOM,
    offsetX: clampOffset((viewport - shown.width) / 2, shown.width, viewport),
    offsetY: clampOffset((viewport - shown.height) / 2, shown.height, viewport),
  };
}

/** Keeps the point under the middle of the frame fixed while the zoom changes. */
export function zoomAroundCenter(
  image: ImageSize,
  crop: CropState,
  nextZoom: number,
  viewport = AVATAR_VIEWPORT,
): CropState {
  const zoom = clampZoom(nextZoom);
  const previous = displayedSize(image, viewport, crop.zoom);
  const next = displayedSize(image, viewport, zoom);
  const anchorX = (viewport / 2 - crop.offsetX) / previous.width;
  const anchorY = (viewport / 2 - crop.offsetY) / previous.height;
  return {
    zoom,
    offsetX: clampOffset(
      viewport / 2 - anchorX * next.width,
      next.width,
      viewport,
    ),
    offsetY: clampOffset(
      viewport / 2 - anchorY * next.height,
      next.height,
      viewport,
    ),
  };
}

export function panCrop(
  image: ImageSize,
  crop: CropState,
  dx: number,
  dy: number,
  viewport = AVATAR_VIEWPORT,
): CropState {
  const shown = displayedSize(image, viewport, crop.zoom);
  return {
    zoom: crop.zoom,
    offsetX: clampOffset(crop.offsetX + dx, shown.width, viewport),
    offsetY: clampOffset(crop.offsetY + dy, shown.height, viewport),
  };
}

/** Bitmap region covered by the square frame. */
export function sourceRect(
  image: ImageSize,
  crop: CropState,
  viewport = AVATAR_VIEWPORT,
): SourceRect {
  const { scale } = displayedSize(image, viewport, crop.zoom);
  const side = Math.min(viewport / scale, image.width, image.height);
  const maxX = Math.max(0, image.width - side);
  const maxY = Math.max(0, image.height - side);
  return {
    sx: Math.min(maxX, Math.max(0, -crop.offsetX / scale)),
    sy: Math.min(maxY, Math.max(0, -crop.offsetY / scale)),
    sw: side,
    sh: side,
  };
}

export function frozenBitmapSize(width: number, height: number): ImageSize {
  const longest = Math.max(width, height);
  if (!(longest > 0)) return { width: 0, height: 0 };
  if (longest <= MAX_AVATAR_SOURCE_SIDE) return { width, height };
  const scale = MAX_AVATAR_SOURCE_SIDE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function keyboardPanStep(viewport: number, fast: boolean): number {
  return Math.max(1, Math.round(viewport / (fast ? 5 : 20)));
}

/** Keeps the same bitmap region when the on-screen frame changes size. */
export function scaleCrop(
  crop: CropState,
  fromViewport: number,
  toViewport: number,
): CropState {
  if (!(fromViewport > 0) || fromViewport === toViewport) return crop;
  const ratio = toViewport / fromViewport;
  return {
    zoom: crop.zoom,
    offsetX: crop.offsetX * ratio,
    offsetY: crop.offsetY * ratio,
  };
}

export async function croppedAvatarFile(
  image: CanvasImageSource,
  bitmap: ImageSize,
  crop: CropState,
  source: AvatarMime,
  viewport = AVATAR_VIEWPORT,
): Promise<File> {
  if (!(bitmap.width > 0) || !(bitmap.height > 0)) {
    throw new Error("This image could not be read");
  }
  const mime = avatarOutputMime(source);
  const rect = sourceRect(bitmap, crop, viewport);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_OUTPUT_SIZE;
  canvas.height = AVATAR_OUTPUT_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the avatar image");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  if (mime === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  }
  context.drawImage(
    image,
    rect.sx,
    rect.sy,
    rect.sw,
    rect.sh,
    0,
    0,
    AVATAR_OUTPUT_SIZE,
    AVATAR_OUTPUT_SIZE,
  );
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), mime, 0.92);
  });
  if (!blob) throw new Error("Could not prepare the avatar image");
  if (blob.size > AVATAR_MAX_BYTES)
    throw new Error("Avatar images must be 5 MB or smaller");
  return new File([blob], mime === "image/jpeg" ? "avatar.jpg" : "avatar.png", {
    type: mime,
  });
}
