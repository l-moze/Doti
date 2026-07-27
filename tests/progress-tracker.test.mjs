import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTsModule } from "./helpers/load-ts-module.mjs";

const quietConsole = { log: () => {}, warn: () => {}, error: () => {} };

function withTracker(run) {
  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doti-progress-"));
  const processStub = {
    ...process,
    env: { ...process.env, DESKTOP_UPLOADS_ROOT: uploadsRoot },
  };
  const { ProgressTracker } = loadTsModule("src/lib/progress-tracker.ts", {
    console: quietConsole,
    process: processStub,
  });
  const identity = {
    fileHash: "filehash",
    targetLang: "Chinese",
    provider: "deepseek",
    model: "deepseek-chat",
  };
  const createTracker = (jobId) => new ProgressTracker(identity, jobId);

  return Promise.resolve(run({ createTracker, identity, uploadsRoot }))
    .finally(() => fs.rmSync(uploadsRoot, { recursive: true, force: true }));
}

test("a fresh document has neither a full nor a partial cache", () => withTracker(async ({ createTracker }) => {
  const tracker = createTracker("job-1");

  assert.equal(await tracker.hasFullCache(), false);
  assert.equal(await tracker.hasPartialCache(), false);
  assert.equal(await tracker.readFullCache(), null);
  assert.equal(await tracker.readProgress(), null);
  assert.equal(await tracker.readActiveJob(), null);
}));

test("only one job can hold the translation lock at a time", () => withTracker(async ({ createTracker }) => {
  const first = createTracker();
  const second = createTracker();

  assert.deepEqual({ ...await first.acquireActiveJob("job-1") }, { acquired: true });
  assert.equal(first.getJobId(), "job-1");

  const contested = await second.acquireActiveJob("job-2");
  assert.equal(contested.acquired, false);
  assert.equal(contested.activeJob.jobId, "job-1");
}));

test("releasing the lock lets another job acquire it", () => withTracker(async ({ createTracker }) => {
  const first = createTracker();
  await first.acquireActiveJob("job-1");
  await first.releaseActiveJob();

  assert.equal(first.getJobId(), null);
  assert.equal((await createTracker().acquireActiveJob("job-2")).acquired, true);
}));

test("a job may not release a lock owned by someone else", () => withTracker(async ({ createTracker }) => {
  const owner = createTracker();
  await owner.acquireActiveJob("job-1");

  const intruder = createTracker("job-2");
  await intruder.releaseActiveJob();

  const activeJob = await owner.readActiveJob({ pruneStale: false });
  assert.equal(activeJob.jobId, "job-1");
}));

test("stale locks are pruned so an abandoned job cannot block translation", () => withTracker(async ({ createTracker, uploadsRoot }) => {
  const abandoned = createTracker();
  await abandoned.acquireActiveJob("job-1");

  const lockPath = fs.readdirSync(path.join(uploadsRoot, "filehash"))
    .find((fileName) => fileName.endsWith(".active-job.json"));
  const lockFullPath = path.join(uploadsRoot, "filehash", lockPath);
  const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const lock = JSON.parse(fs.readFileSync(lockFullPath, "utf-8"));
  fs.writeFileSync(lockFullPath, JSON.stringify({ ...lock, heartbeatAt: staleTimestamp }));

  assert.equal((await createTracker().acquireActiveJob("job-2")).acquired, true);
}));

test("chunks are appended in order and the partial cache can be resumed", () => withTracker(async ({ createTracker }) => {
  const source = "# Title\n\nBody paragraph.";
  const tracker = createTracker();
  await tracker.acquireActiveJob("job-1");
  await tracker.initProgress(2, source);

  await tracker.appendChunk(0, "第一段", true);
  assert.equal((await tracker.readProgress()).completedChunks, 1);
  assert.equal(await tracker.readPartialCache(), "第一段");
  assert.equal(await tracker.validatePartialCache(source), true);

  await tracker.appendChunk(1, "第二段", false);
  const progress = await tracker.readProgress();
  assert.equal(progress.completedChunks, 2);
  assert.equal(progress.totalChunks, 2);
  assert.equal(await tracker.readPartialCache(), "第一段\n\n第二段");
  assert.equal(await tracker.hasPartialCache(), true);
}));

