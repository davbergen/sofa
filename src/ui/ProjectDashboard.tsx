import { useCallback, useEffect, useState } from 'react';

interface ReadyIssue {
  number: number;
  title: string;
  url: string;
}

type RunState = 'cloning' | 'working' | 'pushing' | 'pr_open' | 'failed';

interface Run {
  id: number;
  issue: number;
  issueTitle: string;
  state: RunState;
  prUrl: string | null;
  failureReason: string | null;
  startedAt: string;
}

const STATE_LABELS: Record<RunState, string> = {
  cloning: 'cloning',
  working: 'working',
  pushing: 'pushing',
  pr_open: 'PR open',
  failed: 'failed',
};

const ACTIVE: RunState[] = ['cloning', 'working', 'pushing'];

function stateColor(state: RunState): string {
  if (state === 'pr_open') return 'seagreen';
  if (state === 'failed') return 'crimson';
  return 'darkorange';
}

/** The factory floor for one Project: ready Issues, Dispatch, run records. */
export function ProjectDashboard({ projectId }: { projectId: number }) {
  const [issues, setIssues] = useState<ReadyIssue[] | null>(null);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/runs`);
    if (res.ok) {
      setRuns(await res.json());
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

  // Poll while any Worker is active so lifecycle states update live.
  const anyActive = runs.some((r) => ACTIVE.includes(r.state));
  useEffect(() => {
    void refreshRuns();
    if (!anyActive) return;
    const timer = setInterval(() => void refreshRuns(), 2000);
    return () => clearInterval(timer);
  }, [refreshRuns, anyActive]);

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

  return (
    <section style={{ margin: '0.5rem 0 1rem', paddingLeft: '1rem', borderLeft: '3px solid #ddd' }}>
      <h3 style={{ margin: '0.5rem 0' }}>Ready Issues</h3>
      {issuesError && <p role="alert" style={{ color: 'crimson' }}>{issuesError}</p>}
      {issues === null && !issuesError && <p>Loading Issues…</p>}
      {issues?.length === 0 && <p>No ready Issues.</p>}
      {issues && issues.length > 0 && (
        <ul style={{ paddingLeft: '1.25rem' }}>
          {issues.map((issue) => (
            <li key={issue.number} style={{ margin: '0.25rem 0' }}>
              <a href={issue.url} target="_blank" rel="noreferrer">
                #{issue.number}
              </a>{' '}
              {issue.title}{' '}
              <button onClick={() => void dispatchIssue(issue)} disabled={anyActive}>
                Dispatch
              </button>
            </li>
          ))}
        </ul>
      )}
      {dispatchError && <p role="alert" style={{ color: 'crimson' }}>{dispatchError}</p>}

      <h3 style={{ margin: '0.5rem 0' }}>Worker Runs</h3>
      {runs.length === 0 ? (
        <p>No Workers dispatched yet.</p>
      ) : (
        <ul style={{ paddingLeft: '1.25rem' }}>
          {runs.map((run) => (
            <li key={run.id} style={{ margin: '0.25rem 0' }}>
              Issue #{run.issue}
              {run.issueTitle ? ` — ${run.issueTitle}` : ''}{' '}
              <span style={{ color: stateColor(run.state), fontWeight: 600 }}>
                {STATE_LABELS[run.state]}
              </span>{' '}
              <small>started {run.startedAt}</small>
              {run.state === 'pr_open' && run.prUrl && (
                <>
                  {' — '}
                  <a href={run.prUrl} target="_blank" rel="noreferrer">
                    view PR
                  </a>
                </>
              )}
              {run.state === 'failed' && run.failureReason && (
                <span style={{ color: 'crimson' }}> — {run.failureReason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
