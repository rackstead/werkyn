import { describe, expect, it } from "vitest";
import {
  AVATAR_MAX_BYTES,
  avatarFileProblem,
  avatarMime,
  avatarOutputMime,
  initialCrop,
  panCrop,
  sourceRect,
  zoomAroundCenter,
} from "./avatar-crop";

const wide = { width: 400, height: 200 };

describe("avatar file checks", () => {
  it("accepts the types the upload accepts, including a missing browser type", () => {
    expect(avatarMime({ type: "image/jpeg", name: "a.jpg" })).toBe(
      "image/jpeg",
    );
    expect(avatarMime({ type: "image/jpg", name: "a.jpg" })).toBe("image/jpeg");
    expect(avatarMime({ type: "image/png", name: "a.png" })).toBe("image/png");
    expect(avatarMime({ type: "image/gif", name: "a.gif" })).toBe("image/gif");
    expect(avatarMime({ type: "image/webp", name: "a.webp" })).toBe(
      "image/webp",
    );
    expect(avatarMime({ type: "", name: "a.PNG" })).toBe("image/png");
    expect(
      avatarMime({ type: "application/octet-stream", name: "a.jpeg" }),
    ).toBe("image/jpeg");
  });

  it("rejects a type the upload rejects even when the extension looks friendly", () => {
    expect(
      avatarFileProblem({ type: "image/svg+xml", name: "a.png", size: 10 }),
    ).toBe("Avatar must be a JPEG, PNG, GIF, or WebP image");
    expect(avatarMime({ type: "image/bmp", name: "a.png" })).toBeNull();
    expect(avatarMime({ type: "", name: "a.svg" })).toBeNull();
    expect(avatarMime({ type: "image/heic", name: "a.heic" })).toBeNull();
  });

  it("refuses an original over 5 MB and allows one at the limit", () => {
    const ok = { type: "image/png", name: "a.png", size: AVATAR_MAX_BYTES };
    const over = {
      type: "image/png",
      name: "a.png",
      size: AVATAR_MAX_BYTES + 1,
    };
    expect(avatarFileProblem(ok)).toBeNull();
    expect(avatarFileProblem(over)).toBe(
      "Avatar images must be 5 MB or smaller",
    );
  });

  it("stores jpeg as jpeg and every other accepted source as png", () => {
    expect(avatarOutputMime("image/jpeg")).toBe("image/jpeg");
    expect(avatarOutputMime("image/png")).toBe("image/png");
    expect(avatarOutputMime("image/gif")).toBe("image/png");
    expect(avatarOutputMime("image/webp")).toBe("image/png");
  });
});

describe("avatar crop geometry", () => {
  it("starts on the centered square of a wide picture", () => {
    expect(sourceRect(wide, initialCrop(wide))).toEqual({
      sx: 100,
      sy: 0,
      sw: 200,
      sh: 200,
    });
  });

  it("keeps the frame covered when the picture is dragged", () => {
    const dragged = panCrop(wide, initialCrop(wide), 70, 0);
    expect(sourceRect(wide, dragged)).toEqual({
      sx: 50,
      sy: 0,
      sw: 200,
      sh: 200,
    });
    expect(
      sourceRect(wide, panCrop(wide, initialCrop(wide), 10_000, 10_000)),
    ).toEqual({
      sx: 0,
      sy: 0,
      sw: 200,
      sh: 200,
    });
    expect(
      sourceRect(wide, panCrop(wide, initialCrop(wide), -10_000, -10_000)),
    ).toEqual({
      sx: 200,
      sy: 0,
      sw: 200,
      sh: 200,
    });
  });

  it("zooms around the center of the frame after a drag", () => {
    const dragged = panCrop(wide, initialCrop(wide), 70, 0);
    const zoomed = zoomAroundCenter(wide, dragged, 2);
    expect(zoomed.zoom).toBe(2);
    expect(sourceRect(wide, zoomed)).toEqual({
      sx: 100,
      sy: 50,
      sw: 100,
      sh: 100,
    });
    expect(zoomAroundCenter(wide, initialCrop(wide), 0.1).zoom).toBe(1);
    expect(zoomAroundCenter(wide, initialCrop(wide), 9).zoom).toBe(3);
  });
});
