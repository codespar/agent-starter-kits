/**
 * Two processes on one state.db: a write transaction that meets another
 * process's write in progress waits for it (busy_timeout) instead of failing
 * with SQLITE_BUSY and taking the command down.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StateStore } from "../src/state/store.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("a write that meets another process's write", () => {
  it("waits for it and commits, instead of failing with SQLITE_BUSY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-core-busy-"));
    tempDirs.push(dir);
    const path = join(dir, "state.db");
    const store = new StateStore(path);

    // The other process takes the write lock, says so, holds it for 800 ms and commits.
    const holder = spawn(
      process.execPath,
      ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(path)}); db.exec("BEGIN IMMEDIATE"); process.stdout.write("held\\n"); const until = Date.now() + 800; while (Date.now() < until) {} db.exec("COMMIT");`],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((done) => holder.stdout.once("data", () => done()));
    const exited = new Promise<number | null>((done) => holder.on("exit", done));

    const started = Date.now();
    store.transaction(() => store.setCursor("busy-test", "written"));
    expect(store.getCursor("busy-test")).toBe("written");
    // It did wait: the lock was still held when the transaction began.
    expect(Date.now() - started).toBeGreaterThan(200);
    expect(await exited).toBe(0);
    store.close();
  });
});
