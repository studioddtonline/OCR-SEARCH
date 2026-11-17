import { accessSync, constants } from "node:fs";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { SearchBusyError, SearchCancelledError, SearchUnavailableError, SearchWorkerError } from "../errors.js";
import { SearchQueryValidationError } from "../query.js";
import { WorkerHost, type WorkerGeneration, type WorkerHostFailure, type WorkerThreadLike } from "../worker-host.js";

export interface JapaneseSearchOptions {
  indexPath: string;
  extensionPath: string;
  busyTimeoutMs: number;
  maxLimit: number;
  /** Maximum active + queued requests. Defaults to 4; valid range is 1–64. */
  maxPendingRequests?: number;
  log?: (...args: unknown[]) => void;
}

interface JapaneseSearchRuntimeOptions extends JapaneseSearchOptions {
  /** Test-only seams; not part of the package's public OcrSearchOptions type. */
  workerFactory?: (url: URL, options: WorkerOptions) => WorkerThreadLike;
  executionTimeoutMs?: number;
  startupTimeoutMs?: number;
  queueWaitTimeoutMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  maxRestartAttempts?: number;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export interface JapaneseSearchRequest {
  query: string;
  mode: "any" | "all";
  label?: string;
  reviewed?: boolean;
  limit: number;
  offset: number;
}

interface WorkerMetadata {
  schema_version: number;
  tokenizer: string;
  indexed_at: string;
  source_record_count: number;
  source_max_id: number;
}

interface QueuedSearch {
  id: number;
  request: JapaneseSearchRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timeout?: NodeJS.Timeout;
  queueTimeout?: NodeJS.Timeout;
  settled: boolean;
}

type WorkerLifecycle =
  | { kind: "starting"; restartAttempts: number }
  | { kind: "ready"; restartAttempts: number }
  | { kind: "idle"; restartAttempts: number; startupFailurePending: boolean }
  | {
      kind: "terminating";
      restartAttempts: number;
      startupFailurePending: boolean;
    }
  | { kind: "backoff"; restartAttempts: number; timer: NodeJS.Timeout }
  | { kind: "dead"; reason: "startup" | "retry-exhausted" }
  | { kind: "closed" };

interface RepositoryState {
  lifecycle: WorkerLifecycle;
  /** The queue pump is an orthogonal async dispatch lock, not a Worker lifecycle phase. */
  pumping: boolean;
}

type WorkerMessage =
  | { type: "ready"; metadata: WorkerMetadata }
  | { type: "startup-error"; message: string }
  | { type: "started"; id: number }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; code: string; operatorMessage?: string };

const DEFAULT_MAX_PENDING_REQUESTS = 4;
const DEFAULT_EXECUTION_TIMEOUT_MS = 20_000;
// Vaporetto model initialization can be expensive on low-power hosts; keep it off the main thread.
const DEFAULT_WORKER_STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 180_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 250;
const DEFAULT_RESTART_MAX_DELAY_MS = 8_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 5;

function assertNever(value: never): never {
  throw new Error(`Unexpected Japanese search lifecycle state: ${JSON.stringify(value)}`);
}

/**
 * Worker-backed reader for the separate sqlite-vaporetto index.
 * Requests are dispatched one at a time. Queue wait does not consume the execution timeout,
 * is capped at three minutes, and failed workers restart only for queued demand with bounded backoff.
 */
export class JapaneseSearchRepository {
  private readonly workerHost: WorkerHost<WorkerMessage, WorkerMetadata>;
  private readonly readyWaiters = new Set<ReadyWaiter>();
  /** Absolute monotonic deadline survives cancellation of a backoff timer. */
  private restartNotBefore = 0;
  private readonly queue: QueuedSearch[] = [];
  private active: QueuedSearch | undefined;
  private nextId = 1;
  private state: RepositoryState = {
    lifecycle: { kind: "starting", restartAttempts: 0 },
    pumping: false,
  };
  private get closed(): boolean {
    return this.state.lifecycle.kind === "closed";
  }

