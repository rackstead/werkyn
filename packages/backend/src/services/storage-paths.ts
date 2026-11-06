import fs, { type FileHandle } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { ForbiddenError } from "../utils/errors.js";

/**
 * Filesystem access below the storage root that never follows a symbolic
 * link (R33, docs/remediation/r33-storage-symlinks.md).
 *
 * The storage root itself may be a symbolic link or a mount point. It is
 * resolved once with realpath and trusted from then on. Below it, each
 * directory is opened with O_NOFOLLOW inside the directory opened before it,
 * and the last name is opened, created, examined or removed inside its
 * parent's open descriptor. On Linux the descriptor is addressed as
 * `/proc/self/fd/<fd>/<name>`, which resolves `<name>` in exactly the
 * directory that was opened (as openat(2) would): replacing a directory with
 * a link after it was checked cannot redirect the access. Without /proc
 * (macOS development) the same checks run on full paths, which narrows the
 * window between check and use but cannot close it.
 *
 * Hard links are not refused: a hard link is an ordinary directory entry of
 * a regular file, the application never creates one, and only someone who
 * can already write to the storage volume can. New files are always created
 * with O_EXCL, so a write never reaches an existing file through one.
 */

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** Open flags for reading a file that must not be a link. */
export const READ_NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
/** Open flags for creating a new file; an existing entry, link or not, fails with EEXIST. */
export const CREATE_NO_FOLLOW =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export type StorageRefusal = "symbolic-link" | "not-a-file";

/** A symbolic link, or something other than a regular file, where a stored file was expected. */
export class StorageRefusedError extends ForbiddenError {
  readonly code = "ESTORAGEREFUSED";
  constructor(
    readonly storagePath: string,
    readonly reason: StorageRefusal,
  ) {
    super("Stored file is not accessible");
  }
}

export function isStorageRefusedError(error: unknown): error is StorageRefusedError {
  return error instanceof StorageRefusedError;
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;
/** ENOENT/ENOTDIR: the entry, or a directory above it, does not exist. */
const isMissing = (error: unknown) => errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";

/**
 * The names below `root` that `storagePath` designates. Paths that leave the
 * root, or name the root itself, are refused.
 */
export function storagePathNames(root: string, storagePath: string): string[] {
  if (typeof storagePath !== "string" || storagePath.includes("\0")) {
    throw new Error("Path traversal detected");
  }
  const relative = path.relative(root, path.resolve(root, storagePath));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Path traversal detected");
  }
  return relative.split(path.sep);
}

let procFd: Promise<boolean> | undefined;

/** Whether /proc/self/fd/<fd> reaches an open directory (Linux), checked once. */
function procFdSupported(directory: FileHandle): Promise<boolean> {
  return (procFd ??= fs.stat(`/proc/self/fd/${directory.fd}`).then(
    (stat) => stat.isDirectory(),
    () => false,
  ));
}

/**
 * ELOOP, ENOTDIR (Linux, for O_DIRECTORY) and EMLINK (BSD) are how an open
 * with O_NOFOLLOW reports a link; EEXIST is how O_EXCL and mkdir do. The
 * entry is examined to tell a link from the other causes of those errors.
 */
async function refusalOf(error: unknown, entry: string, storagePath: string): Promise<unknown> {
  const code = errorCode(error);
  if (code !== "ELOOP" && code !== "ENOTDIR" && code !== "EMLINK" && code !== "EEXIST") return error;
  const stat = await fs.lstat(entry).catch(() => undefined);
  return stat?.isSymbolicLink() ? new StorageRefusedError(storagePath, "symbolic-link") : error;
}

/** Open directories from the root down, each opened inside the one before it. */
class DirectoryChain {
  constructor(
    /** Whether entries are addressed through /proc/self/fd. */
    readonly proc: boolean,
    private readonly handles: FileHandle[],
    private readonly paths: string[],
  ) {}

  /** The real path of the deepest directory (for messages and the fallback). */
  get path() {
    return this.paths[this.paths.length - 1];
  }

  /** How `name` in the deepest directory is addressed. */
  entry(name: string) {
    const handle = this.handles[this.handles.length - 1];
    return this.proc ? `/proc/self/fd/${handle.fd}/${name}` : path.join(this.path, name);
  }

  async close() {
    await Promise.all(this.handles.map((handle) => handle.close().catch(() => {})));
  }
}

export interface StorageRootOptions {
  /**
   * Address open directories through /proc/self/fd. Defaults to whether it
   * is available; tests turn it off to exercise the path-based fallback.
   */
  procFd?: boolean;
}

/** An open regular file and its metadata. */
export interface OpenedFile {
  handle: FileHandle;
  stat: Stats;
  /** `/proc/self/fd/<fd>`: reopens exactly this file; absent without /proc. */
  procPath?: string;
}

/** A file just created by `createFile`. */
export interface CreatedFile {
  handle: FileHandle;
  /**
   * The shallowest directory (as a count of names below the root) that the
   * call created, or undefined when every directory already existed.
   */
  createdFrom?: number;
}

