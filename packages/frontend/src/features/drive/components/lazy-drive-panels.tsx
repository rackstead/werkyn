import { Suspense, type ComponentProps } from "react";
import { lazyNamed } from "@/lib/lazy-import";
import { LoadingSpinner } from "@/components/shared/lazy-load";

// The preview panel (PDF, image, video and audio viewers in an animated dialog)
// loads when a file is first opened.
const FilePreviewPanel = lazyNamed(
  () => import("./file-preview-slideover"),
  "FilePreviewSlideover",
);

// Upload progress animates with framer-motion; it loads with the first upload.
const UploadProgressPanel = lazyNamed(
  () => import("./upload-progress"),
  "UploadProgress",
);

export function FilePreviewSlideover(
  props: ComponentProps<typeof FilePreviewPanel>,
) {
  return (
    <Suspense
      fallback={
        <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl border-l bg-background shadow-xl">
          <LoadingSpinner label="Loading preview…" />
        </div>
      }
    >
      <FilePreviewPanel {...props} />
    </Suspense>
  );
}

export function UploadProgress(props: ComponentProps<typeof UploadProgressPanel>) {
  if (props.uploads.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <UploadProgressPanel {...props} />
    </Suspense>
  );
}
