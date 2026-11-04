import { api } from "./api-client";
import { apiUrl } from "./api-url";
import { identityGeneration, onIdentityChange } from "./identity";

const CAP = 64 * 1024 * 1024;
const WIKI_LIMIT = 25 * 1024 * 1024;
const AVATAR_LIMIT = 5 * 1024 * 1024;
const SAFE = /^(image\/(jpeg|png|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp4|ogg|wav|webm))$/;

export function isUploadedMediaUrl(url: string): boolean {
  return url.length <= 2048 && !/[\\\x00-\x20?#]/.test(url) && /^\/storage\/[A-Za-z0-9_-]{1,128}\/uploads\/(avatars|wiki)\/[A-Za-z0-9_-]{1,128}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[^/]+)?$/i.test(url);
}

export function isRetiredUploadedMediaUrl(url: string): boolean {
  return /^\/(?:storage\/(?:avatars|uploads)|uploads)(?:\/|$)/.test(url);
}

export function uploadedMediaReferences(content: unknown): Set<string> {
  const urls = new Set<string>();
  if (Array.isArray(content) && content.length > 10000) return urls;
  const pending = Array.isArray(content) ? [...content] : [];
  let visited = 0;
  while (pending.length && ++visited <= 10000) {
    const block = pending.pop();
    if (!block || typeof block !== "object") continue;
    const value = block as { type?: string; props?: { url?: string }; children?: unknown[] };
    if (["image", "audio", "video", "file"].includes(value.type ?? "") && typeof value.props?.url === "string" && isUploadedMediaUrl(value.props.url)) urls.add(value.props.url);
    if (Array.isArray(value.children)) {
      if (value.children.length + pending.length + visited > 10000) return new Set();
      for (const child of value.children) pending.push(child);
    }
  }
  return urls;
}

interface Entry {
  controller: AbortController;
  promise: Promise<Entry>;
  reserved: number;
  blob?: Blob;
  objectUrl?: string;
  mime?: string;
}

/** Rendering-only owner. It never changes the stored URL or document. */
export class UploadedMediaOwner {
  private entries = new Map<string, Entry>();
  private references = new Set<string>();
  private active = false;
  private epoch = 0;
  private generation = identityGeneration();
  private unsubscribe?: () => void;
  private bytes = 0;
  private inFlight = 0;
  private waiters = new Set<() => void>();
  private downloads = new Map<string, { bytes: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(private notify: (message: string) => void, private shareToken?: string, private invalidated?: () => void, private objectLimit = WIKI_LIMIT) {}

  activate() {
    this.dispose();
    this.active = true;
    this.generation = identityGeneration();
    this.unsubscribe = onIdentityChange(() => {
      this.dispose();
      this.invalidated?.();
      this.notify("Media unavailable after the account changed. Reopen this page to load it.");
    });
  }

  reconcile(urls: Set<string>) {
    this.references = urls;
    for (const [url, entry] of this.entries) if (!urls.has(url)) this.release(url, entry);
  }

  dispose() {
    this.active = false;
    this.epoch++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const [url, entry] of this.entries) this.release(url, entry);
    for (const [url, download] of this.downloads) {
      clearTimeout(download.timer);
      URL.revokeObjectURL(url);
      this.bytes -= download.bytes;
    }
    this.downloads.clear();
    for (const wake of this.waiters) wake();
  }

  private release(url: string, entry: Entry) {
    if (this.entries.get(url) !== entry) return;
    this.entries.delete(url);
    entry.controller.abort();
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    this.bytes -= entry.reserved;
    entry.reserved = 0;
  }

  private check(url: string, entry: Entry, epoch: number) {
    if (!this.active || epoch !== this.epoch || this.generation !== identityGeneration() || entry.controller.signal.aborted || this.entries.get(url) !== entry || !this.references.has(url)) throw new Error("Media request no longer belongs to this page");
  }

  private async slot(signal: AbortSignal) {
    while (this.inFlight >= 2) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => { this.waiters.delete(finish); signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.waiters.delete(finish); signal.removeEventListener("abort", abort); reject(new Error("Media request cancelled")); };
        if (signal.aborted) return abort();
        this.waiters.add(finish);
        signal.addEventListener("abort", abort, { once: true });
      });
      if (signal.aborted) throw new Error("Media request cancelled");
    }
    if (signal.aborted) throw new Error("Media request cancelled");
    this.inFlight++;
  }

  private request(url: string, method: "GET" | "HEAD", signal: AbortSignal) {
    const searchParams = new URLSearchParams({ url });
    if (this.shareToken) return fetch(apiUrl(`public/wiki/${encodeURIComponent(this.shareToken)}/media`, searchParams), { method, credentials: "include", signal, redirect: "error" }).then(response => {
      if (!response.ok) throw new Error("Shared media is unavailable");
      return response;
    });
    // Only this fixed configured-API path receives the existing bearer token.
    return api("uploads/media", { method, searchParams, signal, redirect: "error" });
  }

  private async load(url: string, entry: Entry, epoch: number) {
    const queueTimer = setTimeout(() => entry.controller.abort(), 120000);
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const progress = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => entry.controller.abort(), 20000);
    };
    let acquired = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | undefined;
    try {
      await this.slot(entry.controller.signal);
      acquired = true;
      clearTimeout(queueTimer);
      absoluteTimer = setTimeout(() => entry.controller.abort(), 300000);
      progress();
      this.check(url, entry, epoch);
      const head = await this.request(url, "HEAD", entry.controller.signal);
      this.check(url, entry, epoch);
      progress();
      const limit = Math.min(this.objectLimit, url.includes("/uploads/avatars/") ? AVATAR_LIMIT : WIKI_LIMIT);
      const spelling = head.headers.get("content-length");
      const length = spelling && /^\d+$/.test(spelling) ? Number(spelling) : limit;
      if (!Number.isSafeInteger(length) || length < 0 || length > limit || this.bytes + length > CAP) throw new Error("Media exceeds this page’s loading limit. Its stored reference is unchanged.");
      entry.reserved = length;
      this.bytes += length;
      const response = await this.request(url, "GET", entry.controller.signal);
      body = response.body ?? undefined;
      this.check(url, entry, epoch);
      progress();
      const mime = (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let total = 0;
      if (!response.body) throw new Error("Media response has no body");
      reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        this.check(url, entry, epoch);
        progress();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > length || total > limit) throw new Error("Media changed or exceeded its loading limit");
        chunks.push(new Uint8Array(chunk.value));
      }
      if (spelling !== null && total !== length) throw new Error("Media changed while loading");
      this.bytes -= length - total;
      entry.reserved = total;
      this.check(url, entry, epoch);
      entry.mime = mime;
      entry.blob = new Blob(chunks, { type: mime });
      if (SAFE.test(mime)) entry.objectUrl = URL.createObjectURL(entry.blob);
      this.check(url, entry, epoch);
      return entry;
    } catch (error) {
      this.release(url, entry);
      throw error;
    } finally {
      clearTimeout(queueTimer);
      clearTimeout(absoluteTimer);
      clearTimeout(stallTimer);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (!reader) await body?.cancel().catch(() => {});
      if (acquired) this.inFlight--;
      for (const wake of [...this.waiters]) wake();
    }
  }

  private get(url: string) {
    let entry = this.entries.get(url);
    if (!entry) {
      if (!this.active || !this.references.has(url) || this.entries.size >= 256) return Promise.reject(new Error("Media is unavailable on this page"));
      entry = { controller: new AbortController(), reserved: 0, promise: undefined! };
      this.entries.set(url, entry);
      entry.promise = this.load(url, entry, this.epoch);
      void entry.promise.catch(() => {});
    }
    return entry.promise;
  }

  resolve = async (url: string) => {
    if (!isUploadedMediaUrl(url)) return url;
    const epoch = this.epoch;
    try {
      const entry = await this.get(url);
      this.check(url, entry, this.epoch);
      if (!entry.objectUrl) throw new Error("This file is download-only. Use Download file to save it safely.");
      return entry.objectUrl;
    } catch (error) {
      if (this.active && epoch === this.epoch && this.generation === identityGeneration()) this.notify(error instanceof Error ? error.message : "Media unavailable");
      throw error;
    }
  };

  download = async (url: string, name: string) => {
    const epoch = this.epoch;
    try {
      if (!isUploadedMediaUrl(url)) throw new Error("Not an uploaded media URL");
      const entry = await this.get(url);
      this.check(url, entry, this.epoch);
      if (!entry.blob || this.bytes + entry.blob.size > CAP) throw new Error("Download exceeds this page’s loading limit");
      const objectUrl = URL.createObjectURL(new Blob([entry.blob], { type: "application/octet-stream" }));
      const bytes = entry.blob.size;
      this.bytes += bytes;
      const timer = setTimeout(() => { if (this.downloads.delete(objectUrl)) { URL.revokeObjectURL(objectUrl); this.bytes -= bytes; } }, 2000);
      this.downloads.set(objectUrl, { bytes, timer });
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = name.replace(/[\x00-\x1f\x7f/\\]/g, "_") || "download";
      anchor.hidden = true;
      document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); }
    } catch (error) {
      if (this.active && epoch === this.epoch && this.generation === identityGeneration()) this.notify(error instanceof Error ? error.message : "Download unavailable");
      throw error;
    }
  };
}

