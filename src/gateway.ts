// One place that decides which model runs which task, logs every call, falls back to a second
// provider on failure, and stops spending once a daily limit is reached.

export type Provider = {
  name: string;
  model: string;
  run: (input: Record<string, unknown>) => Promise<{ output: Record<string, unknown>; costUsd: number }>;
  /** Extra attempts on a transient error (429, 5xx, or an error with no HTTP status) before falling back. Default 0. */
  retries?: number;
  /** Wait before the first retry, doubled on each further retry. Default 0. */
  backoffMs?: number;
};

/** Errors with a numeric `status` are retried only for 429 and 5xx; errors without one (e.g. network) are retried. */
function isTransient(e: unknown) {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Job = {
  id: string; task: string; userId: string; projectId?: string; provider: string; model: string;
  status: 'running' | 'done' | 'failed'; input: Record<string, unknown>; output?: Record<string, unknown>;
  error?: string; costUsd: number; durationMs?: number; createdAt: Date;
};

/** Where jobs are stored. Implement it for your database; MemoryJobStore is the default. */
export interface JobStore {
  create(job: Job): Promise<void>;
  update(id: string, patch: Partial<Job>): Promise<void>;
  spendSince(since: Date): Promise<number>;
}

export class MemoryJobStore implements JobStore {
  jobs: Job[] = [];
  async create(job: Job) { this.jobs.push(job); }
  async update(id: string, patch: Partial<Job>) { Object.assign(this.jobs.find((j) => j.id === id) ?? {}, patch); }
  async spendSince(since: Date) { return this.jobs.filter((j) => j.createdAt >= since).reduce((s, j) => s + (j.costUsd || 0), 0); }
}

export class DailyLimitError extends Error {}

export class Gateway {
  private routes = new Map<string, Provider[]>();
  private store: JobStore;
  private dailyLimitUsd: number;

  constructor(opts: { store?: JobStore; dailyLimitUsd?: number } = {}) {
    this.store = opts.store ?? new MemoryJobStore();
    this.dailyLimitUsd = opts.dailyLimitUsd ?? 50;
  }

  /** Model choice is configuration, not code: register a primary and optional fallback per task. */
  register(task: string, primary: Provider, fallback?: Provider) {
    this.routes.set(task, fallback ? [primary, fallback] : [primary]);
  }

  async todaySpendUsd(now = new Date()) {
    const since = new Date(now); since.setUTCHours(0, 0, 0, 0);
    return this.store.spendSince(since);
  }

  async run(task: string, input: Record<string, unknown>, who: { userId: string; projectId?: string }) {
    const spent = await this.todaySpendUsd();
    if (spent >= this.dailyLimitUsd) throw new DailyLimitError(`Daily AI limit ($${this.dailyLimitUsd}) reached`);
    const chain = this.routes.get(task) ?? [];
    if (!chain.length) throw new Error(`No model configured for ${task}`);
    let lastErr = '';
    for (const p of chain) {
      const retries = Math.max(0, Math.floor(p.retries ?? 0));
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep((p.backoffMs ?? 0) * 2 ** (attempt - 1));
        const id = crypto.randomUUID();
        const started = Date.now();
        await this.store.create({ id, task, ...who, provider: p.name, model: p.model, status: 'running', input, costUsd: 0, createdAt: new Date() });
        try {
          const { output, costUsd } = await p.run(input);
          await this.store.update(id, { status: 'done', output, costUsd, durationMs: Date.now() - started });
          return { jobId: id, provider: p.name, output, costUsd };
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
          await this.store.update(id, { status: 'failed', error: lastErr, durationMs: Date.now() - started });
          if (!isTransient(e)) break;
        }
      }
    }
    throw new Error(`All models failed: ${lastErr}`);
  }
}