test("progress is invalidated when the source markdown changes", () => withTracker(async ({ createTracker }) => {
  const tracker = createTracker();
  await tracker.acquireActiveJob("job-1");
  await tracker.initProgress(1, "original source");

  assert.equal(await tracker.validatePartialCache("original source"), true);
  assert.equal(await tracker.validatePartialCache("edited source"), false);
}));

test("another job cannot read or extend a partial cache it does not own", () => withTracker(async ({ createTracker }) => {
  const owner = createTracker();
  await owner.acquireActiveJob("job-1");
  await owner.initProgress(1, "source");
  await owner.appendChunk(0, "第一段", true);

  const other = createTracker("job-2");
  assert.equal(await other.hasPartialCache(), false);
  assert.equal(await other.readPartialCache(), null);
  assert.equal(await other.validatePartialCache("source"), false);
  await assert.rejects(() => other.appendChunk(1, "第二段", false), /Active job lock/);
}));

test("operations that need a job id fail without one", () => withTracker(async ({ createTracker }) => {
  const tracker = createTracker();

  await assert.rejects(() => tracker.initProgress(1, "source"), /Job ID is required/);
  await assert.rejects(() => tracker.appendChunk(0, "text", true), /Job ID is required/);
  await assert.rejects(() => tracker.finalize(), /Job ID is required/);
}));

test("finalizing promotes the partial cache and clears progress state", () => withTracker(async ({ createTracker }) => {
  const tracker = createTracker();
  await tracker.acquireActiveJob("job-1");
  await tracker.initProgress(1, "source");
  await tracker.appendChunk(0, "全文译文", true);
  await tracker.finalize();

  assert.equal(await tracker.hasFullCache(), true);
  assert.equal(await tracker.readFullCache(), "全文译文");
  assert.equal(await tracker.readProgress(), null);
  assert.equal(await tracker.hasPartialCache(), false);
}));

test("an incomplete translation cannot be finalized", () => withTracker(async ({ createTracker }) => {
  const tracker = createTracker();
  await tracker.acquireActiveJob("job-1");
  await tracker.initProgress(2, "source");
  await tracker.appendChunk(0, "只有一段", true);

  await assert.rejects(() => tracker.finalize(), /incomplete/i);
  assert.equal(await tracker.hasFullCache(), false);
}));

test("cleanup drops the partial cache and lock but keeps the finished translation", () => withTracker(async ({ createTracker }) => {
  const finished = createTracker();
  await finished.acquireActiveJob("job-1");
  await finished.initProgress(1, "source");
  await finished.appendChunk(0, "全文译文", true);
  await finished.finalize();
  await finished.releaseActiveJob();

  const resumed = createTracker();
  await resumed.acquireActiveJob("job-2");
  await resumed.initProgress(1, "source");
  await resumed.cleanup();

  assert.equal(await resumed.readProgress(), null);
  assert.equal(await resumed.readActiveJob({ pruneStale: false }), null);
  assert.equal(await resumed.hasFullCache(), true);
}));

test("reset removes the finished translation and every scratch file", () => withTracker(async ({ createTracker, uploadsRoot }) => {
  const tracker = createTracker();
  await tracker.acquireActiveJob("job-1");
  await tracker.initProgress(1, "source");
  await tracker.appendChunk(0, "全文译文", true);
  await tracker.finalize();

  await tracker.initProgress(1, "source");
  await tracker.reset();

  assert.equal(await tracker.hasFullCache(), false);
  assert.deepEqual(fs.readdirSync(path.join(uploadsRoot, "filehash")), []);
}));

test("the cache key follows the translation identity", () => withTracker(async ({ createTracker }) => {
  assert.match(createTracker().getCacheKey(), /^[0-9a-f]{16}$/);
  assert.equal(createTracker("job-1").getCacheKey(), createTracker("job-2").getCacheKey());
}));
