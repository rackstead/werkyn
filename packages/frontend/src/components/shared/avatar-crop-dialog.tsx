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
  initialCrop,
  panCrop,
  zoomAroundCenter,
  type CropState,
  type ImageSize,
} from "./avatar-crop";

interface AvatarCropDialogProps {
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
            Drag the picture to position it. The square is saved, and the circle
            shows the round avatar.
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
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    crop: CropState;
  } | null>(null);
  const preparingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [size, setSize] = useState<ImageSize | null>(null);
  const [crop, setCrop] = useState<CropState | null>(null);
  const [preparing, setPreparing] = useState(false);
  const locked = saving || preparing;
  const shown =
    size && crop ? displayedSize(size, AVATAR_VIEWPORT, crop.zoom) : null;

  function reject(message: string) {
    onError(message);
    onCancel();
  }

  function applySize(img: HTMLImageElement) {
    if (size) return;
    const next = { width: img.naturalWidth, height: img.naturalHeight };
    if (!(next.width > 0) || !(next.height > 0)) return;
    setSize(next);
    setCrop(initialCrop(next));
  }

  useLayoutEffect(() => {
    const img = imgRef.current;
    // A finished decode can beat the load handler. No size yet means the picture is still loading.
    if (
      img &&
      !size &&
      img.complete &&
      img.naturalWidth > 0 &&
      img.naturalHeight > 0
    )
      applySize(img);
  }, [url, size]);

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
      ),
    );
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null;
  }

  async function confirm() {
    const img = imgRef.current;
    if (preparingRef.current || saving || !img || !size || !crop) return;
    const source = avatarMime(file);
    if (!source) {
      reject("Avatar must be a JPEG, PNG, GIF, or WebP image");
      return;
    }
    preparingRef.current = true;
    setPreparing(true);
    try {
      const cropped = await croppedAvatarFile(
        img,
        { width: img.naturalWidth, height: img.naturalHeight },
        crop,
        source,
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
        data-avatar-crop="square"
        role="group"
        aria-label="Drag to position the picture"
        className="relative mx-auto touch-none overflow-hidden bg-muted select-none"
        style={{
          width: AVATAR_VIEWPORT,
          height: AVATAR_VIEWPORT,
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {url && (
          <img
            ref={imgRef}
            src={url}
            alt=""
            draggable={false}
            className={cn(
              "absolute max-w-none select-none",
              !shown && "invisible",
            )}
            style={
              shown && crop
                ? {
                    width: shown.width,
                    height: shown.height,
                    left: crop.offsetX,
                    top: crop.offsetY,
                  }
                : undefined
            }
            onLoad={(event) => {
              const img = event.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0) applySize(img);
              else reject("This image could not be read");
            }}
            onError={() => reject("This image could not be read")}
          />
        )}
        <div className="pointer-events-none absolute inset-0 border-2 border-white" />
        {/* The square border is the saved crop. The circle only darkens what the round avatar hides. */}
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
            setCrop(zoomAroundCenter(size, crop, Number(event.target.value)));
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
