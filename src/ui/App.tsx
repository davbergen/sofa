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
  kind: 'assistant' | 'error' | 'resolution' | 'doc';
  text: string;
}

type SessionStatus = 'streaming' | 'done' | 'error';

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
    <form
      aria-label={`Question: ${pending.question}`}
      onSubmit={submit}
      style={{ border: '1px solid #ccc', borderRadius: 6, padding: '1rem', margin: '0.5rem 0' }}
    >
      <p style={{ marginTop: 0 }}>
        <strong>{pending.question}</strong>
      </p>
      {pending.options.map((option) => (
        <label key={option.label} style={{ display: 'block', marginBottom: '0.25rem' }}>
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
      <label style={{ display: 'block', marginBottom: '0.5rem' }}>
        <input
          type="radio"
          name={`question-${pending.questionId}`}
          checked={choice === OTHER}
          onChange={() => setChoice(OTHER)}
        />{' '}
        Other:{' '}
        <input
          aria-label="Other answer"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onFocus={() => setChoice(OTHER)}
        />
      </label>
      <button type="submit" disabled={!answer}>
        Answer
      </button>
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
    <div
      role="group"
      aria-label={`Permission request: ${pending.toolName}`}
      style={{ border: '1px solid #e0a800', borderRadius: 6, padding: '1rem', margin: '0.5rem 0' }}
    >
      <p style={{ marginTop: 0 }}>
        <strong>The Agent wants to run {pending.toolName}.</strong>
      </p>
      {pending.description && <p>{pending.description}</p>}
      <pre style={{ background: '#f6f6f6', padding: '0.5rem', overflowX: 'auto' }}>
        {JSON.stringify(pending.input, null, 2)}
      </pre>
      <button type="button" onClick={() => onDecide('allow')}>
        Approve
      </button>{' '}
      <button type="button" onClick={() => onDecide('deny')}>
        Deny
      </button>
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skill, setSkill] = useState('');
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [pending, setPending] = useState<PendingInteraction[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [pastSessions, setPastSessions] = useState<PastSession[] | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

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

  async function startSession(project: Project) {
    setError(null);
    const res = await fetch(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...(skill ? { skill } : {}) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `failed to start Session (${res.status})`);
      return;
    }
    const started = await res.json();
    setSession({ id: started.id, projectName: project.name, prompt });
    setTranscript([]);
    setPending([]);
    setStatus('streaming');
    setPrompt('');
    attachStream(started.id);
  }

  /** Tails the live SSE event stream of a Session, appending to the transcript. */
  function attachStream(sessionId: number) {
    sourceRef.current?.close();
    const source = new EventSource(`/api/sessions/${sessionId}/events`);
    sourceRef.current = source;
    source.addEventListener('assistant_text', (e) => {
      const { text } = JSON.parse((e as MessageEvent).data);
      setTranscript((t) => [...t, { kind: 'assistant', text }]);
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
    setPrompt('');
    attachStream(past.id);
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '2rem auto' }}>
      <h1>Sofa</h1>
      <form onSubmit={openProject} style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          aria-label="Project directory"
          placeholder="C:\path\to\project"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          style={{ flex: 1, padding: '0.5rem' }}
        />
        <button type="submit" disabled={!dir.trim()}>
          Open Project
        </button>
      </form>
      {error && <p role="alert" style={{ color: 'crimson' }}>{error}</p>}
      <h2>Open Projects</h2>
      {projects.length === 0 ? (
        <p>No Projects open yet.</p>
      ) : (
        <>
          <input
            aria-label="Session prompt"
            placeholder="What should the Session do?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{ width: '100%', padding: '0.5rem', boxSizing: 'border-box' }}
          />
          {skills.length > 0 && (
            <label style={{ display: 'block', margin: '0.5rem 0' }}>
              Skill:{' '}
              <select
                aria-label="Session skill"
                value={skill}
                onChange={(e) => setSkill(e.target.value)}
              >
                <option value="">(no skill)</option>
                {skills.map((s) => (
                  <option key={s.name} value={s.name} title={s.description}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ul>
            {projects.map((p) => (
              <li key={p.id} style={{ marginBottom: '0.25rem' }}>
                <strong>{p.name}</strong> — <code>{p.dir}</code>{' '}
                <button type="button" disabled={!prompt.trim()} onClick={() => void startSession(p)}>
                  Start Session
                </button>{' '}
                <button type="button" onClick={() => void loadSessions(p)}>
                  Past Sessions
                </button>{' '}
                <button type="button" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                  {openId === p.id ? 'Hide dashboard' : 'Show dashboard'}
                </button>
                {openId === p.id && <ProjectDashboard projectId={p.id} />}
              </li>
            ))}
          </ul>
        </>
      )}
      {pastSessions && (
        <section aria-label="Past Sessions">
          <h2>Past Sessions</h2>
          {pastSessions.length === 0 ? (
            <p>No Sessions yet for this Project.</p>
          ) : (
            <ul>
              {pastSessions.map((s) => {
                const projectName = projects.find((p) => p.id === s.projectId)?.name ?? `Project ${s.projectId}`;
                return (
                  <li key={s.id} style={{ marginBottom: '0.25rem' }}>
                    Session #{s.id} — <em>{s.prompt}</em> <small>({s.status})</small>{' '}
                    <button type="button" onClick={() => void viewTranscript(s, projectName)}>
                      View transcript
                    </button>{' '}
                    {s.status === 'running' && s.agentSessionId && (
                      <button
                        type="button"
                        disabled={!prompt.trim()}
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
        <section aria-label="Session transcript">
          <h2>
            Session #{session.id} — {session.projectName}{' '}
            <small>({status === 'streaming' ? 'streaming…' : status})</small>
          </h2>
          <p>
            <em>{session.prompt}</em>
          </p>
          <div style={{ background: '#f6f6f6', padding: '1rem', borderRadius: 6 }}>
            {transcript.length === 0 && pending.length === 0 && status === 'streaming' ? (
              <p>Waiting for the Agent…</p>
            ) : (
              transcript.map((entry, i) => (
                <p
                  key={i}
                  style={
                    entry.kind === 'error'
                      ? { color: 'crimson' }
                      : entry.kind === 'resolution'
                        ? { color: '#666', fontStyle: 'italic' }
                        : entry.kind === 'doc'
                          ? {
                              color: '#0a6640',
                              background: '#e6f5ee',
                              borderLeft: '3px solid #0a6640',
                              padding: '0.25rem 0.5rem',
                              fontFamily: 'monospace',
                            }
                          : undefined
                  }
                >
                  {entry.text}
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
        </section>
      )}
    </main>
  );
}
