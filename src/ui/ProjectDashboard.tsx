import { useCallback, useEffect, useState, type DragEvent } from 'react';

interface FieldNoteItem {
  id: number;
  text: string;
  acted: boolean;
  action: string | null;
  sessionId: number | null;
  issueNumber: number | null;
  issueUrl: string | null;
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

type RunState =
  | 'cloning'
  | 'working'
  | 'pushing'
  | 'pr_open'
  | 'pr_merged'
  | 'pr_closed'
  | 'failed'
  | 'killed';

interface Run {
  id: number;
  issue: number;
  issueTitle: string;
  state: RunState;
  prUrl: string | null;
  failureReason: string | null;
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

const STATE_LABELS: Record<RunState, string> = {
  cloning: 'cloning',
  working: 'working',
  pushing: 'pushing',
  pr_open: 'PR open',
  pr_merged: 'PR merged',
  pr_closed: 'PR closed',
  failed: 'failed',
  killed: 'killed',
};

const ACTIVE: RunState[] = ['cloning', 'working', 'pushing'];

/** Maps a run's lifecycle state to a palette tone: sage=ok, rose=error, tan=active. */
function stateTone(state: RunState): string {
  if (state === 'pr_open' || state === 'pr_merged') return 'ok';
  if (state === 'failed' || state === 'pr_closed') return 'err';
  if (state === 'killed') return 'killed';
  return 'active';
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
 */
function WorkerActivityFeed({ runId }: { runId: number }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

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

  return (
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
  onStartSession,
  onViewSession,
}: {
  projectId: number;
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
  const [notes, setNotes] = useState<FieldNotes | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // The Item currently in the "Create Issue" confirm/edit step, with its
  // editable title/body pre-filled from the Item. Null when no Item is being filed.
  const [filing, setFiling] = useState<{ id: number; title: string; body: string } | null>(null);
  const [workerModel, setWorkerModel] = useState<string | null>(null);
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

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
      setRuns(await res.json());
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

  async function refreshNotes() {
    const res = await fetch(`/api/projects/${projectId}/field-notes`);
    if (res.ok) setNotes(await res.json());
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
              {notes.items.map((item) => (
                <div className={`cz-issue${item.acted ? ' cz-fn-acted' : ''}`} key={item.id}>
                  <div className="txt" style={{ whiteSpace: 'pre-wrap' }}>
                    {item.text}
                  </div>
                  {/* Acted is terminal: show what the Item became and hide its
                      actions, so it can't be Grilled or filed twice. */}
                  {item.acted && (
                    <div className="cz-fn-meta">
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
                    </div>
                  )}
                  {!item.acted && filing?.id === item.id ? (
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
                      </div>
                    </div>
                  ) : (
                    !item.acted && (
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
                      </div>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Project Settings */}
      <section className="cz-cush cz-card" aria-label="Project Settings">
        <div className="cz-card-h">
          <span className="ic tan">
            <GearIcon />
          </span>
          <span className="ti">Project Settings</span>
        </div>
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
          <div>
            {issues.map((issue) => (
              <div className="cz-issue" key={issue.number}>
                <div className="row">
                  <a className="id" href={issue.url} target="_blank" rel="noreferrer">
                    #{issue.number}
                  </a>
                </div>
                <div className="txt">{issue.title}</div>
                <button className="cz-disp" onClick={() => void dispatchIssue(issue)} disabled={anyActive}>
                  Dispatch
                  <ArrowIcon />
                </button>
              </div>
            ))}
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
              const tone = stateTone(run.state);
              const runUsage = usageByRun.get(run.id);
              return (
                <div className="cz-run" key={run.id}>
                  <div className="row">
                    <span className="id">#{run.issue}</span>
                    <span className="nm">{run.issueTitle}</span>
                    <span className={`state ${tone}`}>{STATE_LABELS[run.state]}</span>
                    {ACTIVE.includes(run.state) ? (
                      <button className="cz-kill" onClick={() => void killRun(run.id)}>
                        Kill
                      </button>
                    ) : (
                      <button
                        className="cz-kill"
                        aria-label={`Remove run for issue #${run.issue}`}
                        onClick={() => void removeRun(run.id)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="meta">
                    <span className="mono">started {run.startedAt}</span>
                    {(run.state === 'pr_open' || run.state === 'pr_merged' || run.state === 'pr_closed') && run.prUrl && (
                      <a href={run.prUrl} target="_blank" rel="noreferrer">
                        view PR
                      </a>
                    )}
                    {runUsage && <span>{formatTokens(runUsage.totalTokens)} tokens</span>}
                    {run.state === 'failed' && run.failureReason && (
                      <span className="reason err">{run.failureReason}</span>
                    )}
                    {run.state === 'killed' && run.failureReason && (
                      <span className="reason killed">{run.failureReason}</span>
                    )}
                  </div>
                  {ACTIVE.includes(run.state) && <WorkerActivityFeed runId={run.id} />}
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
            <ul className="cz-days">
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
          </>
        )}
      </section>
    </div>
  );
}
