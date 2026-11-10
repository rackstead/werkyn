import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useObjectUrl } from "@/lib/use-object-url";
import { cn } from "@/lib/utils";
import {
  AVATAR_VIEWPORT,
  MAX_ZOOM,
  MIN_ZOOM,
  avatarMime,
  croppedAvatarFile,
  displayedSize,
  frozenBitmapSize,
  initialCrop,
  keyboardPanStep,
  panCrop,
  scaleCrop,
  zoomAroundCenter,
  type CropState,
  type ImageSize,
} from "./avatar-crop";

export interface AvatarCropDialogProps {
  file: File | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (cropped: File) => void | Promise<void>;
  onError: (message: string) => void;
}

export function AvatarCropDialog({
  file,
  saving,
  onCancel,
  onConfirm,
  onError,
}: AvatarCropDialogProps) {
  return (
    <Dialog
      open={file !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Position your avatar</DialogTitle>
          <DialogDescription>
            Drag the picture, or focus it and use the arrow keys. The square is
            saved, and the circle shows the round avatar.
          </DialogDescription>
        </DialogHeader>
        {file && (
          <AvatarCropEditor
            key={`${file.name}:${file.size}:${file.lastModified}`}
            file={file}
            saving={saving}
            onCancel={onCancel}
            onConfirm={onConfirm}
            onError={onError}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AvatarCropEditor({
  file,
  saving,
  onCancel,
  onConfirm,
  onError,
}: {
  file: File;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (cropped: File) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const url = useObjectUrl(file);
  const frameRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const frozenRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    crop: CropState;
  } | null>(null);
  const preparingRef = useRef(false);
  const mounted = useRef(true);
  const cropViewport = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [viewport, setViewport] = useState(AVATAR_VIEWPORT);
  const [size, setSize] = useState<ImageSize | null>(null);
  const [crop, setCrop] = useState<CropState | null>(null);
  const [frozenVersion, setFrozenVersion] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const locked = saving || preparing;
  const shown = size && crop ? displayedSize(size, viewport, crop.zoom) : null;

  useLayoutEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth;
      const next = width >= 1 ? Math.round(width) : AVATAR_VIEWPORT;
      setViewport((current) => (current === next ? current : next));
    };
    measure();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useLayoutEffect(() => {
    if (!size) return;
    setCrop((current) => {
      if (!current || cropViewport.current === 0) {
        cropViewport.current = viewport;
        return initialCrop(size, viewport);
      }
      if (cropViewport.current === viewport) return current;
      const next = scaleCrop(current, cropViewport.current, viewport);
      cropViewport.current = viewport;
      return next;
    });
  }, [size, viewport]);

  useLayoutEffect(() => {
    const canvas = frozenRef.current;
    const parent = holderRef.current;
    if (!canvas || !parent || !shown || !crop) return;
    canvas.className = "absolute max-w-none select-none";
    canvas.style.width = `${shown.width}px`;
    canvas.style.height = `${shown.height}px`;
    canvas.style.left = `${crop.offsetX}px`;
    canvas.style.top = `${crop.offsetY}px`;
    if (canvas.parentElement !== parent) parent.replaceChildren(canvas);
  }, [shown, crop, frozenVersion]);

  function reject(message: string) {
    onError(message);
    onCancel();
  }

  function freeze(img: HTMLImageElement) {
    if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) {
      reject("This image could not be read");
      return;
    }
    // The preview and the saved file share this still. A huge photo is scaled
    // down here so the dialog does not keep a full-resolution bitmap.
    const bitmap = frozenBitmapSize(img.naturalWidth, img.naturalHeight);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        reject("Could not prepare the avatar image");
        return;
      }
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      frozenRef.current = canvas;
      setSize({ width: canvas.width, height: canvas.height });
      setFrozenVersion((version) => version + 1);
    } catch (error) {
      reject(error instanceof Error ? error.message : "Could not prepare the avatar image");
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (locked || !size || !crop || event.button !== 0) return;
    event.preventDefault();
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      crop,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId || !size || locked) return;
    setCrop(
      panCrop(
        size,
        start.crop,
        event.clientX - start.x,
        event.clientY - start.y,
        viewport,
      ),
    );
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (locked || !size || !crop) return;
    const step = keyboardPanStep(viewport, event.shiftKey);
    const delta =
      event.key === "ArrowRight"
        ? [step, 0]
        : event.key === "ArrowLeft"
          ? [-step, 0]
          : event.key === "ArrowDown"
            ? [0, step]
            : event.key === "ArrowUp"
              ? [0, -step]
              : null;
    if (!delta) return;
    event.preventDefault();
    setCrop(panCrop(size, crop, delta[0], delta[1], viewport));
  }

  async function confirm() {
    const frozen = frozenRef.current;
    if (preparingRef.current || saving || !frozen || !size || !crop) return;
    const source = avatarMime(file);
    if (!source) {
      reject("Avatar must be a JPEG, PNG, GIF, or WebP image");
      return;
    }
    preparingRef.current = true;
    setPreparing(true);
    try {
      const cropped = await croppedAvatarFile(
        frozen,
        { width: frozen.width, height: frozen.height },
        crop,
        source,
        viewport,
      );
      if (!mounted.current) return;
      await onConfirm(cropped);
    } catch (error) {
      if (!mounted.current) return;
      onError(
        error instanceof Error
          ? error.message
          : "Could not prepare the avatar image",
      );
    } finally {
      preparingRef.current = false;
      if (mounted.current) setPreparing(false);
    }
  }

  return (
    <div>
      <div
        ref={frameRef}
        data-avatar-crop="square"
        role="group"
        tabIndex={0}
        aria-label="Drag or use arrow keys to position the picture"
        className="relative mx-auto w-full touch-none overflow-hidden bg-muted select-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          maxWidth: AVATAR_VIEWPORT,
          aspectRatio: "1 / 1",
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {url && !size && (
          <img
            src={url}
            alt=""
            draggable={false}
            className={cn("absolute h-px w-px opacity-0")}
            onLoad={(event) => freeze(event.currentTarget)}
            onError={() => reject("This image could not be read")}
          />
        )}
        <div ref={holderRef} className="absolute inset-0" />
        <div className="pointer-events-none absolute inset-0 border-2 border-white" />
        <div
          data-avatar-preview="circle"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle closest-side, transparent calc(100% - 1px), rgba(255,255,255,0.95) calc(100% - 1px) 100%, rgba(0,0,0,0.45) 100%)",
          }}
        />
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Label htmlFor="avatar-zoom" className="shrink-0">
          Zoom
        </Label>
        <input
          id="avatar-zoom"
          aria-label="Zoom"
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={crop?.zoom ?? MIN_ZOOM}
          disabled={locked}
          onChange={(event) => {
            if (!size || !crop) return;
            setCrop(
              zoomAroundCenter(
                size,
                crop,
                Number(event.target.value),
                viewport,
              ),
            );
          }}
          className="w-full"
        />
      </div>
      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void confirm()}
          disabled={locked || !crop}
        >
          {locked ? "Saving..." : "Save avatar"}
        </Button>
      </DialogFooter>
    </div>
  );
}
