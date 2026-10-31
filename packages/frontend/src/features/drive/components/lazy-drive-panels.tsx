import { Suspense, type ComponentProps } from "react";
import { lazyNamed } from "@/lib/lazy-import";
import { LoadingPanel } from "@/components/shared/lazy-panel";

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
      fallback={<LoadingPanel title="Loading preview" onClose={props.onClose} />}
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
