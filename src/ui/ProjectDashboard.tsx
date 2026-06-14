import { useCallback, useEffect, useState, type DragEvent } from 'react';

interface FieldNoteItem {
  id: number;
  text: string;
  acted: boolean;
  action: string | null;
  sessionId: number | null;
  issueNumber: number | null;
  issueUrl: string | null;
  recommendation: 'grill' | 'issue' | null;
  rationale: string | null;
}

interface FieldNotes {
  hasNote: boolean;
  items: FieldNoteItem[];
}

interface ReadyIssue {
  number: number;
  title: string;
  url: string;
}

interface OpenPrForIssue {
  issue: number;
  prNumber: number;
  prUrl: string;
}

type RunState =
  | 'cloning'
  | 'working'
  | 'pushing'
  | 'pr_open'
  | 'pr_merged'
  | 'pr_closed'
  | 'failed'
  | 'killed';

type WorkerPhase = 'cloning' | 'working' | 'pushing';

interface Run {
  id: number;
  issue: number;
  issueTitle: string;
  state: RunState;
  prUrl: string | null;
  failureReason: string | null;
  phase: WorkerPhase | null;
  startedAt: string;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

interface ProjectUsage {
  total: UsageTotals;
  byDay: Array<{ day: string } & UsageTotals>;
  byRun: Array<{ runId: number } & UsageTotals>;
}

const formatTokens = (n: number) => n.toLocaleString('en-US');

const ACTIVE: RunState[] = ['cloning', 'working', 'pushing'];

/**
 * Four-segment phase stepper for a Worker run: Clone → Work → Push → PR.
 * Driven by `state` plus the persisted furthest `phase`. The active segment
 * shimmers; on `failed`/`killed` the death segment paints red/grey over the
 * frozen done segments, so a run's expanded view shows where it died at a
 * glance. `pr_open`/`pr_merged`/`pr_closed` light all four; the PR segment
 * links out to `prUrl` when known.
 */
function WorkerPhaseStepper({ run }: { run: Run }) {
  const labels = ['Clone', 'Work', 'Push', 'PR'] as const;
  // Index of the in-progress / death segment along Clone→Work→Push.
  const phaseIdx: Record<WorkerPhase, number> = { cloning: 0, working: 1, pushing: 2 };

  const tones: Array<'done' | 'active' | 'red' | 'grey' | 'dim'> = ['dim', 'dim', 'dim', 'dim'];
  if (ACTIVE.includes(run.state)) {
    const idx = phaseIdx[run.state as WorkerPhase];
    for (let i = 0; i < idx; i++) tones[i] = 'done';
    tones[idx] = 'active';
  } else if (run.state === 'pr_open' || run.state === 'pr_merged' || run.state === 'pr_closed') {
    tones.fill('done');
  } else {
    // failed or killed: freeze done segments up to the death segment.
    const idx = run.phase ? phaseIdx[run.phase] : 0;
    for (let i = 0; i < idx; i++) tones[i] = 'done';
    tones[idx] = run.state === 'killed' ? 'grey' : 'red';
  }

  return (
    <div className="cz-step" role="group" aria-label="Worker phases">
      {labels.map((label, i) => {
        const tone = tones[i];
        const isPr = i === 3 && tone === 'done' && run.prUrl;
        if (isPr) {
          return (
            <a
              key={label}
              className={`cz-seg ${tone} link`}
              href={run.prUrl!}
              target="_blank"
              rel="noreferrer"
              aria-label={`${label} phase: open PR`}
            >
              <span className="bar" />
              <span>{label}</span>
            </a>
          );
        }
        return (
          <div key={label} className={`cz-seg ${tone}`} aria-label={`${label} phase: ${tone}`}>
            <span className="bar" />
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

interface ActivityEntry {
  message: string;
  at: string;
}

/** How many activity lines the panel keeps on screen. */
const MAX_FEED_LINES = 200;

/**
 * Live activity feed for one running Worker. The server replays the buffered
 * tail first, so opening this mid-run shows recent activity immediately.
 *
 * The default view is the single **current-activity headline** — the latest
 * activity line, derived purely from the same `activity` SSE that drove the
 * old firehose feed (no new event type, no new column; survives reconnect via
 * the existing buffered tail replay, per ADR 0007). The full feed is hidden
 * behind a "show detail" toggle so a running Worker reads as a one-line
 * status, not a wall of tool calls.
 */
function WorkerActivityFeed({ runId }: { runId: number }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    setEntries([]);
    const source = new EventSource(`/api/runs/${runId}/activity`);
    source.addEventListener('activity', (e) => {
      const entry = JSON.parse((e as MessageEvent).data) as ActivityEntry;
      setEntries((prev) => [...prev.slice(-(MAX_FEED_LINES - 1)), entry]);
    });
    source.addEventListener('done', () => source.close());
    source.onerror = () => source.close();
    return () => source.close();
  }, [runId]);

  const latest = entries.at(-1);

  return (
    <div className="cz-activity">
      <div className="cz-activity-head">
        <span className="cz-activity-headline mono" aria-live="polite" aria-label="Current Worker activity">
          {latest ? latest.message : 'Waiting for Worker activity…'}
        </span>
        <button
          type="button"
          className="cz-activity-toggle"
          aria-expanded={showDetail}
          onClick={() => setShowDetail((v) => !v)}
        >
          {showDetail ? 'hide detail' : 'show detail'}
        </button>
      </div>
      {showDetail && (
        <div role="log" aria-label="Worker activity" className="cz-feed mono">
          {entries.length === 0 ? (
            <div className="wait">Waiting for Worker activity…</div>
          ) : (
            entries.map((entry, i) => (
              <div key={i} className="line">
                {entry.message}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M18.5 5.5l-2 2M7.5 16.5l-2 2" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l5-5 4 4 8-8" />
      <path d="M21 8v4h-4" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}

/** The factory floor for one Project: ready Issues, Dispatch, run records, usage. */
export function ProjectDashboard({
  projectId,
  hostBusy = false,
  onStartSession,
  onViewSession,
}: {
  projectId: number;
  /** True when an interactive Session is live anywhere in Sofa — the host slot
   *  is global, so Process Notes must lock against any live host run, not just
   *  one in this Project. */
  hostBusy?: boolean;
  onStartSession?: (prompt: string, skill?: string) => Promise<number>;
  onViewSession?: (sessionId: number) => void;
}) {
  const [issues, setIssues] = useState<ReadyIssue[] | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [killError, setKillError] = useState<string | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [openPrByIssue, setOpenPrByIssue] = useState<Map<number, OpenPrForIssue>>(new Map());
  // Worker Runs compaction (issue #118): terminal Runs collapse to a one-liner
  // and only expand on click. Active Runs always render full and are not
  // tracked here. Expanding is cheap, ephemeral UI state — never persisted.
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set());
  const [notes, setNotes] = useState<FieldNotes | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // The Item currently in the "Create Issue" confirm/edit step, with its
  // editable title/body pre-filled from the Item. Null when no Item is being filed.
  const [filing, setFiling] = useState<{ id: number; title: string; body: string } | null>(null);
  // Inline manual-append draft: the text being typed for the next Field Note
  // Item. Empty by default; cleared after a successful append.
  const [appendDraft, setAppendDraft] = useState('');
  const [workerModel, setWorkerModel] = useState<string | null>(null);
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // Set-once compaction (#120): Project Settings collapses behind the gear so
  // the model selectors stop occupying fixed space after the initial pick.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Token Usage compaction (#120): the per-day breakdown is behind a toggle;
  // total + in/out bars stay always-visible above it.
  const [usageDaysOpen, setUsageDaysOpen] = useState(false);
  // Process Notes in-flight: blocks the button (alongside `hostBusy`) and drives
  // the in-progress label. Local because the run is one-shot and short-lived;
  // a server restart mid-run loses no durable state — verdicts only write on
  // success, so a dropped run leaves Items unchanged.
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/projects/${projectId}/settings`);
      if (res.ok) {
        const data = await res.json() as { workerModel: string | null; sessionModel: string | null };
        setWorkerModel(data.workerModel);
        setSessionModel(data.sessionModel);
      }
    })();
  }, [projectId]);

  async function saveWorkerModel(value: string | null) {
    setSettingsError(null);
    const res = await fetch(`/api/projects/${projectId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerModel: value }),
    });
    if (res.ok) {
      const data = await res.json() as { workerModel: string | null; sessionModel: string | null };
      setWorkerModel(data.workerModel);
      setSessionModel(data.sessionModel);
    } else {
      const body = await res.json().catch(() => null);
      setSettingsError((body as { error?: string } | null)?.error ?? `save failed (${res.status})`);
    }
  }

  async function saveSessionModel(value: string | null) {
    setSettingsError(null);
    const res = await fetch(`/api/projects/${projectId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionModel: value }),
    });
    if (res.ok) {
      const data = await res.json() as { workerModel: string | null; sessionModel: string | null };
      setWorkerModel(data.workerModel);
      setSessionModel(data.sessionModel);
    } else {
      const body = await res.json().catch(() => null);
      setSettingsError((body as { error?: string } | null)?.error ?? `save failed (${res.status})`);
    }
  }

  // Reconciliation: re-reads GitHub PR truth for `pr_open` runs of this
  // Project so the floor catches up when the automerge workflow lands a PR
  // (or it's closed unmerged). Fires on mount + the manual Refresh; never
  // folded into the 2s active-poll. Fail-soft: a `gh` failure surfaces as a
  // banner and never overwrites run state.
  const reconcile = useCallback(async () => {
    setReconcileError(null);
    const res = await fetch(`/api/projects/${projectId}/reconcile`, { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as { runs: Run[]; issuesWithOpenPr: OpenPrForIssue[] };
      setRuns(data.runs);
      setOpenPrByIssue(new Map(data.issuesWithOpenPr.map((p) => [p.issue, p])));
    } else {
      const body = await res.json().catch(() => null);
      setReconcileError(body?.error ?? `reconcile failed (${res.status})`);
    }
  }, [projectId]);

  const refreshRuns = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/runs`);
    if (res.ok) {
      setRuns(await res.json());
    }
    // The quota meter rides along with run refreshes so usage stays current.
    const usageRes = await fetch(`/api/projects/${projectId}/usage`);
    if (usageRes.ok) {
      setUsage(await usageRes.json());
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/projects/${projectId}/issues`);
      if (cancelled) return;
      if (res.ok) {
        setIssues(await res.json());
      } else {
        const body = await res.json().catch(() => null);
        setIssuesError(body?.error ?? `failed to list Issues (${res.status})`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load any persisted Field Notes for this Project (they survive restarts and
  // show up in a fresh browser).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/projects/${projectId}/field-notes`);
      if (cancelled || !res.ok) return;
      setNotes(await res.json());
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Drop a `.txt` note onto the dashboard: read its text in the browser, send it
  // to Sofa, and show the parsed Items (replacing any prior note).
  async function onDropNote(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    setNotesError(null);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const text = await file.text();
    const res = await fetch(`/api/projects/${projectId}/field-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      setNotes(await res.json());
    } else {
      const body = await res.json().catch(() => null);
      setNotesError(body?.error ?? `reading the note failed (${res.status})`);
    }
  }

  // Poll while any Worker is active so lifecycle states update live.
  const anyActive = runs.some((r) => ACTIVE.includes(r.state));
  useEffect(() => {
    void refreshRuns();
    if (!anyActive) return;
    const timer = setInterval(() => void refreshRuns(), 2000);
    return () => clearInterval(timer);
  }, [refreshRuns, anyActive]);

  // Reconcile once on mount so PRs landed/closed while the dashboard was away
  // are reflected the moment it loads.
  useEffect(() => {
    void reconcile();
  }, [reconcile]);

  const usageByRun = new Map((usage?.byRun ?? []).map((u) => [u.runId, u]));

  async function dispatchIssue(issue: ReadyIssue) {
    setDispatchError(null);
    const res = await fetch(`/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: issue.number, title: issue.title }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setDispatchError(body?.error ?? `dispatch failed (${res.status})`);
    }
    await refreshRuns();
  }

  async function killRun(runId: number) {
    setKillError(null);
    const res = await fetch(`/api/runs/${runId}/kill`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setKillError(body?.error ?? `kill failed (${res.status})`);
    }
    await refreshRuns();
  }

  async function removeRun(runId: number) {
    setKillError(null);
    const res = await fetch(`/api/runs/${runId}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setKillError(body?.error ?? `remove failed (${res.status})`);
    }
    await refreshRuns();
  }

  // Append a manually-typed Item to the current note. If no note exists yet the
  // server creates one (hasNote flips true). On success the input is cleared so
  // David can keep typing more without an extra click.
  async function appendItem() {
    const text = appendDraft.trim();
    if (!text) return;
    setNotesError(null);
    const res = await fetch(`/api/projects/${projectId}/field-notes/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      setNotes(await res.json());
      setAppendDraft('');
    } else {
      const body = await res.json().catch(() => null);
      setNotesError((body as { error?: string } | null)?.error ?? `append failed (${res.status})`);
    }
  }

  async function refreshNotes() {
    const res = await fetch(`/api/projects/${projectId}/field-notes`);
    if (res.ok) setNotes(await res.json());
  }

  // Trigger a one-shot Process Notes run for this Project. The server holds the
  // global host-run slot for the duration; UI also blocks the button via
  // `processing` + `hostBusy` so the user can't double-fire. Failure surfaces in
  // the Field Notes error banner and leaves Items untouched (server is the
  // authority — verdicts only write on success).
  async function processNotes() {
    setNotesError(null);
    setProcessing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/process-notes`, {
        method: 'POST',
      });
      if (res.ok) {
        setNotes(await res.json());
      } else {
        const body = await res.json().catch(() => null);
        setNotesError(
          (body as { error?: string } | null)?.error ?? `process notes failed (${res.status})`,
        );
      }
    } finally {
      setProcessing(false);
    }
  }

  async function removeItem(itemId: number) {
    setNotesError(null);
    const res = await fetch(`/api/projects/${projectId}/field-notes/items/${itemId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setNotesError((body as { error?: string } | null)?.error ?? `remove failed (${res.status})`);
    } else {
      setFiling((f) => (f?.id === itemId ? null : f));
      await refreshNotes();
    }
  }

  // Grill an unclear Item: escalate it into a grill-with-docs Grilling Session
  // and link the Item to the spawned Session.
  async function grillItem(item: FieldNoteItem) {
    if (!onStartSession) return;
    setNotesError(null);
    let sessionId: number;
    try {
      sessionId = await onStartSession(item.text, 'grill-with-docs');
    } catch {
      return;
    }
    await fetch(`/api/projects/${projectId}/field-notes/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'grill', sessionId }),
    });
    await refreshNotes();
  }

  // Confirm the "Create Issue" step: file the Item as a ready Issue and mark it
  // acted, in one atomic request. The Item then shows its terminal "Filed" state.
  async function fileIssue(itemId: number, title: string, issueBody: string) {
    setNotesError(null);
    const res = await fetch(`/api/projects/${projectId}/field-notes/items/${itemId}/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: issueBody }),
    });
    if (res.ok) {
      setFiling(null);
      await refreshNotes();
    } else {
      const body = await res.json().catch(() => null);
      setNotesError(body?.error ?? `filing the Issue failed (${res.status})`);
    }
  }

  const hasUnacted = !!notes?.items.some((i) => !i.acted);
  const processNotesLocked = hostBusy || processing;

  const total = usage?.total;
  const hasUsage = !!total && total.totalTokens > 0;
  // In/out bars are sized relative to the larger of the two, so the dominant
  // direction fills the bar and the other is drawn to scale beside it.
  const usageScale = total ? Math.max(total.inputTokens, total.outputTokens, 1) : 1;

  return (
    <div className="cz-grid">
      {/* Field Notes — the pre-pipeline entry ramp; full width across the grid. */}
      <section className="cz-cush cz-card" style={{ gridColumn: '1 / -1' }} aria-label="Field Notes">
        <div className="cz-card-h">
          <span className="ic sage">
            <NoteIcon />
          </span>
          <span className="ti">Field Notes</span>
          <span className="tag">drag a .txt</span>
          {hasUnacted && (
            <button
              type="button"
              className="cz-disp"
              style={{ marginLeft: 'auto' }}
              onClick={() => void processNotes()}
              disabled={processNotesLocked}
              title={
                hostBusy && !processing
                  ? 'A host run is active — one host run at a time.'
                  : undefined
              }
              aria-busy={processing}
            >
              {processing ? 'Processing…' : 'Process Notes'}
            </button>
          )}
        </div>
        {notesError && <p role="alert" className="cz-alert">{notesError}</p>}
        <div
          aria-label="Field Notes drop target"
          className={`cz-drop${dragging ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => void onDropNote(e)}
        >
          {/* Inline manual append: a single Item typed in directly, without a
              drag. Identical to a parsed Item once added — same actions, same
              persistence. Submitting on the empty state creates the note. */}
          <form
            className="cz-fn-append"
            aria-label="Append Field Note Item"
            onSubmit={(e) => {
              e.preventDefault();
              void appendItem();
            }}
          >
            <input
              className="cz-fn-append-input"
              aria-label="New Field Note Item text"
              placeholder="add an Item"
              value={appendDraft}
              onChange={(e) => setAppendDraft(e.target.value)}
            />
            <button
              type="submit"
              className="cz-disp"
              disabled={!appendDraft.trim()}
            >
              Add Item
            </button>
          </form>
          {!notes || !notes.hasNote ? (
            <div className="cz-empty">
              <div className="t">Drop a .txt note here</div>
              <div className="s">capture the changes you jotted while testing</div>
            </div>
          ) : notes.items.length === 0 ? (
            <div className="cz-empty">
              <div className="t">No items in that note</div>
              <div className="s">drop another .txt with numbered lines</div>
            </div>
          ) : (
            <div className="cz-fn">
              {notes.items.map((item) => {
                // Acted Items collapse to a single dense one-liner — the tag,
                // the Issue/Session link, the Item text (single-line, ellipsis
                // on overflow), and a Remove. The action row is gone since the
                // Item is terminal. Unacted Items keep their full layout.
                if (item.acted) {
                  return (
                    <div
                      className="cz-issue cz-fn-acted cz-fn-acted-line"
                      key={item.id}
                      aria-label="Acted Field Note Item"
                    >
                      <span className="cz-fn-tag">
                        {item.action === 'issue' ? 'Filed' : 'Grilled'}
                      </span>
                      {item.action === 'issue' && item.issueUrl && (
                        <a
                          className="cz-fn-sess"
                          href={item.issueUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Issue #{item.issueNumber}
                        </a>
                      )}
                      {item.action !== 'issue' && item.sessionId && onViewSession && (
                        <button
                          type="button"
                          className="cz-fn-sess"
                          onClick={() => onViewSession(item.sessionId!)}
                        >
                          Session #{item.sessionId}
                        </button>
                      )}
                      {item.action !== 'issue' && item.sessionId && !onViewSession && (
                        <span className="cz-fn-sess-label">Session #{item.sessionId}</span>
                      )}
                      <span className="cz-fn-acted-text" title={item.text}>
                        {item.text}
                      </span>
                      <button
                        type="button"
                        className="cz-disp"
                        onClick={() => void removeItem(item.id)}
                      >
                        Remove
                      </button>
                    </div>
                  );
                }
                return (
                <div className="cz-issue" key={item.id}>
                  <div className="txt" style={{ whiteSpace: 'pre-wrap' }}>
                    {item.text}
                  </div>
                  {item.recommendation && (
                    <span
                      className={`cz-fn-rec cz-fn-rec-${item.recommendation}`}
                      aria-label={`Recommendation: ${item.recommendation === 'grill' ? 'Grill suggested' : 'Cut suggested'}`}
                    >
                      {item.recommendation === 'grill' ? 'Grill suggested' : 'Cut suggested'}
                    </span>
                  )}
                  {filing?.id === item.id ? (
                    // Create Issue confirm/edit step: pre-filled from the Item,
                    // editable before filing. No LLM call — just a tweak-and-file.
                    <div className="cz-fn-issue">
                      <input
                        className="cz-fn-issue-title"
                        aria-label="Issue title"
                        value={filing.title}
                        onChange={(e) => setFiling({ ...filing, title: e.target.value })}
                      />
                      <textarea
                        className="cz-fn-issue-body"
                        aria-label="Issue body"
                        rows={4}
                        value={filing.body}
                        onChange={(e) => setFiling({ ...filing, body: e.target.value })}
                      />
                      <div className="cz-fn-acts">
                        <button
                          type="button"
                          className="cz-disp"
                          disabled={!filing.title.trim()}
                          onClick={() => void fileIssue(filing.id, filing.title, filing.body)}
                        >
                          File Issue
                        </button>
                        <button
                          type="button"
                          className="cz-disp"
                          onClick={() => setFiling(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="cz-disp"
                          onClick={() => void removeItem(item.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="cz-fn-acts">
                      {onStartSession && (
                        <button
                          type="button"
                          className="cz-disp"
                          onClick={() => void grillItem(item)}
                        >
                          Grill
                        </button>
                      )}
                      <button
                        type="button"
                        className="cz-disp"
                        onClick={() =>
                          setFiling({
                            id: item.id,
                            title: item.text.split('\n')[0],
                            body: item.text,
                          })
                        }
                      >
                        Create Issue
                      </button>
                      <button
                        type="button"
                        className="cz-disp"
                        onClick={() => void removeItem(item.id)}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Project Settings — set-once, so collapsed by default (#120). The
          card header doubles as the expander button so the closed state is
          just the title + gear with no fixed body. */}
      <section className="cz-cush cz-card" aria-label="Project Settings">
        <button
          type="button"
          className="cz-card-h cz-card-h-toggle"
          aria-expanded={settingsOpen}
          aria-controls={`project-settings-body-${projectId}`}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <span className="ic tan">
            <GearIcon />
          </span>
          <span className="ti">Project Settings</span>
          <span className="tag">{settingsOpen ? 'hide' : 'show'}</span>
        </button>
        {settingsOpen && (
          <div id={`project-settings-body-${projectId}`}>
            {settingsError && <p role="alert" className="cz-alert">{settingsError}</p>}
            <div className="cz-setting-row">
              <label className="cz-setting-label" htmlFor={`worker-model-${projectId}`}>Worker model</label>
              <select
                id={`worker-model-${projectId}`}
                className="cz-select"
                value={workerModel ?? ''}
                onChange={(e) => void saveWorkerModel(e.target.value || null)}
              >
                <option value="">Default</option>
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
                <option value="fable">fable</option>
              </select>
            </div>
            <div className="cz-setting-row">
              <label className="cz-setting-label" htmlFor={`session-model-${projectId}`}>Session model</label>
              <select
                id={`session-model-${projectId}`}
                className="cz-select"
                value={sessionModel ?? ''}
                onChange={(e) => void saveSessionModel(e.target.value || null)}
              >
                <option value="">Default</option>
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
                <option value="fable">fable</option>
              </select>
            </div>
          </div>
        )}
      </section>

      {/* Ready Issues — tall */}
      <section className="cz-cush cz-card tall" aria-label="Ready Issues">
        <div className="cz-card-h">
          <span className="ic tan">
            <ListIcon />
          </span>
          <span className="ti">Ready Issues</span>
          <span className="tag">cut &amp; ready</span>
        </div>
        {issuesError && <p role="alert" className="cz-alert">{issuesError}</p>}
        {issues === null && !issuesError && <p className="cz-muted">Loading Issues…</p>}
        {issues?.length === 0 && (
          <div className="cz-empty">
            <div className="t">No ready Issues</div>
            <div className="s">triage an issue to stock the line</div>
          </div>
        )}
        {issues && issues.length > 0 && (
          // Bounded-height scroll list (#120): the queue grows arbitrarily, so
          // the card has a max height and the rows scroll inside it. Issues
          // without an open PR (dispatchable) are pinned above those with one
          // so a working queue surfaces what the user can actually fire next.
          <div className="cz-issue-list">
            {[...issues]
              .sort((a, b) => {
                const aOpen = openPrByIssue.has(a.number) ? 1 : 0;
                const bOpen = openPrByIssue.has(b.number) ? 1 : 0;
                return aOpen - bOpen;
              })
              .map((issue) => {
              // An Issue with an open PR is still visible — Dispatch is greyed
              // out and replaced by a link to the live PR, so the Issue can't
              // be silently re-dispatched while review is in flight.
              const openPr = openPrByIssue.get(issue.number);
              return (
                <div className="cz-issue" key={issue.number}>
                  <div className="row">
                    <a className="id" href={issue.url} target="_blank" rel="noreferrer">
                      #{issue.number}
                    </a>
                  </div>
                  <div className="txt">{issue.title}</div>
                  <button
                    className="cz-disp"
                    onClick={() => void dispatchIssue(issue)}
                    disabled={anyActive || !!openPr}
                  >
                    Dispatch
                    <ArrowIcon />
                  </button>
                  {openPr && (
                    <a
                      className="cz-pr-link"
                      href={openPr.prUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      PR #{openPr.prNumber} open →
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {dispatchError && <p role="alert" className="cz-alert">{dispatchError}</p>}
      </section>

      {/* Worker Runs */}
      <section className="cz-cush cz-card" aria-label="Worker Runs">
        <div className="cz-card-h">
          <span className="ic sage">
            <GearIcon />
          </span>
          <span className="ti">Worker Runs</span>
          <span className="tag">{anyActive ? 'running' : 'idle'}</span>
          <button
            type="button"
            className="cz-disp"
            style={{ marginLeft: 'auto' }}
            onClick={() => void reconcile()}
          >
            Refresh
          </button>
        </div>
        {killError && <p role="alert" className="cz-alert">{killError}</p>}
        {reconcileError && <p role="alert" className="cz-alert">{reconcileError}</p>}
        {runs.length === 0 ? (
          <div className="cz-empty">
            <div className="eic">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 6v6l4 2" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </div>
            <div className="t">No workers dispatched yet</div>
            <div className="s">dispatch an issue to wake the line</div>
          </div>
        ) : (
          <div>
            {runs.map((run) => {
              const runUsage = usageByRun.get(run.id);
              const isActive = ACTIVE.includes(run.state);
              // Terminal Runs default collapsed: a single dense one-liner with
              // issue #, title, state dot, token count, and PR link. Clicking
              // the row toggles the frozen stepper + failure/kill reason. Kill
              // (active) / Remove (terminal) actions live on the row regardless
              // of collapsed/expanded so the user never has to expand to act.
              if (!isActive) {
                const expanded = expandedRuns.has(run.id);
                const dotTone =
                  run.state === 'pr_merged'
                    ? 'ok'
                    : run.state === 'failed'
                      ? 'err'
                      : run.state === 'killed'
                        ? 'killed'
                        : 'active';
                const stateLabel = run.state.replace('_', ' ');
                const toggle = () =>
                  setExpandedRuns((prev) => {
                    const next = new Set(prev);
                    if (next.has(run.id)) next.delete(run.id);
                    else next.add(run.id);
                    return next;
                  });
                return (
                  <div
                    className={`cz-run cz-run-compact${expanded ? ' open' : ''}`}
                    key={run.id}
                  >
                    <div className="cz-run-line">
                      <button
                        type="button"
                        className="cz-run-toggle"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} run for issue #${run.issue}`}
                        onClick={toggle}
                      >
                        <span className="id">#{run.issue}</span>
                        <span className="nm">{run.issueTitle}</span>
                        <span className={`cz-run-dot ${dotTone}`} aria-label={`state: ${stateLabel}`} />
                        <span className="cz-run-state mono">{stateLabel}</span>
                        {runUsage && (
                          <span className="cz-run-toks mono">
                            {formatTokens(runUsage.totalTokens)} tok
                          </span>
                        )}
                      </button>
                      {run.prUrl && (
                        <a
                          className="cz-run-pr"
                          href={run.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          PR →
                        </a>
                      )}
                      <button
                        className="cz-kill"
                        aria-label={`Remove run for issue #${run.issue}`}
                        onClick={() => void removeRun(run.id)}
                      >
                        Remove
                      </button>
                    </div>
                    {expanded && (
                      <div className="cz-run-detail">
                        <WorkerPhaseStepper run={run} />
                        <div className="meta">
                          <span className="mono">started {run.startedAt}</span>
                          {run.state === 'failed' && run.failureReason && (
                            <span className="reason err">{run.failureReason}</span>
                          )}
                          {run.state === 'killed' && run.failureReason && (
                            <span className="reason killed">{run.failureReason}</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <div className="cz-run" key={run.id}>
                  <div className="row">
                    <span className="id">#{run.issue}</span>
                    <span className="nm">{run.issueTitle}</span>
                    <button className="cz-kill" onClick={() => void killRun(run.id)}>
                      Kill
                    </button>
                  </div>
                  <WorkerPhaseStepper run={run} />
                  <div className="meta">
                    <span className="mono">started {run.startedAt}</span>
                    {runUsage && <span>{formatTokens(runUsage.totalTokens)} tokens</span>}
                  </div>
                  <WorkerActivityFeed runId={run.id} />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Token Usage */}
      <section className="cz-cush cz-card" aria-label="Token Usage">
        <div className="cz-card-h">
          <span className="ic rose">
            <ChartIcon />
          </span>
          <span className="ti">Token Usage</span>
          <span className="tag">all runs</span>
        </div>
        {!hasUsage ? (
          <div className="cz-empty">
            <div className="s mono">No usage recorded yet</div>
          </div>
        ) : (
          <>
            <div className="cz-usage">
              <div className="cz-num">
                {formatTokens(total!.totalTokens)}
                <span> tok</span>
              </div>
              <div className="cz-bars">
                <div className="cz-brow">
                  <span>in</span>
                  <span className="bar">
                    <i style={{ width: `${(total!.inputTokens / usageScale) * 100}%`, background: 'var(--tan)' }} />
                  </span>
                </div>
                <div className="cz-brow">
                  <span>out</span>
                  <span className="bar">
                    <i style={{ width: `${(total!.outputTokens / usageScale) * 100}%`, background: 'var(--rose)' }} />
                  </span>
                </div>
              </div>
            </div>
            {usage!.byDay.length > 0 && (
              <>
                <button
                  type="button"
                  className="cz-usage-toggle"
                  aria-expanded={usageDaysOpen}
                  aria-controls={`token-usage-days-${projectId}`}
                  onClick={() => setUsageDaysOpen((v) => !v)}
                >
                  {usageDaysOpen ? 'hide' : 'show'} per-day breakdown
                </button>
                {usageDaysOpen && (
                  <ul className="cz-days" id={`token-usage-days-${projectId}`}>
                    {usage!.byDay.map((day) => (
                      <li key={day.day}>
                        <span className="mono">{day.day}</span>
                        <span>
                          {formatTokens(day.totalTokens)} tok ({formatTokens(day.inputTokens)} in,{' '}
                          {formatTokens(day.outputTokens)} out)
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
