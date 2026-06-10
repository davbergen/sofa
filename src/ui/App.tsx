import { useEffect, useState, type FormEvent } from 'react';

interface Project {
  id: number;
  dir: string;
  name: string;
  openedAt: string;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch('/api/projects');
    setProjects(await res.json());
  }

  useEffect(() => {
    void refresh();
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
        <ul>
          {projects.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong> — <code>{p.dir}</code>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
