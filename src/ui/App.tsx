import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ProjectDashboard } from './ProjectDashboard';

interface Project {
  id: number;
  dir: string;
  name: string;
  openedAt: string;
}

interface Skill {
  name: string;
  description: string;
}

interface TranscriptEntry {
  kind: 'assistant' | 'user' | 'error' | 'resolution' | 'doc';
  text: string;
}

interface PrdDraft {
  title: string;
  markdown: string;
}

interface PrdPublication {
  issueNumber: number;
  url: string;
}

type SessionStatus = 'streaming' | 'awaiting' | 'done' | 'error';

interface ActiveSession {
  id: number;
  projectName: string;
  prompt: string;
}

interface PastSession {
  id: number;
  projectId: number;
  prompt: string;
  startedAt: string;
  status: 'running' | 'done' | 'error';
  agentSessionId: string | null;
}

interface TranscriptEvent {
  type: string;
  text?: string;
  message?: string;
}

function toEntry(event: TranscriptEvent): TranscriptEntry {
  return event.type === 'agent_error'
    ? { kind: 'error', text: event.message ?? '' }
    : { kind: 'assistant', text: event.text ?? '' };
}

interface QuestionOption {
  label: string;
  description?: string;
}

type PendingInteraction =
  | {
      kind: 'question';
      questionId: string;
      question: string;
      options: QuestionOption[];
      recommended?: string;
    }
  | {
      kind: 'permission';
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      description?: string;
    };

const OTHER = '__other__';

/** The Sofa sofa logo — used in the brand header and per-Project avatars. */
function SofaMark({ size = 32, stroke = '#2a1d0f' }: { size?: number; stroke?: string }) {
  return (
    <svg viewBox="0 0 32 24" width={size} height={size} fill="none" stroke={stroke} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round">
      <path d="M5 13c0-2 1-3 3-3h16c2 0 3 1 3 3v4H5z" />
      <path d="M7.5 10V7.5C7.5 6 8.5 5 10 5h12c1.5 0 2.5 1 2.5 2.5V10" />
      <path d="M5 17v3M27 17v3M11 13v1M16 13v1M21 13v1" />
    </svg>
  );
}

function QuestionForm({
  pending,
  onSubmit,
}: {
  pending: Extract<PendingInteraction, { kind: 'question' }>;
  onSubmit: (answer: string) => void;
}) {
  const [choice, setChoice] = useState(pending.recommended ?? pending.options[0]?.label ?? OTHER);
  const [other, setOther] = useState('');

  const answer = choice === OTHER ? other.trim() : choice;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (answer) onSubmit(answer);
  }

  return (
    <form aria-label={`Question: ${pending.question}`} onSubmit={submit} className="cz-cush cz-form">
      <p className="q">{pending.question}</p>
      {pending.options.map((option) => (
        <label key={option.label}>
          <input
            type="radio"
            name={`question-${pending.questionId}`}
            checked={choice === option.label}
            onChange={() => setChoice(option.label)}
          />{' '}
          {option.label}
          {option.label === pending.recommended && <em> (recommended)</em>}
          {option.description && <small> — {option.description}</small>}
        </label>
      ))}
      <label>
        <input
          type="radio"
          name={`question-${pending.questionId}`}
          checked={choice === OTHER}
          onChange={() => setChoice(OTHER)}
        />{' '}
        Other:{' '}
        <input
          aria-label="Other answer"
          className="cz-input"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onFocus={() => setChoice(OTHER)}
        />
      </label>
      <div className="cz-actions">
        <button type="submit" className="cz-btn tan" disabled={!answer}>
          Answer
        </button>
      </div>
    </form>
  );
}

function PermissionPrompt({
  pending,
  onDecide,
}: {
  pending: Extract<PendingInteraction, { kind: 'permission' }>;
  onDecide: (decision: 'allow' | 'deny') => void;
}) {
  return (
    <div role="group" aria-label={`Permission request: ${pending.toolName}`} className="cz-cush cz-perm">
      <p className="q">The Agent wants to run {pending.toolName}.</p>
      {pending.description && <p className="cz-muted">{pending.description}</p>}
      <pre>{JSON.stringify(pending.input, null, 2)}</pre>
      <div className="cz-actions">
        <button type="button" className="cz-btn tan" onClick={() => onDecide('allow')}>
          Approve
        </button>
        <button type="button" className="cz-btn" onClick={() => onDecide('deny')}>
          Deny
        </button>
      </div>
    </div>
  );
}

