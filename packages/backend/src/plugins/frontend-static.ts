import type { FastifyRequest } from "fastify";

export const FRONTEND_REVALIDATE = "public, max-age=0, must-revalidate";
export const FRONTEND_IMMUTABLE = "public, max-age=31536000, immutable";

// Vite's packaged outputs use name-[hash:8].ext beneath assets/. HTML is
// deliberately excluded even when its name happens to contain a fingerprint.
// This recognizes the build naming contract, not a cryptographic hash check.
const fingerprintedAsset = /^\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.(?:js|mjs|css|json|wasm|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|mp3|wav|ogg|pdf)$/;
const assetExtension = /\.(?:html?|js|mjs|css|map|json|wasm|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|webp|avif|ico|mp4|webm|mp3|wav|ogg|pdf|txt|xml)$/i;

/**
 * A canonical public frontend GET/HEAD path, excluding server namespaces.
 * Match the raw target without URL normalization: malformed paths must retain
 * the static server's denial rather than acquire a frontend exception.
 */
export function frontendPathname(request: FastifyRequest): string | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const target = request.raw.url ?? request.url;
  const pathname = target.split("?", 1)[0];
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return undefined;
  if (/%(?:2f|5c)/i.test(pathname)) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (/[\\\u0000-\u001f\u007f?#]/.test(decoded)) return undefined;
  const segments = decoded.slice(1).split("/");
  if (segments.some((segment, i) =>
    segment === "." || segment === ".." || (segment === "" && i < segments.length - 1),
  )) return undefined;
  if (/^\/(?:api|storage|uploads)(?:\/|$)/.test(decoded) || decoded.startsWith("/dex")) {
    return undefined;
  }
  return decoded;
}

/** Only the registered frontend file route gets the quota exception. */
export function isPublicFrontendRequest(request: FastifyRequest): boolean {
  return request.routeOptions.url === "/*" && frontendPathname(request) !== undefined;
}

/** Missing files in these namespaces must not become successful SPA HTML. */
export function isFrontendAssetPath(pathname: string): boolean {
  return pathname === "/assets" || pathname.startsWith("/assets/") || assetExtension.test(pathname);
}

export function frontendCacheControl(pathname: string): string {
  return fingerprintedAsset.test(pathname) ? FRONTEND_IMMUTABLE : FRONTEND_REVALIDATE;
}