interface EditorResolution {
  url: string;
  generation: number;
  dispatched: boolean;
  finish: (url: string) => void;
}

/** Core constructs image DOM during render and does not catch resolver errors.
 * Keep that construction inert until committed; refusals remain visibly
 * reported by the owner and never become a valid placeholder image or model.
 */
export class EditorMediaResolver {
  private committed = false;
  private epoch = 0;
  private pending = new Set<EditorResolution>();

  constructor(private owner: Pick<UploadedMediaOwner, "resolve">, private refuse?: (message: string) => void) {}

  resolve = (url: string): Promise<string> => {
    if (!isUploadedMediaUrl(url) && !isRetiredUploadedMediaUrl(url)) return Promise.resolve(url);
    return new Promise(resolve => {
      const request = { url, generation: identityGeneration(), dispatched: false, finish: resolve };
      this.pending.add(request);
      if (this.committed) this.drain();
      else if (this.epoch !== 0) queueMicrotask(() => {
        if (!this.committed || request.generation !== identityGeneration()) this.finish(request, "about:blank");
      });
    });
  };

  commit() {
    this.committed = true;
    this.epoch++;
    this.drain();
  }

  deactivate() {
    this.committed = false;
    this.epoch++;
    // Started work cannot migrate. A construction-only promise may survive
    // synchronous StrictMode setup/cleanup/setup in the same identity, but an
    // actual unmount settles it on this microtask, without a timer or IO.
    for (const request of this.pending) if (request.dispatched) this.finish(request, "about:blank");
    queueMicrotask(() => {
      for (const request of this.pending) {
        if (!this.committed || request.generation !== identityGeneration()) this.finish(request, "about:blank");
      }
    });
  }

  private finish(request: EditorResolution, url: string) {
    if (!this.pending.delete(request)) return;
    request.finish(url);
  }

  private drain() {
    const epoch = this.epoch;
    queueMicrotask(() => {
      if (!this.committed || epoch !== this.epoch) return;
      for (const request of this.pending) {
        if (request.dispatched) continue;
        if (request.generation !== identityGeneration()) { this.finish(request, "about:blank"); continue; }
        request.dispatched = true;
        if (isRetiredUploadedMediaUrl(request.url)) {
          this.refuse?.("This legacy media reference is unavailable. Its stored reference is unchanged.");
          this.finish(request, "about:blank");
          continue;
        }
        void this.owner.resolve(request.url).then(
          url => this.finish(request, this.committed && epoch === this.epoch && request.generation === identityGeneration() ? url : "about:blank"),
          () => this.finish(request, "about:blank"),
        );
      }
    });
  }
}