  private constructor(private readonly options: JapaneseSearchRuntimeOptions) {
    const factory: (url: URL, workerOptions: WorkerOptions) => WorkerThreadLike =
      options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions));
    this.workerHost = new WorkerHost<WorkerMessage, WorkerMetadata>({
      workerFactory: () => factory(new URL("./worker.mjs", import.meta.url), {
        workerData: {
          indexPath: options.indexPath,
          extensionPath: options.extensionPath,
          busyTimeoutMs: options.busyTimeoutMs,
        },
      }),
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_WORKER_STARTUP_TIMEOUT_MS,
      onMessage: (generation, message) => this.onMessage(message, generation),
      onFailure: (generation, failure) => this.onWorkerFailure(failure, generation),
      onTerminationError: (_generation, error) => options.log?.("[japanese-search] worker termination failed:", error),
    });
    this.startWorker();
  }

  /** Check the configured files cheaply; the native extension and index are initialized and validated in the worker. */
  static open(options: JapaneseSearchRuntimeOptions): JapaneseSearchRepository {
    try {
      accessSync(options.indexPath, constants.R_OK);
      accessSync(options.extensionPath, constants.R_OK);
      // A missing packaged Worker is deterministic and must fail construction, not retry. 
      accessSync(new URL("./worker.mjs", import.meta.url), constants.R_OK);
    } catch (cause) {
      throw new SearchUnavailableError("Japanese search files are unavailable.", { cause });
    }
    return new JapaneseSearchRepository(options);
  }

  /** Resolve when a ready Worker is available; this demand also drives bounded recovery. */
  ready(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new SearchCancelledError("Japanese search readiness wait was cancelled.", { cause: signal.reason }));
    if (this.closed) return Promise.reject(new SearchUnavailableError("Japanese search is unavailable.", { retryable: false }));
    const generation = this.workerHost.current;
    if (generation && this.workerHost.hasReachedReady(generation)) return Promise.resolve();
    if (this.state.lifecycle.kind === "dead") {
      const message = this.state.lifecycle.reason === "retry-exhausted"
        ? "Japanese search is unavailable after repeated worker failures; restart the server (restart limit reached)."
        : "Japanese search is unavailable after Worker startup failed.";
      return Promise.reject(new SearchUnavailableError(message, { retryable: false }));
    }

    return new Promise((resolve, reject) => {
      const waiter: ReadyWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.abortListener = () => {
          if (!this.readyWaiters.delete(waiter)) return;
          this.removeReadyWaiterListener(waiter);
          reject(new SearchCancelledError("Japanese search readiness wait was cancelled.", { cause: signal.reason }));
          this.cancelBackoffWhenUndemanded();
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.readyWaiters.add(waiter);
      this.ensureReadyDemand();
    });
  }

  private removeReadyWaiterListener(waiter: ReadyWaiter): void {
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.abortListener = undefined;
    }
  }

  private cancelBackoffWhenUndemanded(): void {
    if (this.hasDemand()) return;
    const lifecycle = this.state.lifecycle;
    if (lifecycle.kind !== "backoff") return;
    clearTimeout(lifecycle.timer);
    this.state.lifecycle = {
      kind: "idle",
      restartAttempts: lifecycle.restartAttempts,
      startupFailurePending: false,
    };
    // restartNotBefore intentionally remains unchanged.
  }

  private hasDemand(): boolean {
    return this.queue.length > 0 || this.readyWaiters.size > 0;
  }

  private ensureReadyDemand(): void {
    if (!this.hasDemand() || this.closed) return;
    const lifecycle = this.state.lifecycle;
    if (lifecycle.kind === "idle" && !this.workerHost.current) {
      this.scheduleWorkerRestart("ready() is waiting for a Worker", undefined, lifecycle.startupFailurePending);
    }
  }

  private resolveReadyWaiters(): void {
    for (const waiter of this.readyWaiters) {
      this.removeReadyWaiterListener(waiter);
      waiter.resolve();
    }
    this.readyWaiters.clear();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) {
      this.removeReadyWaiterListener(waiter);
      waiter.reject(error);
    }
    this.readyWaiters.clear();
  }

  search(request: JapaneseSearchRequest, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new SearchCancelledError("Japanese search was cancelled.", { cause: signal.reason }));
    if (this.closed) return Promise.reject(new SearchUnavailableError("Japanese search is unavailable because the repository is closed.", { retryable: false }));
    if (this.state.lifecycle.kind === "dead") {
      const message = this.state.lifecycle.reason === "retry-exhausted"
        ? "Japanese search is unavailable after repeated worker failures; restart the server (restart limit reached)."
        : "Japanese search is unavailable after Worker startup failed.";
      return Promise.reject(new SearchUnavailableError(message, { retryable: false }));
    }
    if (this.queue.length + (this.active ? 1 : 0) >= (this.options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS)) {
      return Promise.reject(new SearchBusyError());
    }

    return new Promise((resolve, reject) => {
      const entry: QueuedSearch = {
        id: this.nextId++, request, resolve, reject, signal, settled: false,
      };
      const queueWaitTimeoutMs = this.options.queueWaitTimeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS;
      entry.queueTimeout = setTimeout(() => this.onQueueWaitTimeout(entry, queueWaitTimeoutMs), queueWaitTimeoutMs);
      entry.queueTimeout.unref();
      if (signal) {
        entry.abortListener = () => this.cancel(entry);
        signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  close(): void {
    if (this.closed) return;
    const lifecycle = this.state.lifecycle;
    if (lifecycle.kind === "backoff") clearTimeout(lifecycle.timer);
    this.state.lifecycle = { kind: "closed" };
    const unavailable = new SearchUnavailableError("Japanese search is unavailable because the repository is closed.", { retryable: false });
    this.rejectReadyWaiters(unavailable);
    if (this.active) this.finishEntry(this.active, undefined, unavailable);
    for (const entry of this.queue.splice(0)) {
      this.finishEntry(entry, undefined, unavailable);
    }
    const generation = this.workerHost.current;
    this.active = undefined;
    if (generation) {
      void this.workerHost.terminate(generation, new SearchUnavailableError("Japanese search is unavailable because the repository is closed.", { retryable: false })).catch((error) => {
        this.options.log?.("[japanese-search] worker termination failed:", error);
      });
    }
  }

  private startWorker(): void {
    if (this.closed) return;
    const attempts = this.currentRestartAttempts();
    this.state.lifecycle = { kind: "starting", restartAttempts: attempts };
    try {
      this.workerHost.start();
      this.restartNotBefore = 0;
    } catch (error) {
      // Worker construction can fail synchronously (for example, transient thread limits).
      // The Worker script itself is preflighted in open(), so this enters bounded recovery.
      this.options.log?.("[japanese-search] worker spawn failed:", error);
      this.state.lifecycle = { kind: "idle", restartAttempts: attempts, startupFailurePending: true };
      if (this.hasDemand()) this.scheduleWorkerRestart("worker spawn failed", undefined, true);
    }
  }

  private pump(): void {
    const lifecycle = this.state.lifecycle;
    if (this.state.pumping || this.active || this.queue.length === 0) return;
    switch (lifecycle.kind) {
      case "dead": {
        const unavailable = new SearchUnavailableError(lifecycle.reason === "retry-exhausted"
          ? "Japanese search is unavailable after repeated worker failures; restart the server."
          : "Japanese search is unavailable.", { retryable: false });
        this.failQueued(unavailable);
        this.rejectReadyWaiters(unavailable);
        return;
      }
      case "closed":
      case "terminating":
      case "backoff":
        return;
      case "starting":
      case "ready":
      case "idle":
        break;
      default:
        assertNever(lifecycle);
    }
    if (!this.workerHost.current) {
      if (lifecycle.kind === "idle") {
        this.scheduleWorkerRestart("a queued request needs a worker", undefined, lifecycle.startupFailurePending);
      }
      return;
    }
    this.state.pumping = true;
    void this.dispatchNext().finally(() => {
      this.state.pumping = false;
      if (!this.active && !this.closed && this.queue.length > 0) this.pump();
    });
  }

  private currentRestartAttempts(): number {
    const lifecycle = this.state.lifecycle;
    return "restartAttempts" in lifecycle ? lifecycle.restartAttempts : 0;
  }

  private async dispatchNext(): Promise<void> {
    const generation = this.workerHost.current;
    if (!generation) return;
    try {
      await generation.ready;
    } catch (error) {
      // A failed generation has already been detached and its failure policy has run.
      if (!this.workerHost.isCurrent(generation)) return;
      this.failQueued(error instanceof Error ? error : new SearchWorkerError("Japanese search is unavailable.", { retryable: false }));
      return;
    }
    if (this.closed || this.active || this.queue.length === 0 || !this.workerHost.isCurrent(generation)) return;

    let entry: QueuedSearch | undefined;
    while ((entry = this.queue.shift())) {
      if (entry.signal?.aborted) {
        this.finishEntry(entry, undefined, new SearchCancelledError("Japanese search was cancelled.", { cause: entry.signal?.reason }));
        continue;
      }
      break;
    }
    if (!entry) return;

    if (entry.queueTimeout) clearTimeout(entry.queueTimeout);
    entry.queueTimeout = undefined;
    this.active = entry;
    try {
      this.workerHost.postMessage(generation, { type: "search", id: entry.id, ...entry.request });
    } catch (error) {
      this.active = undefined;
      this.finishEntry(entry, undefined, new SearchWorkerError("Japanese search is unavailable.", { cause: error }));
      this.workerHost.fail(generation, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onMessage(message: WorkerMessage, generation: WorkerGeneration<WorkerMetadata>): void {
    if (message.type === "ready") {
      if (this.workerHost.resolveReady(generation, message.metadata)) {
        // The retry budget protects against failures before ready. A healthy boot starts
        // a fresh budget, so slow queries cannot permanently exhaust worker recovery.
        this.state.lifecycle = { kind: "ready", restartAttempts: 0 };
        this.restartNotBefore = 0;
        this.resolveReadyWaiters();
        this.options.log?.("[japanese-search] worker ready", {
          initializationMs: Date.now() - generation.startedAt,
          indexedAt: message.metadata.indexed_at,
          indexedRecords: message.metadata.source_record_count,
        });
      }
      this.pump();
      return;
    }
    if (message.type === "startup-error") {
      this.workerHost.rejectReady(generation, new Error(message.message));
      this.options.log?.("[japanese-search] worker could not open the index:", message.message, {
        initializationMs: Date.now() - generation.startedAt,
      });
      this.state.lifecycle = { kind: "dead", reason: "startup" };
      const unavailable = new SearchUnavailableError("Japanese search is unavailable because the Worker could not open the index.", { retryable: false });
      this.rejectReadyWaiters(unavailable);
      void this.workerHost.terminate(generation).catch((error) => {
        this.options.log?.("[japanese-search] worker termination failed:", error);
      });
      if (this.active) {
        this.finishEntry(this.active, undefined, unavailable);
        this.active = undefined;
      }
      this.failQueued(unavailable);
      return;
    }
    if (message.type === "started") {
      const active = this.active;
      if (!active || active.id !== message.id || active.timeout) return;
      const executionTimeoutMs = this.options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
      active.timeout = setTimeout(() => this.onExecutionTimeout(active, generation, executionTimeoutMs), executionTimeoutMs);
      active.timeout.unref();
      return;
    }
    if (message.type !== "result") return;
    const active = this.active;
    if (!active || active.id !== message.id) return;
    this.active = undefined;
    if (message.ok) {
      this.finishEntry(active, message.value);
    } else {
      if (message.operatorMessage) this.options.log?.("[japanese-search] query failed:", message.operatorMessage);
      if (message.code === "no_searchable_tokens") {
        this.finishEntry(active, undefined, new SearchQueryValidationError("The tokenizer produced no searchable tokens for this query."));
      } else {
        this.finishEntry(active, undefined, new SearchWorkerError("Japanese search failed; check the server log and rebuild the index if needed."));
      }
    }
    this.pump();
  }

  private onExecutionTimeout(entry: QueuedSearch, generation: WorkerGeneration<WorkerMetadata>, timeoutMs: number): void {
    if (this.active !== entry || !this.workerHost.isCurrent(generation)) return;
    this.active = undefined;
    entry.timeout = undefined;
    this.options.log?.("[japanese-search] query exceeded its execution limit", { requestId: entry.id, timeoutMs });
    this.finishEntry(entry, undefined, new SearchWorkerError(`Japanese search exceeded the ${Math.max(1, Math.ceil(timeoutMs / 1000))}-second execution limit.`));
    this.restartWorker("search execution timeout", generation);
  }

  private onWorkerFailure(failure: WorkerHostFailure, generation: WorkerGeneration<WorkerMetadata>): void {
    const error = failure.type === "error"
      ? failure.error
      : failure.type === "exit"
        ? new Error(`Japanese search worker exited unexpectedly with code ${failure.code}`)
        : new Error(`Japanese search worker startup exceeded ${failure.timeoutMs} ms`);
    this.options.log?.("[japanese-search] worker failure:", error.message);

    // Startup timeouts, errors and unexpected exits all consume the same bounded
    // pre-ready restart budget. A deterministic startup-error message remains terminal.
    const countsTowardStartupRetryBudget = !this.workerHost.hasReachedReady(generation);
    if (this.active) {
      this.finishEntry(this.active, undefined, new SearchWorkerError("Japanese search worker failed; retry the request."));
      this.active = undefined;
    }
    this.restartWorker("worker failure", generation, countsTowardStartupRetryBudget, false);
  }

  private restartWorker(
    reason: string,
    workerToTerminate?: WorkerGeneration<WorkerMetadata>,
    countsTowardStartupRetryBudget = false,
    logTerminationFailure = true,
  ): void {
    if (this.closed) return;
    const lifecycle = this.state.lifecycle;
    if (lifecycle.kind === "dead" || lifecycle.kind === "closed") return;
    const oldWorker = workerToTerminate ?? this.workerHost.current;
    const restartAttempts = this.currentRestartAttempts();
    const startupFailurePending = lifecycle.kind === "idle" && lifecycle.startupFailurePending;

    if (!this.hasDemand()) {
      const pending = startupFailurePending || countsTowardStartupRetryBudget;
      if (oldWorker) {
        const termination = this.workerHost.terminate(oldWorker).catch((error) => {
          if (logTerminationFailure) this.options.log?.("[japanese-search] worker termination failed:", error);
          return 0;
        });
        const terminating: WorkerLifecycle = {
          kind: "terminating",
          restartAttempts,
          startupFailurePending: pending,
        };
        this.state.lifecycle = terminating;
        void termination.then(() => {
          if (this.state.lifecycle !== terminating) return;
          this.state.lifecycle = { kind: "idle", restartAttempts, startupFailurePending: pending };
          this.ensureReadyDemand();
          this.pump();
        });
      } else {
        this.state.lifecycle = { kind: "idle", restartAttempts, startupFailurePending: pending };
      }
      return;
    }
    this.scheduleWorkerRestart(reason, oldWorker, countsTowardStartupRetryBudget, logTerminationFailure);
  }

  /** Restart only while searches or ready() callers are waiting; only pre-ready failures consume the retry budget. */
  private scheduleWorkerRestart(
    reason: string,
    workerToTerminate?: WorkerGeneration<WorkerMetadata>,
    countsTowardStartupRetryBudget = false,
    logTerminationFailure = true,
  ): void {
    const current = this.state.lifecycle;
    if (this.closed || current.kind === "dead" || current.kind === "closed" ||
        !this.hasDemand() || current.kind === "terminating" || current.kind === "backoff") return;

    const maxAttempts = this.options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
    let restartAttempts = this.currentRestartAttempts();
    if (countsTowardStartupRetryBudget && restartAttempts >= maxAttempts) {
      // A WorkerHost failure already initiated termination; no replacement is started here.
      this.state.lifecycle = { kind: "dead", reason: "retry-exhausted" };
      this.options.log?.("[japanese-search] worker restart limit reached; failing queued searches", {
        attempts: restartAttempts,
        maxAttempts,
      });
      const unavailable = new SearchUnavailableError("Japanese search is unavailable after repeated worker failures; restart the server (restart limit reached).", { retryable: false });
      this.failQueued(unavailable);
      this.rejectReadyWaiters(unavailable);
      return;
    }

    if (countsTowardStartupRetryBudget) restartAttempts += 1;
    const baseDelayMs = this.options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
    const maxDelayMs = this.options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS;
    const retryExponent = Math.max(0, restartAttempts - 1);
    const calculatedDelayMs = Math.min(baseDelayMs * (2 ** retryExponent), maxDelayMs);
    const now = performance.now();
    const hasPendingDeadline = this.restartNotBefore > 0;
    const delayMs = hasPendingDeadline && !countsTowardStartupRetryBudget
      ? Math.max(0, this.restartNotBefore - now)
      : calculatedDelayMs;
    this.restartNotBefore = now + delayMs;
    this.options.log?.("[japanese-search] scheduling worker restart", {
      reason,
      attempt: restartAttempts,
      maxAttempts,
      delayMs,
      queuedRequests: this.queue.length,
    });

    // WorkerHost returns the same termination Promise for repeated calls on a generation.
    // The lifecycle state object, rather than a self-referential Promise chain, guards
    // against stale completion callbacks.
    const termination = workerToTerminate
      ? this.workerHost.terminate(workerToTerminate).catch((error) => {
        if (logTerminationFailure) this.options.log?.("[japanese-search] worker termination failed:", error);
        return 0;
      })
      : Promise.resolve(0);
    const terminating: WorkerLifecycle = {
      kind: "terminating",
      restartAttempts,
      startupFailurePending: false,
    };
    this.state.lifecycle = terminating;

    void termination.then(() => {
      if (this.state.lifecycle !== terminating) return;
      if (this.closed || !this.hasDemand()) {
        this.state.lifecycle = { kind: "idle", restartAttempts, startupFailurePending: false };
        this.pump();
        return;
      }

      const delayMs = Math.max(0, this.restartNotBefore - performance.now());
      const timer = setTimeout(() => {
        if (this.state.lifecycle !== backoff) return;
        this.state.lifecycle = { kind: "idle", restartAttempts, startupFailurePending: false };
        if (this.closed || !this.hasDemand()) {
          this.pump();
          return;
        }
        try {
          this.startWorker();
        } catch (error) {
          this.options.log?.("[japanese-search] worker spawn failed:", error);
          this.scheduleWorkerRestart("worker spawn failed", undefined, true);
        }
      }, delayMs);
      timer.unref();
      const backoff: WorkerLifecycle = { kind: "backoff", restartAttempts, timer };
      this.state.lifecycle = backoff;
    });
  }

  private onQueueWaitTimeout(entry: QueuedSearch, timeoutMs: number): void {
    const index = this.queue.indexOf(entry);
    if (index < 0 || entry.settled) return;
    this.queue.splice(index, 1);
    this.cancelBackoffWhenUndemanded();
    this.options.log?.("[japanese-search] queued search expired before dispatch", {
      requestId: entry.id,
      timeoutMs,
    });
    const limit = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.ceil(timeoutMs / 1000)} seconds`;
    this.finishEntry(entry, undefined, new SearchWorkerError(
      `Japanese search exceeded its ${limit} queue-wait limit; retry the request.`,
    ));
    this.pump();
  }

  private cancel(entry: QueuedSearch): void {
    if (entry.settled) return;
    if (this.active === entry) {
      // A synchronous SQLite query cannot process a cancel message until it returns.
      // Release the MCP caller now, but keep the execution timer and worker slot occupied.
      if (entry.abortListener && entry.signal) {
        entry.signal.removeEventListener("abort", entry.abortListener);
        entry.abortListener = undefined;
      }
      entry.settled = true;
      entry.reject(new SearchCancelledError("Japanese search was cancelled.", { cause: entry.signal?.reason }));
      return;
    }
    const index = this.queue.indexOf(entry);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.finishEntry(entry, undefined, new SearchCancelledError("Japanese search was cancelled.", { cause: entry.signal?.reason }));
      this.cancelBackoffWhenUndemanded();
      this.pump();
    }
  }

  private finishEntry(entry: QueuedSearch, value?: unknown, error?: Error): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = undefined;
    if (entry.queueTimeout) clearTimeout(entry.queueTimeout);
    entry.queueTimeout = undefined;
    if (entry.abortListener && entry.signal) {
      entry.signal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = undefined;
    }
    if (entry.settled) return;
    entry.settled = true;
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  private failQueued(error: Error): void {
    for (const entry of this.queue.splice(0)) this.finishEntry(entry, undefined, error);
  }

}
