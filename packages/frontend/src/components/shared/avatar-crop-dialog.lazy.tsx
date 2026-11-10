import { lazy } from "react";

export const AvatarCropDialog = lazy(() =>
  import("./avatar-crop-dialog").then((mod) => ({ default: mod.AvatarCropDialog })),
);
