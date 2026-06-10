import { useEffect, useRef, useState, type FormEvent } from 'react';

interface Project {
  id: number;
  dir: string;
  name: string;
  openedAt: string;
}

interface TranscriptEntry {
  kind: 'assistant' | 'error';
  text: string;
}

type SessionStatus = 'streaming' | 'done' | 'error';

interface ActiveSession {
  id: number;
  projectName: string;
  prompt: string;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  async function refresh() {
    const res = await fetch('/api/projects');
    setProjects(await res.json());
  }

  useEffect(() => {
    void refresh();
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

  async function startSession(project: Project) {
    setError(null);
    const res = await fetch(`/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `failed to start Session (${res.status})`);
      return;
    }
    const started = await res.json();
    setSession({ id: started.id, projectName: project.name, prompt });
    setTranscript([]);
    setStatus('streaming');
    setPrompt('');

    sourceRef.current?.close();
    const source = new EventSource(`/api/sessions/${started.id}/events`);
    sourceRef.current = source;
    source.addEventListener('assistant_text', (e) => {
      const { text } = JSON.parse((e as MessageEvent).data);
      setTranscript((t) => [...t, { kind: 'assistant', text }]);
    });
    source.addEventListener('agent_error', (e) => {
      const { message } = JSON.parse((e as MessageEvent).data);
      setTranscript((t) => [...t, { kind: 'error', text: message }]);
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
          <ul>
            {projects.map((p) => (
              <li key={p.id} style={{ marginBottom: '0.25rem' }}>
                <strong>{p.name}</strong> — <code>{p.dir}</code>{' '}
                <button type="button" disabled={!prompt.trim()} onClick={() => void startSession(p)}>
                  Start Session
                </button>
              </li>
            ))}
          </ul>
        </>
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
            {transcript.length === 0 && status === 'streaming' ? (
              <p>Waiting for the Agent…</p>
            ) : (
              transcript.map((entry, i) => (
                <p key={i} style={entry.kind === 'error' ? { color: 'crimson' } : undefined}>
                  {entry.text}
                </p>
              ))
            )}
          </div>
        </section>
      )}
    </main>
  );
}
