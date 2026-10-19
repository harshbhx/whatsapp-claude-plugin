import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock";

const dir = mkdtempSync(join(tmpdir(), "wa-file-lock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// util-linux flock(1) takes the same flock(2) lock Python's fcntl.flock does,
// which is what the urgent-watch watcher holds while it rewrites the file.
const flockCli = Bun.which("flock");
const interop = process.platform === "linux" && !!flockCli;

/** Whether someone else could take the lock right now. */
function free(lockPath: string): boolean {
  return Bun.spawnSync([flockCli!, "-n", lockPath, "true"]).exitCode === 0;
}

describe("withFileLock", () => {
  test("runs fn, returns its value and creates the lock file", () => {
    const lockPath = join(dir, "basic.lock");
    const { value } = withFileLock(lockPath, () => 41 + 1);
    expect(value).toBe(42);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("an error from fn propagates and the lock is still released", () => {
    const lockPath = join(dir, "throws.lock");
    expect(() =>
      withFileLock(lockPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    if (interop) expect(free(lockPath)).toBe(true);
  });

  test.skipIf(!interop)(
    "holds a real flock while fn runs, visible to flock(1), and releases it",
    () => {
      const lockPath = join(dir, "held.lock");
      const { value, locked } = withFileLock(lockPath, () => free(lockPath));
      expect(locked).toBe(true);
      expect(value).toBe(false);
      expect(free(lockPath)).toBe(true);
    },
  );

  test.skipIf(!interop)(
    "waits for another process's flock, then takes it",
    async () => {
      const lockPath = join(dir, "wait.lock");
      const holder = Bun.spawn([flockCli!, lockPath, "sleep", "0.6"]);
      const deadline = Date.now() + 3000;
      while (free(lockPath) && Date.now() < deadline) await Bun.sleep(20);
      expect(free(lockPath)).toBe(false);
      const started = Date.now();
      const { locked } = withFileLock(lockPath, () => true, 5000);
      expect(locked).toBe(true);
      expect(Date.now() - started).toBeGreaterThan(100);
      await holder.exited;
    },
  );

  test.skipIf(!interop)(
    "gives up after the timeout and still runs fn, reporting locked: false",
    async () => {
      const lockPath = join(dir, "timeout.lock");
      const holder = Bun.spawn([flockCli!, lockPath, "sleep", "2"]);
      try {
        const deadline = Date.now() + 3000;
        while (free(lockPath) && Date.now() < deadline) await Bun.sleep(20);
        let ran = false;
        const { locked } = withFileLock(
          lockPath,
          () => {
            ran = true;
          },
          100,
        );
        expect(locked).toBe(false);
        expect(ran).toBe(true);
      } finally {
        holder.kill();
        await holder.exited;
      }
    },
  );
});