/** A directory opened by `openDirectory`; close it when done. */
export interface StorageDirectory {
  /** Its real path. */
  readonly path: string;
  /** How `name` in it is addressed (relative to its open descriptor where possible). */
  entry(name: string): string;
  list(): Promise<string[]>;
  close(): Promise<void>;
}

export type UnlinkResult = "removed" | "missing" | "link-removed";

/** The storage root: a trusted real path, below which no link is followed. */
export class StorageRoot {
  constructor(
    /** The root's real path (already resolved). */
    readonly path: string,
    private readonly options: StorageRootOptions = {},
  ) {}

  /**
   * "descriptor": names are resolved inside open directories through
   * /proc/self/fd, so no check can be raced. "path": the per-name checks run
   * on full paths (no /proc), and a link swapped in during an access can
   * still be followed.
   */
  async accessMode(): Promise<"descriptor" | "path"> {
    if (this.options.procFd !== undefined) return this.options.procFd ? "descriptor" : "path";
    const handle = await fs.open(this.path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      return (await procFdSupported(handle)) ? "descriptor" : "path";
    } finally {
      await handle.close();
    }
  }

  /** The names `storagePath` designates below the root; refuses traversal. */
  names(storagePath: string) {
    return storagePathNames(this.path, storagePath);
  }

  /**
   * Open `names` below the root, one directory at a time. With `create`,
   * missing directories are made (with `mode`) and `onCreate` hears the
   * index of each one this call made.
   */
  private async walk(
    names: string[],
    storagePath: string,
    create = false,
    onCreate?: (index: number) => void,
    mode = 0o777,
  ): Promise<DirectoryChain> {
    const handles: FileHandle[] = [];
    const paths = [this.path];
    try {
      // The root may itself be a link or mount point; it is opened normally.
      handles.push(await fs.open(this.path, constants.O_RDONLY | constants.O_DIRECTORY));
      const proc = this.options.procFd ?? (await procFdSupported(handles[0]));
      for (const [index, name] of names.entries()) {
        const chain = new DirectoryChain(proc, handles, paths);
        const entry = chain.entry(name);
        let handle: FileHandle;
        try {
          handle = await fs.open(entry, DIRECTORY);
        } catch (error) {
          if (!create || errorCode(error) !== "ENOENT") throw await refusalOf(error, entry, storagePath);
          try {
            await fs.mkdir(entry, mode);
            onCreate?.(index);
          } catch (made) {
            // Made concurrently by another write; a link fails the open below.
            if (errorCode(made) !== "EEXIST") throw made;
          }
          try {
            handle = await fs.open(entry, DIRECTORY);
          } catch (reopen) {
            throw await refusalOf(reopen, entry, storagePath);
          }
        }
        handles.push(handle);
        paths.push(path.join(chain.path, name));
      }
      return new DirectoryChain(proc, handles, paths);
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
      throw error;
    }
  }

