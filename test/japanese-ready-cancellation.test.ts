import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SearchBusyError, SearchCancelledError, SearchUnavailableError } from "../src/errors.js";
import { JapaneseSearchRepository } from "../src/japanese/repository.js";
import { createTempDir, removeTempDir } from "./support/temp-dir.js";

const metadata = {
  schema_version: 2,
  tokenizer: "vaporetto-pretokenized-unicode61",
  indexed_at: "2026-01-01T00:00:00.000Z",
  source_record_count: 0,
  source_max_id: 0,
};

class FakeWorker extends EventEmitter {
  terminated = false;
  readonly posted: unknown[] = [];

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  terminate(): Promise<number> {
    this.terminated = true;
    queueMicrotask(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }

  becomeReady(): void {
    this.emit("message", { type: "ready", metadata });
  }
}

function setup(extra: Record<string, unknown> = {}) {
  const dir = createTempDir("japanese-ready-cancel-");
  const indexPath = join(dir, "index.sqlite");
  const extensionPath = join(dir, "extension.so");
  writeFileSync(indexPath, "index");
  writeFileSync(extensionPath, "extension");
  const workers: FakeWorker[] = [];
  const repo = JapaneseSearchRepository.open({
    indexPath,
    extensionPath,
    busyTimeoutMs: 500,
    maxLimit: 10,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ...extra,
  });
  return { dir, workers, repo };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("ready(signal) gives pre-aborted signals precedence and preserves the abort reason", async () => {
  const { dir, repo } = setup();
  const controller = new AbortController();
  const reason = new Error("caller deadline");
  controller.abort(reason);
  try {
    await assert.rejects(repo.ready(controller.signal), (error) =>
      error instanceof SearchCancelledError && error.cause === reason,
    );
  } finally {
    repo.close();
    removeTempDir(dir);
  }
});

test("ready(signal) removes one cancelled waiter without affecting other waiters", async () => {
  const { dir, workers, repo } = setup();
  const first = new AbortController();
  const second = new AbortController();
  try {
    const firstReady = repo.ready(first.signal);
    const secondReady = repo.ready(second.signal);
    await waitUntil(() => workers.length === 1);
    first.abort(new Error("not needed"));
    await assert.rejects(firstReady, SearchCancelledError);
    assert.equal(getEventListeners(first.signal, "abort").length, 0);
    assert.equal(workers[0]!.terminated, false);
    workers[0]!.becomeReady();
    await secondReady;
    assert.equal(getEventListeners(second.signal, "abort").length, 0);
  } finally {
    repo.close();
    removeTempDir(dir);
  }
});

test("cancelling the last ready waiter while Worker startup is in progress does not terminate the Worker", async () => {
  const { dir, workers, repo } = setup();
  const controller = new AbortController();
  try {
    const pending = repo.ready(controller.signal);
    await waitUntil(() => workers.length === 1);
    controller.abort();
    await assert.rejects(pending, SearchCancelledError);
    assert.equal(workers[0]!.terminated, false);
    workers[0]!.becomeReady();
    await repo.ready();
    assert.equal(workers.length, 1);
  } finally {
    repo.close();
    removeTempDir(dir);
  }
});

test("repeated short ready deadlines cannot postpone a pending restart forever", async () => {
  const { dir, workers, repo } = setup({ restartBaseDelayMs: 70, restartMaxDelayMs: 70 });
  const keepAlive = setTimeout(() => undefined, 1500);
  try {
    const initialController = new AbortController();
    const initialTimeout = setTimeout(() => initialController.abort(new Error("initial short deadline")), 12);
    const initial = repo.ready(initialController.signal);
    await waitUntil(() => workers.length === 1);
    workers[0]!.emit("error", new Error("transient startup failure"));
    // The first caller remains demand until its deadline expires.
    await assert.rejects(initial, SearchCancelledError);
    clearTimeout(initialTimeout);
    for (let attempt = 0; attempt < 8 && workers.length === 1; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("short deadline")), 12);
      const pending = repo.ready(controller.signal);
      await assert.rejects(pending, SearchCancelledError);
      clearTimeout(timeout);
    }
    const finalController = new AbortController();
    const pending = repo.ready(finalController.signal);
    await waitUntil(() => workers.length === 2, 500);
    workers[1]!.becomeReady();
    await pending;
    assert.equal(workers.length, 2);
  } finally {
    clearTimeout(keepAlive);
    repo.close();
    removeTempDir(dir);
  }
});

