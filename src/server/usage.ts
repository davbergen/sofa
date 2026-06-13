/**
 * The quota meter: records token usage reported by the Agent SDK (per Worker
 * run and per interactive Session) into the `token_usage` table, and answers
 * the aggregation queries the dashboard renders. Usage is best-effort
 * telemetry — recording never blocks or fails the work that produced it.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSession } from './agent.js';
import type { TokenUsage } from './ports.js';

/** Coerces an untrusted value (e.g. parsed Worker JSON) into a TokenUsage, or undefined. */
export function coerceUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const count = (x: unknown) =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
  return {
    inputTokens: count(v.inputTokens),
    outputTokens: count(v.outputTokens),
    cacheReadTokens: count(v.cacheReadTokens),
    cacheCreationTokens: count(v.cacheCreationTokens),
  };
}

const INSERT = `INSERT INTO token_usage
  (project_id, run_id, session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** Records the usage one Worker run reported. */
export function recordRunUsage(db: DatabaseSync, projectId: number, runId: number, usage: TokenUsage): void {
  db.prepare(INSERT).run(
    projectId, runId, null,
    usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens,
  );
}

/** Records the usage one interactive Session turn reported. */
export function recordSessionUsage(db: DatabaseSync, projectId: number, sessionId: number, usage: TokenUsage): void {
  db.prepare(INSERT).run(
    projectId, null, sessionId,
    usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens,
  );
}

/** A usage sum, with the grand total precomputed for display. */
export interface UsageTotals extends TokenUsage {
  totalTokens: number;
}

export interface ProjectUsage {
  /** Everything the Project has ever spent. */
  total: UsageTotals;
  /** Spend per calendar day (UTC), newest first. */
  byDay: Array<{ day: string } & UsageTotals>;
  /** Spend per Worker run, newest run first. */
  byRun: Array<{ runId: number } & UsageTotals>;
}

interface SumRow {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

function toTotals(row: SumRow): UsageTotals {
  const usage: TokenUsage = {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
  };
  return {
    ...usage,
    totalTokens:
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
  };
}

const SUMS = `COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens`;

/** Everything the dashboard needs: per-run usage plus aggregates over time. */
export function projectUsage(db: DatabaseSync, projectId: number): ProjectUsage {
  const total = db
    .prepare(`SELECT ${SUMS} FROM token_usage WHERE project_id = ?`)
    .get(projectId) as unknown as SumRow;
  const byDay = db
    .prepare(
      `SELECT date(recorded_at) AS day, ${SUMS} FROM token_usage
       WHERE project_id = ? GROUP BY day ORDER BY day DESC`,
    )
    .all(projectId) as unknown as Array<SumRow & { day: string }>;
  const byRun = db
    .prepare(
      `SELECT run_id, ${SUMS} FROM token_usage
       WHERE project_id = ? AND run_id IS NOT NULL GROUP BY run_id ORDER BY run_id DESC`,
    )
    .all(projectId) as unknown as Array<SumRow & { run_id: number }>;
  return {
    total: toTotals(total),
    byDay: byDay.map((row) => ({ day: row.day, ...toTotals(row) })),
    byRun: byRun.map((row) => ({ runId: row.run_id, ...toTotals(row) })),
  };
}

/**
 * Wraps an AgentSession so `usage` events are recorded as they stream by.
 * Recording failures are swallowed: the quota meter must never break a
 * Session. Sessions whose Agent emits no usage simply record nothing.
 */
export function withUsageRecording(
  session: AgentSession,
  record: (usage: TokenUsage) => void,
): AgentSession {
  return {
    answerQuestion: (questionId, answer) => session.answerQuestion(questionId, answer),
    decidePermission: (requestId, decision) => session.decidePermission(requestId, decision),
    sendMessage: (text) => session.sendMessage(text),
    close: () => session.close(),
    events: (async function* () {
      for await (const event of session.events) {
        if (event.type === 'usage') {
          try {
            record(event.usage);
          } catch {
            // Best-effort telemetry: never fail the Session over bookkeeping.
          }
        }
        yield event;
      }
    })(),
  };
}