  /**
   * An existing regular file, opened for reading. A link anywhere below the
   * root is refused; so is a FIFO, device, socket or directory, which is
   * opened without blocking only to be examined.
   */
  async openFile(storagePath: string): Promise<OpenedFile> {
    const names = this.names(storagePath);
    const leaf = names.pop()!;
    const chain = await this.walk(names, storagePath);
    let handle: FileHandle;
    try {
      const entry = chain.entry(leaf);
      try {
        handle = await fs.open(entry, READ_NO_FOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        throw await refusalOf(error, entry, storagePath);
      }
    } finally {
      await chain.close();
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new StorageRefusedError(storagePath, "not-a-file");
      return { handle, stat, ...(chain.proc && { procPath: `/proc/self/fd/${handle.fd}` }) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /**
   * Create `storagePath` as a new file, never opening an existing entry, and
   * make the directories it needs. If concurrent cleanup removes one of them
   * meanwhile, the whole attempt is repeated (three attempts in all). On
   * failure, directories this call made are removed again while empty.
   */
  async createFile(storagePath: string, mode = 0o666): Promise<CreatedFile> {
    const names = this.names(storagePath);
    const leaf = names.pop()!;
    let createdFrom: number | undefined;
    const made = (index: number) => {
      if (createdFrom === undefined || index < createdFrom) createdFrom = index;
    };
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const chain = await this.walk(names, storagePath, true, made);
          try {
            const entry = chain.entry(leaf);
            try {
              return { handle: await fs.open(entry, CREATE_NO_FOLLOW, mode), createdFrom };
            } catch (error) {
              throw await refusalOf(error, entry, storagePath);
            }
          } finally {
            await chain.close();
          }
        } catch (error) {
          if (errorCode(error) !== "ENOENT" || attempt >= 3) throw error;
        }
      }
    } catch (error) {
      if (createdFrom !== undefined) await this.removeEmptyDirectories(storagePath, createdFrom);
      throw error;
    }
  }

  /**
   * Remove the directories holding `storagePath`, deepest first, down to
   * depth `from` (a count of names below the root), while they are empty.
   * Stops at the first that is not empty, is gone or is a link.
   */
  async removeEmptyDirectories(storagePath: string, from: number) {
    const names = this.names(storagePath).slice(0, -1);
    for (let depth = names.length; depth > Math.max(from, 0); depth--) {
      let chain: DirectoryChain;
      try {
        chain = await this.walk(names.slice(0, depth - 1), storagePath);
      } catch {
        return;
      }
      try {
        await fs.rmdir(chain.entry(names[depth - 1]));
      } catch {
        return; // not empty (another write uses it), already gone, or not a directory
      } finally {
        await chain.close();
      }
    }
  }

  /**
   * Remove `storagePath`. A link there is removed itself; what it points to
   * is never touched. A link in a directory above it is refused.
   */
  async unlink(storagePath: string): Promise<UnlinkResult> {
    const names = this.names(storagePath);
    const leaf = names.pop()!;
    let chain: DirectoryChain;
    try {
      chain = await this.walk(names, storagePath);
    } catch (error) {
      if (isMissing(error)) return "missing";
      throw error;
    }
    try {
      const entry = chain.entry(leaf);
      let stat: Stats;
      try {
        stat = await fs.lstat(entry);
      } catch (error) {
        if (isMissing(error)) return "missing";
        throw error;
      }
      if (stat.isDirectory()) throw new StorageRefusedError(storagePath, "not-a-file");
      try {
        await fs.unlink(entry);
      } catch (error) {
        if (isMissing(error)) return "missing";
        throw error;
      }
      return stat.isSymbolicLink() ? "link-removed" : "removed";
    } finally {
      await chain.close();
    }
  }

  /** Whether `storagePath` is a regular file; a link or special file there is refused. */
  async exists(storagePath: string): Promise<boolean> {
    const names = this.names(storagePath);
    const leaf = names.pop()!;
    let chain: DirectoryChain;
    try {
      chain = await this.walk(names, storagePath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    try {
      const stat = await fs.lstat(chain.entry(leaf));
      if (stat.isSymbolicLink()) throw new StorageRefusedError(storagePath, "symbolic-link");
      if (!stat.isFile()) throw new StorageRefusedError(storagePath, "not-a-file");
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    } finally {
      await chain.close();
    }
  }

  /** Open the directory `relative` below the root (made with `mode` if `create`), refusing links. */
  async openDirectory(
    relative: string,
    { create = false, mode = 0o777 }: { create?: boolean; mode?: number } = {},
  ): Promise<StorageDirectory> {
    const chain = await this.walk(this.names(relative), relative, create, undefined, mode);
    return {
      path: chain.path,
      entry: (name) => chain.entry(name),
      list: () => fs.readdir(chain.entry(".")),
      close: () => chain.close(),
    };
  }
}

/** What `findStorageLinks` reports: an entry the storage access refuses. */
export interface StorageLinkFinding {
  /** The entry's path below the root, with `/` separators. */
  path: string;
  kind: "symbolic-link" | "fifo" | "socket" | "device" | "other";
  /** Where a link points, as stored in the link. */
  target?: string;
}

/**
 * Walk the tree below `root` without following any link and report every
 * link and special file in it, up to `limit` findings (all are counted).
 * Read-only: it only lists directories, examines entries and reads links.
 */
export async function findStorageLinks(
  root: string,
  { limit = 1000, onFinding }: { limit?: number; onFinding?: (finding: StorageLinkFinding) => void } = {},
): Promise<{ findings: StorageLinkFinding[]; total: number; directories: number; unreadable: string[] }> {
  const findings: StorageLinkFinding[] = [];
  const unreadable: string[] = [];
  let total = 0;
  let directories = 0;
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const absolute = path.join(root, relative);
    let directory;
    try {
      directory = await fs.opendir(absolute);
    } catch {
      if (unreadable.length < limit) unreadable.push(relative || ".");
      continue;
    }
    directories++;
    for await (const dirent of directory) {
      const child = relative ? `${relative}/${dirent.name}` : dirent.name;
      // Some filesystems do not report entry types; examine those (never following).
      const known = [dirent.isDirectory(), dirent.isFile(), dirent.isSymbolicLink(), dirent.isFIFO(),
        dirent.isSocket(), dirent.isBlockDevice(), dirent.isCharacterDevice()].some(Boolean);
      const type = known ? dirent : await fs.lstat(path.join(absolute, dirent.name)).catch(() => dirent);
      if (type.isDirectory()) {
        pending.push(child);
        continue;
      }
      if (type.isFile()) continue;
      const kind: StorageLinkFinding["kind"] = type.isSymbolicLink()
        ? "symbolic-link"
        : type.isFIFO()
          ? "fifo"
          : type.isSocket()
            ? "socket"
            : type.isBlockDevice() || type.isCharacterDevice()
              ? "device"
              : "other";
      const finding: StorageLinkFinding = { path: child, kind };
      if (kind === "symbolic-link") {
        finding.target = await fs.readlink(path.join(absolute, dirent.name)).catch(() => undefined);
      }
      total++;
      onFinding?.(finding);
      if (findings.length < limit) findings.push(finding);
    }
  }
  return { findings, total, directories, unreadable };
}