/**
 * The PRD document panel rendered beside the Session chat. The draft is
 * revised conversationally (no inline editing); the explicit Approve action
 * publishes it to the Project's GitHub issue tracker.
 */
function PrdPanel({
  draft,
  published,
  onRevise,
  onApprove,
}: {
  draft: PrdDraft;
  published: PrdPublication | null;
  onRevise: (text: string) => void;
  onApprove: () => void;
}) {
  const [revision, setRevision] = useState('');

  function submitRevision(e: FormEvent) {
    e.preventDefault();
    const text = revision.trim();
    if (!text) return;
    onRevise(text);
    setRevision('');
  }

  return (
    <aside aria-label={`PRD draft: ${draft.title}`} className="cz-cush cz-prd">
      <h3>{draft.title}</h3>
      <div className="doc">{draft.markdown}</div>
      {published ? (
        <p className="pub">
          Published as issue #{published.issueNumber}:{' '}
          <a href={published.url} target="_blank" rel="noreferrer">
            {published.url}
          </a>
        </p>
      ) : (
        <>
          <form onSubmit={submitRevision} className="cz-revise">
            <input
              aria-label="Revision request"
              className="cz-input"
              placeholder="Ask for a revision…"
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
            />
            <button type="submit" className="cz-btn" disabled={!revision.trim()}>
              Revise
            </button>
          </form>
          <div className="cz-actions">
            <button type="button" className="cz-btn tan" onClick={onApprove}>
              Approve and publish to GitHub
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * One open Project's self-contained block: a Grilling Session hero (the front
 * door — type a seed, kick off a `grill-with-docs` Session), the secondary
 * generic dispatch bar (prompt + skill + Start Session) for non-grill Sessions,
 * and the dashboard grid (expanded by default, collapsible). Per-Project state
 * keeps dispatch unambiguous when several Projects are open.
 */
function ProjectCard({
  project,
  skills,
  prompt,
  skill,
  dashboardOpen,
  onPromptChange,
  onSkillChange,
  onToggleDashboard,
  onStart,
  onLoadSessions,
  onStartSession,
  onViewSession,
}: {
  project: Project;
  skills: Skill[];
  prompt: string;
  skill: string;
  dashboardOpen: boolean;
  onPromptChange: (value: string) => void;
  onSkillChange: (value: string) => void;
  onToggleDashboard: () => void;
  onStart: () => void;
  onLoadSessions: () => void;
  onStartSession: (prompt: string, skill?: string) => Promise<number>;
  onViewSession: (sessionId: number) => void;
}) {
  const [heroSeed, setHeroSeed] = useState('');

  async function submitHero(e: FormEvent) {
    e.preventDefault();
    const seed = heroSeed.trim();
    if (!seed) return;
    try {
      await onStartSession(seed, 'grill-with-docs');
      setHeroSeed('');
    } catch {
      // startSessionWith surfaces the error in the page-level banner; keep the
      // seed in the field so the user can retry without retyping it.
    }
  }

  return (
    <div className="cz-project">
      <div className="cz-projhead">
        <div className="av">
          <SofaMark size={24} stroke="currentColor" />
        </div>
        <div>
          <div className="nm">{project.name}</div>
          <div className="pa mono">{project.dir}</div>
        </div>
        <div className="acts">
          <button type="button" className="cz-tab" onClick={onLoadSessions}>
            Past Sessions
          </button>
          <button type="button" className="cz-tab" onClick={onToggleDashboard}>
            {dashboardOpen ? 'Hide dashboard' : 'Show dashboard'}
          </button>
        </div>
      </div>

      <form className="cz-cush cz-hero" onSubmit={submitHero} aria-label="Start a Grilling Session">
        <label className="cz-hero-label" htmlFor={`hero-seed-${project.id}`}>
          What do you want to work on today?
        </label>
        <div className="cz-hero-row">
          <input
            id={`hero-seed-${project.id}`}
            aria-label="Grilling Session seed"
            className="cz-hero-input"
            placeholder="e.g. The UI needs fixing"
            value={heroSeed}
            onChange={(e) => setHeroSeed(e.target.value)}
          />
          <button type="submit" className="cz-btn tan" disabled={!heroSeed.trim()}>
            Start Grilling
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 3l14 9-14 9z" />
            </svg>
          </button>
        </div>
      </form>

      <div className="cz-cush cz-dispatch cz-dispatch-secondary">
        <input
          aria-label="Session prompt"
          className="cz-prompt"
          placeholder="What should the Session do?"
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
        />
        <label className="cz-skill">
          <span className="k">Skill</span>
          <select aria-label="Session skill" value={skill} onChange={(e) => onSkillChange(e.target.value)}>
            <option value="">(no skill)</option>
            {skills.map((s) => (
              <option key={s.name} value={s.name} title={s.description}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="cz-btn tan" disabled={!prompt.trim()} onClick={onStart}>
          Start Session
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 3l14 9-14 9z" />
          </svg>
        </button>
      </div>

      {dashboardOpen && (
        <ProjectDashboard
          projectId={project.id}
          onStartSession={onStartSession}
          onViewSession={onViewSession}
        />
      )}
    </div>
  );
}

interface FsEntry {
  name: string;
  path: string;
}

interface FsListing {
  current: string;
  parent: string | null;
  entries: FsEntry[];
}

/** The synthetic Windows drive-list pseudo-root (mirrors the server constant). */
const DRIVE_LIST_ROOT = ':drives:';

/** Clickable ancestor crumbs for a path, newest last. */
function crumbsOf(current: string): { label: string; path: string }[] {
  if (current === DRIVE_LIST_ROOT) return [{ label: 'Drives', path: DRIVE_LIST_ROOT }];
  const parts = current.split(/[\\/]+/).filter(Boolean);
  const crumbs: { label: string; path: string }[] = [];
  if (current.includes('\\')) {
    // Windows: first part is the drive (e.g. "C:"); offer the drive list above it.
    crumbs.push({ label: 'Drives', path: DRIVE_LIST_ROOT });
    let acc = '';
    parts.forEach((part, i) => {
      acc = i === 0 ? `${part}\\` : `${acc.replace(/\\$/, '')}\\${part}`;
      crumbs.push({ label: part, path: acc });
    });
  } else {
    crumbs.push({ label: '/', path: '/' });
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
  }
  return crumbs;
}

/**
 * The Browse picker: a breadcrumb + single-list directory browser served by the
 * host (one `fs/list` call per navigation step). "Select this folder" writes the
 * current absolute path back into the open-Project field; the actual open still
 * flows through the unchanged POST /api/projects.
 */
function DirectoryPicker({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function navigate(path?: string) {
    setError(null);
    const url = path === undefined ? '/api/fs/list' : `/api/fs/list?path=${encodeURIComponent(path)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `failed to list directory (${res.status})`);
      return;
    }
    setListing(await res.json());
  }

  useEffect(() => {
    void navigate();
  }, []);

  return (
    <div className="cz-picker-backdrop" role="dialog" aria-label="Browse for a Project directory" onClick={onClose}>
      <div className="cz-cush cz-picker" onClick={(e) => e.stopPropagation()}>
        <div className="cz-picker-bar">
          <button
            type="button"
            className="cz-tab"
            disabled={!listing || listing.parent === null}
            onClick={() => void navigate(listing?.parent ?? undefined)}
          >
            ↑ Up
          </button>
          <div className="cz-crumbs mono">
            {listing &&
              crumbsOf(listing.current).map((crumb, i, all) => (
                <span key={crumb.path}>
                  <button
                    type="button"
                    className="cz-crumb"
                    disabled={i === all.length - 1}
                    onClick={() => void navigate(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                  {i < all.length - 1 && <span className="sep"> › </span>}
                </span>
              ))}
          </div>
        </div>

        {error && (
          <p role="alert" className="cz-alert">
            {error}
          </p>
        )}

        <ul className="cz-picker-list">
          {listing?.entries.length === 0 ? (
            <li className="cz-muted empty">No subdirectories here.</li>
          ) : (
            listing?.entries.map((entry) => (
              <li key={entry.path}>
                <button type="button" className="cz-picker-row mono" onClick={() => void navigate(entry.path)}>
                  <span className="ic" aria-hidden="true">
                    🗀
                  </span>
                  {entry.name}
                </button>
              </li>
            ))
          )}
        </ul>

        <div className="cz-actions">
          <button type="button" className="cz-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cz-btn tan"
            disabled={!listing || listing.current === DRIVE_LIST_ROOT}
            onClick={() => {
              if (listing) {
                onSelect(listing.current);
                onClose();
              }
            }}
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [dir, setDir] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<number, string>>({});
  const [skillByProject, setSkillByProject] = useState<Record<number, string>>({});
  const [skills, setSkills] = useState<Skill[]>([]);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [pending, setPending] = useState<PendingInteraction[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [prdDraft, setPrdDraft] = useState<PrdDraft | null>(null);
  const [prdPublished, setPrdPublished] = useState<PrdPublication | null>(null);
  const [pastSessions, setPastSessions] = useState<PastSession[] | null>(null);
  const [composerText, setComposerText] = useState('');
  const sourceRef = useRef<EventSource | null>(null);
  const sessionSectionRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Dashboards are expanded by default; this tracks the ones the user collapsed.
  const [hiddenDashboards, setHiddenDashboards] = useState<Record<number, boolean>>({});

  const promptFor = (id: number) => prompts[id] ?? '';

  // The Session transcript renders below the Project cards, so activating a
  // Session (start, view, or resume) otherwise leaves the conversation below
  // the fold. Pull it into view and focus its message input when one exists.
  useEffect(() => {
    if (session === null) return;
    const section = sessionSectionRef.current;
    if (section === null) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const input = section.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type="radio"]):not([type="checkbox"]), textarea',
    );
    input?.focus();
  }, [session?.id]);

  useEffect(() => {
    if (status === 'awaiting') composerRef.current?.focus();
  }, [status]);

  async function refresh() {
    const res = await fetch('/api/projects');
    setProjects(await res.json());
  }

  useEffect(() => {
    void refresh();
    // Skills from the user's ~/.claude setup, loadable into a Session.
    void fetch('/api/skills')
      .then((res) => (res.ok ? res.json() : []))
      .then(setSkills)
      .catch(() => setSkills([]));
    return () => sourceRef.current?.close();
  }, []);

  async function openProject(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `failed to open project (${res.status})`);
      return;
    }
    setDir('');
    await refresh();
  }

  async function answerQuestion(sessionId: number, questionId: string, answer: string) {
    await fetch(`/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, answer }),
    });
    // The question_answer event coming back over SSE clears the pending form.
  }

  async function decidePermission(sessionId: number, requestId: string, decision: 'allow' | 'deny') {
    await fetch(`/api/sessions/${sessionId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, decision }),
    });
    // The permission_decision event coming back over SSE clears the prompt.
  }

  async function revisePrd(sessionId: number, text: string) {
    setError(null);
    const res = await fetch(`/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `sending the revision failed (${res.status})`);
    }
    // The updated prd_draft event coming back over SSE re-renders the panel.
  }

  async function sendSessionMessage(sessionId: number, text: string) {
    setError(null);
    const res = await fetch(`/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `sending message failed (${res.status})`);
    }
    // The user_message event coming back over SSE echoes it into the transcript.
  }

  async function endSession(sessionId: number) {
    setError(null);
    const res = await fetch(`/api/sessions/${sessionId}/end`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `ending Session failed (${res.status})`);
    }
  }

  async function approvePrd(sessionId: number) {
    setError(null);
    const res = await fetch(`/api/sessions/${sessionId}/prd/approve`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `publishing the PRD failed (${res.status})`);
    }
    // The prd_published event coming back over SSE marks the panel published.
  }

  async function startSessionWith(project: Project, prompt: string, skill?: string): Promise<number> {
    const res = await fetch(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...(skill ? { skill } : {}) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const msg = body?.error ?? `failed to start Session (${res.status})`;
      setError(msg);
      throw new Error(msg);
    }
    const started = await res.json();
    setSession({ id: started.id, projectName: project.name, prompt });
    setTranscript([]);
    setPending([]);
    setStatus('streaming');
    setPrdDraft(null);
    setPrdPublished(null);
    attachStream(started.id);
    return started.id as number;
  }

  async function startSession(project: Project) {
    setError(null);
    const prompt = promptFor(project.id);
    const skill = skillByProject[project.id] ?? '';
    await startSessionWith(project, prompt, skill || undefined);
    setPrompts((prev) => ({ ...prev, [project.id]: '' }));
  }

  async function viewSessionById(projectId: number, sessionId: number) {
    setError(null);
    const res = await fetch(`/api/sessions/${sessionId}/transcript`);
    if (!res.ok) {
      setError(`failed to load transcript (${res.status})`);
      return;
    }
    const { session: persisted, events } = (await res.json()) as {
      session: PastSession;
      events: TranscriptEvent[];
    };
    const projectName =
      projects.find((p) => p.id === projectId)?.name ?? `Project ${projectId}`;
    sourceRef.current?.close();
    setSession({ id: persisted.id, projectName, prompt: persisted.prompt });
    setTranscript(events.map(toEntry));
    setStatus(persisted.status === 'error' ? 'error' : 'done');
  }

  /** Tails the live SSE event stream of a Session, appending to the transcript. */
  function attachStream(sessionId: number) {
    sourceRef.current?.close();
    const source = new EventSource(`/api/sessions/${sessionId}/events`);
    sourceRef.current = source;
    source.addEventListener('assistant_text', (e) => {
      const { text } = JSON.parse((e as MessageEvent).data);
      setTranscript((t) => [...t, { kind: 'assistant', text }]);
      setStatus('streaming');
    });
    source.addEventListener('agent_error', (e) => {
      const { message } = JSON.parse((e as MessageEvent).data);
      setTranscript((t) => [...t, { kind: 'error', text: message }]);
    });
    // Doc writes (CONTEXT.md, docs/adr) surface as they happen.
    source.addEventListener('file_write', (e) => {
      const { path } = JSON.parse((e as MessageEvent).data);
      setTranscript((t) => [...t, { kind: 'doc', text: `Updated ${path}` }]);
    });
    source.addEventListener('question', (e) => {
      const event = JSON.parse((e as MessageEvent).data);
      setPending((p) => [...p, { kind: 'question', ...event }]);
    });
    source.addEventListener('question_answer', (e) => {
      const { questionId, answer } = JSON.parse((e as MessageEvent).data);
      setPending((p) => p.filter((i) => i.kind !== 'question' || i.questionId !== questionId));
      setTranscript((t) => [...t, { kind: 'resolution', text: `Answered: ${answer}` }]);
    });
    source.addEventListener('permission_request', (e) => {
      const event = JSON.parse((e as MessageEvent).data);
      setPending((p) => [...p, { kind: 'permission', ...event }]);
    });
    source.addEventListener('permission_decision', (e) => {
      const { requestId, decision } = JSON.parse((e as MessageEvent).data);
      setPending((p) => p.filter((i) => i.kind !== 'permission' || i.requestId !== requestId));
      setTranscript((t) => [
        ...t,
        { kind: 'resolution', text: decision === 'allow' ? 'Approved tool use.' : 'Denied tool use.' },
      ]);
    });
    source.addEventListener('turn_boundary', () => {
      setStatus('awaiting');
    });
    source.addEventListener('user_message', (e) => {
      const { text } = JSON.parse((e as MessageEvent).data);
      setTranscript((t) => [...t, { kind: 'user', text }]);
      setStatus('streaming');
    });
    source.addEventListener('prd_draft', (e) => {
      const { title, markdown } = JSON.parse((e as MessageEvent).data);
      setPrdDraft({ title, markdown });
    });
    source.addEventListener('prd_published', (e) => {
      const { issueNumber, url } = JSON.parse((e as MessageEvent).data);
      setPrdPublished({ issueNumber, url });
      setTranscript((t) => [...t, { kind: 'resolution', text: `PRD published as issue #${issueNumber}.` }]);
    });
    source.addEventListener('done', () => {
      setStatus('done');
      source.close();
    });
    source.onerror = () => {
      setStatus((s) => (s === 'done' ? s : 'error'));
      source.close();
    };
  }

  async function loadSessions(project: Project) {
    setError(null);
    const res = await fetch(`/api/projects/${project.id}/sessions`);
    if (!res.ok) {
      setError(`failed to list Sessions (${res.status})`);
      return;
    }
    setPastSessions(await res.json());
  }

  /** Shows the persisted transcript of a past Session. */
  async function viewTranscript(past: PastSession, projectName: string) {
    setError(null);
    const res = await fetch(`/api/sessions/${past.id}/transcript`);
    if (!res.ok) {
      setError(`failed to load transcript (${res.status})`);
      return;
    }
    const { events } = (await res.json()) as { events: TranscriptEvent[] };
    sourceRef.current?.close();
    setSession({ id: past.id, projectName, prompt: past.prompt });
    setTranscript(events.map(toEntry));
    setStatus(past.status === 'error' ? 'error' : 'done');
  }

  /** Resumes an interrupted Session (e.g. after a Sofa restart). */
  async function resumeSession(past: PastSession, projectName: string) {
    setError(null);
    const prompt = promptFor(past.projectId);
    const res = await fetch(`/api/sessions/${past.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `failed to resume Session (${res.status})`);
      return;
    }
    const transcriptRes = await fetch(`/api/sessions/${past.id}/transcript`);
    const { events } = (await transcriptRes.json()) as { events: TranscriptEvent[] };
    setSession({ id: past.id, projectName, prompt });
    setTranscript(events.map(toEntry));
    setStatus('streaming');
    setPrompts((prev) => ({ ...prev, [past.projectId]: '' }));
    attachStream(past.id);
  }

  return (
    <div className={`cz-app${prdDraft ? ' wide' : ''}`}>
      <header className="cz-top">
        <div className="cz-brand">
          <div className="cz-logo">
            <SofaMark size={32} />
          </div>
          <div>
            <h1 className="cz-word">Sofa</h1>
            <div className="cz-sub">your software factory — put your feet up while the workers run</div>
          </div>
        </div>
        <div className="cz-stamp">Workshop · v1</div>
      </header>

      <form onSubmit={openProject} className="cz-open">
        <input
          aria-label="Project directory"
          className="cz-field"
          placeholder="▸ C:\path\to\project"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        />
        <button type="button" className="cz-btn" onClick={() => setBrowsing(true)}>
          Browse…
        </button>
        <button type="submit" className="cz-btn tan" disabled={!dir.trim()}>
          Open Project
        </button>
      </form>
      {browsing && (
        <DirectoryPicker
          onSelect={(path) => setDir(path)}
          onClose={() => setBrowsing(false)}
        />
      )}
      {error && (
        <p role="alert" className="cz-alert">
          {error}
        </p>
      )}

      <div className="cz-h">
        <span className="t">Open Projects</span>
        <span className="d" />
        <span className="c mono">{projects.length} active</span>
      </div>
      {projects.length === 0 ? (
        <p className="cz-muted">No Projects open yet.</p>
      ) : (
        projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            skills={skills}
            prompt={promptFor(p.id)}
            skill={skillByProject[p.id] ?? ''}
            dashboardOpen={!hiddenDashboards[p.id]}
            onPromptChange={(value) => setPrompts((prev) => ({ ...prev, [p.id]: value }))}
            onSkillChange={(value) => setSkillByProject((prev) => ({ ...prev, [p.id]: value }))}
            onToggleDashboard={() => setHiddenDashboards((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
            onStart={() => void startSession(p)}
            onLoadSessions={() => void loadSessions(p)}
            onStartSession={(prompt, skill) => startSessionWith(p, prompt, skill)}
            onViewSession={(sessionId) => void viewSessionById(p.id, sessionId)}
          />
        ))
      )}

      {pastSessions && (
        <section aria-label="Past Sessions" className="cz-section">
          <h2>Past Sessions</h2>
          {pastSessions.length === 0 ? (
            <p className="cz-muted">No Sessions yet for this Project.</p>
          ) : (
            <ul className="cz-sessions">
              {pastSessions.map((s) => {
                const projectName = projects.find((p) => p.id === s.projectId)?.name ?? `Project ${s.projectId}`;
                return (
                  <li key={s.id}>
                    <span className="pr">
                      Session #{s.id} — <em>{s.prompt}</em> <span className="st">{s.status}</span>
                    </span>
                    <button type="button" className="cz-tab" onClick={() => void viewTranscript(s, projectName)}>
                      View transcript
                    </button>
                    {s.status === 'running' && s.agentSessionId && (
                      <button
                        type="button"
                        className="cz-tab"
                        disabled={!promptFor(s.projectId).trim()}
                        onClick={() => void resumeSession(s, projectName)}
                      >
                        Resume
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {session && (
        <section ref={sessionSectionRef} aria-label="Session transcript" className="cz-section">
          <h2>
            Session #{session.id} — {session.projectName}{' '}
            <span className="cz-muted">({status === 'streaming' ? 'thinking…' : status === 'awaiting' ? 'awaiting…' : status})</span>
          </h2>
          <p className="lede">{session.prompt}</p>
          {(status === 'streaming' || status === 'awaiting') && (
            <button
              type="button"
              className="cz-btn"
              onClick={() => void endSession(session.id)}
            >
              End session
            </button>
          )}
          <div className="cz-split">
            <div className="main">
              <div className="cz-cush cz-transcript">
                {transcript.length === 0 && pending.length === 0 && status === 'streaming' ? (
                  <p className="wait">Waiting for the Agent…</p>
                ) : (
                  transcript.map((entry, i) => (
                    <p key={i} className={entry.kind}>
                      {entry.kind === 'user' ? `You: ${entry.text}` : entry.text}
                    </p>
                  ))
                )}
              </div>
              {pending.map((interaction) =>
                interaction.kind === 'question' ? (
                  <QuestionForm
                    key={interaction.questionId}
                    pending={interaction}
                    onSubmit={(answer) => void answerQuestion(session.id, interaction.questionId, answer)}
                  />
                ) : (
                  <PermissionPrompt
                    key={interaction.requestId}
                    pending={interaction}
                    onDecide={(decision) => void decidePermission(session.id, interaction.requestId, decision)}
                  />
                ),
              )}
              {status === 'streaming' && pending.length === 0 && (
                <p className="cz-thinking">thinking…</p>
              )}
              {status === 'awaiting' && pending.length === 0 && (
                <form
                  className="cz-composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = composerText.trim();
                    if (!text) return;
                    setStatus('streaming');
                    void sendSessionMessage(session.id, text);
                    setComposerText('');
                  }}
                >
                  <textarea
                    ref={composerRef}
                    aria-label="Message"
                    className="cz-field"
                    rows={2}
                    placeholder="Reply to the agent…"
                    value={composerText}
                    onChange={(e) => setComposerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const text = composerText.trim();
                        if (!text) return;
                        setStatus('streaming');
                        void sendSessionMessage(session.id, text);
                        setComposerText('');
                      }
                    }}
                  />
                  <button type="submit" className="cz-btn tan" disabled={!composerText.trim()}>
                    Send
                  </button>
                </form>
              )}
            </div>
            {prdDraft && (
              <PrdPanel
                draft={prdDraft}
                published={prdPublished}
                onRevise={(text) => void revisePrd(session.id, text)}
                onApprove={() => void approvePrd(session.id)}
              />
            )}
          </div>
        </section>
      )}
    </div>
  );
}
