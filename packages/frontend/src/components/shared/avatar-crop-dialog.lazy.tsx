import { Suspense } from "react";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { LoadingSpinner } from "@/components/shared/lazy-load";
import { lazyNamed } from "@/lib/lazy-import";
import type { AvatarCropDialogProps } from "./avatar-crop-dialog";

const AvatarCropDialogPanel = lazyNamed(
  () => import("./avatar-crop-dialog"),
  "AvatarCropDialog",
);

export function preloadAvatarCropDialog() {
  void AvatarCropDialogPanel.preload();
}

export function AvatarCropDialog(props: AvatarCropDialogProps) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner label="Loading avatar editor" />}>
        <AvatarCropDialogPanel {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
