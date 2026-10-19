// An exclusive flock(2) on a lock file: the same lock Python's
// fcntl.flock(f, LOCK_EX) and util-linux flock(1) take, so this server and a
// script outside it (the urgent-watch escalation watcher) never rewrite the
// same file at once. An O_EXCL lock file would not do: the watcher's flock
// never sees it. node:fs has no flock, so it comes from libc through
// bun:ffi. It polls LOCK_NB for a bounded time rather than blocking, since a
// blocked call would stall the whole event loop.

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

// Identical on Linux and macOS.
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

type Flock = (fd: number, operation: number) => number;
let cached: Flock | null | undefined;

function libcFlock(): Flock | null {
  if (cached !== undefined) return cached;
  cached = null;
  const names =
    process.platform === "linux"
      ? ["libc.so.6", "libc.so"]
      : process.platform === "darwin"
        ? ["libc.dylib", "/usr/lib/libSystem.B.dylib"]
        : [];
  for (const name of names) {
    try {
      const lib = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      cached = (fd, operation) => lib.symbols.flock(fd, operation) as number;
      break;
    } catch {}
  }
  return cached;
}

/** Runs `fn` while holding an exclusive flock on `lockPath` (created if
 *  missing). `locked` is false when no lock could be taken: no libc flock on
 *  this platform, the lock file could not be opened, or another holder kept
 *  it past `timeoutMs`. `fn` runs either way: the writes it guards are atomic
 *  on their own, and skipping one would lose it outright. Throws only what
 *  `fn` throws. */
export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  timeoutMs = 2000,
): { value: T; locked: boolean } {
  const flock = libcFlock();
  let fd: number | undefined;
  let locked = false;
  try {
    if (flock) {
      try {
        fd = openSync(lockPath, "a", 0o600);
      } catch {}
      if (fd !== undefined) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          locked = flock(fd, LOCK_EX | LOCK_NB) === 0;
          if (locked || Date.now() >= deadline) break;
          Bun.sleepSync(10);
        }
      }
    }
    return { value: fn(), locked };
  } finally {
    if (fd !== undefined) {
      if (locked)
        try {
          flock!(fd, LOCK_UN);
        } catch {}
      try {
        closeSync(fd);
      } catch {}
    }
  }
}
