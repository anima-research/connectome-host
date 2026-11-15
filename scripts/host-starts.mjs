import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckError, hostStarts } from "./lib/host-starts.mjs";

const work = mkdtempSync(join(tmpdir(), "host-starts-"));
try {
  const { native } = hostStarts({ root: process.cwd(), cwd: work, work, subject: "this checkout", smokeTimeoutMs: 120_000 });
  console.log(`This checkout's host starts: ${native ? "@opentui/core loads, and " : ""}the offline smoke run answered.`);
} catch (error) {
  if (!(error instanceof CheckError)) throw error;
  console.error(`host-starts: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