test("maxPendingRequests is enforced and reports a retryable SearchBusyError", async () => {
  const { dir, workers, repo } = setup({ maxPendingRequests: 1 });
  try {
    const first = repo.search({ query: "first", mode: "any", limit: 1, offset: 0 });
    await assert.rejects(
      repo.search({ query: "second", mode: "any", limit: 1, offset: 0 }),
      (error) => error instanceof SearchBusyError && error.code === "SEARCH_BUSY" && error.retryable,
    );
    await waitUntil(() => workers.length === 1);
    workers[0]!.becomeReady();
    await waitUntil(() => workers[0]!.posted.length === 1);
    const id = (workers[0]!.posted[0] as { id: number }).id;
    workers[0]!.emit("message", { type: "result", id, ok: true, value: { id } });
    assert.deepEqual(await first, { id });
  } finally {
    repo.close();
    removeTempDir(dir);
  }
});

test("terminal Worker startup failure rejects ready and search with SearchUnavailableError", async () => {
  const { dir, workers, repo } = setup();
  try {
    const ready = repo.ready();
    await waitUntil(() => workers.length === 1);
    workers[0]!.emit("message", { type: "startup-error", message: "invalid snapshot" });
    await assert.rejects(ready, SearchUnavailableError);
    await assert.rejects(
      repo.search({ query: "after-startup-error", mode: "any", limit: 1, offset: 0 }),
      SearchUnavailableError,
    );
  } finally {
    repo.close();
    removeTempDir(dir);
  }
});

test("close rejects queued searches with SearchUnavailableError", async () => {
  const { dir, workers, repo } = setup();
  try {
    const pending = repo.search({ query: "pending-close", mode: "any", limit: 1, offset: 0 });
    await waitUntil(() => workers.length === 1);
    repo.close();
    await assert.rejects(pending, SearchUnavailableError);
  } finally {
    repo.close();
    removeTempDir(dir);
  }
});

test("a synchronous transient Worker factory failure uses bounded recovery", async () => {
  const dir = createTempDir("japanese-sync-spawn-failure-");
  const indexPath = join(dir, "index.sqlite");
  const extensionPath = join(dir, "extension.so");
  writeFileSync(indexPath, "index");
  writeFileSync(extensionPath, "extension");
  let attempts = 0;
  let worker: FakeWorker | undefined;
  const repo = JapaneseSearchRepository.open({
    indexPath,
    extensionPath,
    busyTimeoutMs: 500,
    maxLimit: 10,
    restartBaseDelayMs: 2,
    maxRestartAttempts: 2,
    workerFactory: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary worker thread resource limit");
      worker = new FakeWorker();
      return worker;
    },
  });
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const pending = repo.ready();
    await waitUntil(() => worker !== undefined);
    worker!.becomeReady();
    await pending;
    assert.equal(attempts, 2);
  } finally {
    clearTimeout(keepAlive);
    repo.close();
    removeTempDir(dir);
  }
});

test("cancelling the last readiness waiter during Worker termination preserves the retry deadline", async () => {
  const { dir, workers, repo } = setup({ restartBaseDelayMs: 40, restartMaxDelayMs: 40 });
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const controller = new AbortController();
    const pending = repo.ready(controller.signal);
    await waitUntil(() => workers.length === 1);
    workers[0]!.emit("error", new Error("worker failed before ready"));
    controller.abort(new Error("caller no longer needs readiness"));
    await assert.rejects(pending, SearchCancelledError);
    await waitUntil(() => workers[0]!.terminated);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await new Promise((resolve) => setTimeout(resolve, 45));
    const next = repo.ready();
    await waitUntil(() => workers.length === 2);
    workers[1]!.becomeReady();
    await next;
  } finally {
    clearTimeout(keepAlive);
    repo.close();
    removeTempDir(dir);
  }
});
