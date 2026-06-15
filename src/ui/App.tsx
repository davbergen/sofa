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

interface FileIssueDraft {
  title: string;
  body: string;
}

interface FileIssueFiling {
  number: number;
  url: string;
}

type SessionStatus = 'streaming' | 'awaiting' | 'done' | 'error';

interface ActiveSession {
  id: number;
  projectId: number;
  projectName: string;
  prompt: string;
  /** The skill the Session was launched with (drives the BOOT line + meta). */
  skill?: string;
  /** The Project's configured Session model, if any (BOOT line metadata). */
  model?: string;
  /** Absolute working directory (the launching Project's dir) — BOOT cwd. */
  dir?: string;
  /** ISO timestamp the Session started — drives the live elapsed timer. */
  startedAt?: string;
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
  terminal = false,
}: {
  pending: Extract<PendingInteraction, { kind: 'question' }>;
  onSubmit: (answer: string) => void;
  /** Render as the Session Terminal's highlighted ASK block instead of a panel. */
  terminal?: boolean;
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
      className={terminal ? 'cz-term-ask' : 'cz-cush cz-form'}
    >
      {terminal && <span className="ask-mark" aria-hidden="true">ASK</span>}
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
 * Inline draft card for a Sofa-applied `ready-for-agent` Issue (ADR-0011).
 * Mirrors the PRD draft card: shows the agent's proposed title + body, lets
 * David optionally edit them, and files via `POST /api/sessions/:id/file-issue`
 * which is the only place the label gets attached. Filed state collapses the
 * card to a linked chip.
 */
function FileIssuePanel({
  draft,
  filed,
  error,
  onFile,
  onDiscard,
}: {
  draft: FileIssueDraft;
  filed: FileIssueFiling | null;
  error: string | null;
  onFile: (title: string, body: string) => void;
  onDiscard: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);

  // If the draft is replaced (e.g. agent re-emits), refresh the edit buffers.
  useEffect(() => {
    setTitle(draft.title);
    setBody(draft.body);
    setEditing(false);
  }, [draft.title, draft.body]);

  if (filed) {
    return (
      <aside aria-label={`Filed issue #${filed.number}`} className="cz-cush cz-issue">
        <h3>Issue filed</h3>
        <p className="pub">
          Filed as issue #{filed.number}:{' '}
          <a href={filed.url} target="_blank" rel="noreferrer">
            {filed.url}
          </a>
        </p>
      </aside>
    );
  }

  return (
    <aside aria-label={`Issue draft: ${draft.title}`} className="cz-cush cz-issue">
      {editing ? (
        <>
          <input
            aria-label="Issue title"
            className="cz-input cz-issue-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            aria-label="Issue body"
            className="cz-input cz-issue-body"
            value={body}
            rows={14}
            onChange={(e) => setBody(e.target.value)}
          />
        </>
      ) : (
        <>
          <h3>{title}</h3>
          <div className="doc">{body}</div>
        </>
      )}
      {error && <p className="cz-issue-err" role="alert">{error}</p>}
      <div className="cz-actions">
        {editing ? (
          <button type="button" className="cz-btn" onClick={() => setEditing(false)}>
            Done editing
          </button>
        ) : (
          <button type="button" className="cz-btn" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        <button type="button" className="cz-btn" onClick={onDiscard}>
          Discard
        </button>
        <button
          type="button"
          className="cz-btn tan"
          disabled={!title.trim()}
          onClick={() => onFile(title.trim(), body)}
        >
          File Issue
        </button>
      </div>
    </aside>
  );
}

/** A terminal log line: a coloured tag + text, or a dim system note. */
type TermTag = 'BOOT' | 'NOTE' | 'EDIT' | 'YOU' | 'DONE' | 'ERR';
interface TermLine {
  tag?: TermTag;
  text: string;
  /** Dim italic system line (resolutions: "Answered: …", "PRD published …"). */
  sys?: boolean;
}

const TAG_CLASS: Record<TermTag, string> = {
  BOOT: 't-boot',
  NOTE: 't-note',
  EDIT: 't-edit',
  YOU: 't-you',
  DONE: 't-done',
  ERR: 't-err',
};

/**
 * Map a transcript entry to a tagged terminal line. The interactive-Session SSE
 * stream is unchanged (ADR 0008 Phase 1): `assistant_text` reads as NOTE, the
 * `file_write` doc line as EDIT, `user_message` as YOU, and the synthetic
 * resolutions ("Answered …") as dim system lines.
 */
function toTermLine(entry: TranscriptEntry): TermLine {
  switch (entry.kind) {
    case 'user':
      return { tag: 'YOU', text: entry.text };
    case 'error':
      return { tag: 'ERR', text: entry.text };
    case 'doc':
      return { tag: 'EDIT', text: entry.text };
    case 'resolution':
      return { sys: true, text: entry.text };
    default:
      return { tag: 'NOTE', text: entry.text };
  }
}

function TermLineRow({ line }: { line: TermLine }) {
  if (line.sys) {
    return (
      <div className="cz-term-line sys">
        <span className="tag" />
        <span className="tx">{line.text}</span>
      </div>
    );
  }
  return (
    <div className={`cz-term-line ${line.tag ? TAG_CLASS[line.tag] : ''}`}>
      <span className="tag">{line.tag}</span>
      <span className="tx">{line.text}</span>
    </div>
  );
}

function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const mm = mins.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * The vim-style statusline (ADR 0008): mode badge, skill, model badge, and a
 * live elapsed timer ticked from `startedAt`. The token-meter and `⎇ branch`
 * cells from the visual handoff are deferred and rendered as absent (no
 * placeholders) because live per-Session token usage is not streamed today and
 * the working-copy branch is not surfaced.
 */
function SessionStatusline({
  session,
  status,
}: {
  session: ActiveSession;
  status: SessionStatus | null;
}) {
  const mode = session.skill === 'grill-with-docs' ? 'Grill' : 'Session';
  const frozen = status === 'done' || status === 'error';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozen) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [frozen]);

  const startedMs = session.startedAt ? new Date(session.startedAt).getTime() : now;
  const elapsed = formatElapsed(Math.floor((now - startedMs) / 1000));

  return (
    <div className="cz-term-statusline" role="status" aria-label="Session statusline">
      <span className={`stl-mode mode-${mode.toLowerCase()}`}>{mode}</span>
      {session.skill && <span className="stl-cell stl-skill">{session.skill}</span>}
      {session.model && <span className="stl-cell stl-model">{session.model}</span>}
      <span className="stl-spacer" />
      <span className="stl-cell stl-elapsed mono" aria-label="Elapsed time">
        {elapsed}
      </span>
    </div>
  );
}

interface LiveSession {
  session: ActiveSession;
  transcript: TranscriptEntry[];
  pending: PendingInteraction[];
  status: SessionStatus | null;
  prdDraft: PrdDraft | null;
  prdPublished: PrdPublication | null;
  fileIssueDraft: FileIssueDraft | null;
  fileIssueFiled: FileIssueFiling | null;
  fileIssueError: string | null;
  onAnswer: (questionId: string, answer: string) => void;
  onDecide: (requestId: string, decision: 'allow' | 'deny') => void;
  onSend: (text: string) => void;
  onEnd: () => void;
  onRevise: (text: string) => void;
  onApprove: () => void;
  onFileIssue: (title: string, body: string) => void;
  onDiscardFileIssue: () => void;
}

/**
 * The Session Terminal (ADR 0008): the inline surface that renders any live
 * interactive Session as a real terminal — title bar, a streaming body of
 * tagged log lines (with the structured `ASK` block for grilling questions),
 * and a free-text reply row. Lines are driven entirely by the existing SSE
 * stream; a synthetic BOOT line opens the transcript with the Session identity.
 */
function SessionTerminal({ live }: { live: LiveSession }) {
  const { session, transcript, pending, status } = live;
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const streaming = status === 'streaming';

  // Auto-scroll the body to the latest line as the stream advances.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript.length, pending.length, status]);

  // When the Session yields the turn, focus the reply row so a follow-up can be
  // typed straight away.
  useEffect(() => {
    if (status === 'awaiting') inputRef.current?.focus();
  }, [status]);

  const statusText =
    status === 'awaiting'
      ? 'awaiting your reply'
      : status === 'done'
        ? 'done'
        : status === 'error'
          ? 'error'
          : 'thinking…';

  const bootMeta = [
    `session #${session.id}`,
    session.skill ? `skill ${session.skill}` : 'no skill',
    session.model ? `model ${session.model}` : null,
    session.dir ? `cwd ${session.dir}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    live.onSend(text);
    setInput('');
  }

  return (
    <div className="cz-term">
      <div className="cz-term-bar">
        <div className="lights" aria-hidden="true">
          <span className="r" />
          <span className="y" />
          <span className="g" />
        </div>
        <span className="brand">
          <SofaMark size={18} stroke="currentColor" /> sofa
        </span>
        <span className="meta mono">
          session-{session.id}
          {session.skill ? ` · ${session.skill}` : ''}
        </span>
        <span className={`live${streaming ? '' : ' still'}`}>
          <span className="dot" />
          {statusText}
        </span>
        <button type="button" className="cz-term-end" onClick={live.onEnd}>
          End session ✕
        </button>
      </div>

      <div className="cz-term-body" ref={bodyRef}>
        <div className="cz-term-echo">
          <span className="user">david@sofa</span>
          {session.dir && <span className="path mono">{session.dir}</span>}
          <span className="caret">▸</span>
          <span className="cmd">
            {session.skill ?? 'run'} <span className="arg">"{session.prompt}"</span>
          </span>
        </div>

        <TermLineRow line={{ tag: 'BOOT', text: bootMeta }} />
        {transcript.map((entry, i) => (
          <TermLineRow key={i} line={toTermLine(entry)} />
        ))}

        {pending.map((interaction) =>
          interaction.kind === 'question' ? (
            <QuestionForm
              key={interaction.questionId}
              pending={interaction}
              terminal
              onSubmit={(answer) => live.onAnswer(interaction.questionId, answer)}
            />
          ) : (
            <PermissionPrompt
              key={interaction.requestId}
              pending={interaction}
              onDecide={(decision) => live.onDecide(interaction.requestId, decision)}
            />
          ),
        )}

        {status === 'done' && <TermLineRow line={{ tag: 'DONE', text: 'session complete' }} />}

        {streaming && <span className="cz-term-cursor" aria-hidden="true" />}
      </div>

      <SessionStatusline session={session} status={status} />

      <form className="cz-term-input" onSubmit={submit}>
        <span className="user">david@sofa</span>
        <span className="caret">▸</span>
        <input
          ref={inputRef}
          aria-label="Reply"
          value={input}
          spellCheck={false}
          disabled={streaming}
          placeholder={streaming ? 'streaming…' : 'type your reply…'}
          onChange={(e) => setInput(e.target.value)}
        />
        <span className="hint" aria-hidden="true">
          ⏎ send
        </span>
      </form>
    </div>
  );
}

/**
 * Live-phase rail with two tabs — Dashboard | PRD. Dashboard is the default;
 * the PRD tab appears once a `prd_draft` event arrives and auto-focuses so the
 * draft surfaces immediately, while Dashboard stays one click away so Dispatch
 * remains usable mid-grill.
 */
function SessionRail({
  projectId,
  live,
  onStartSession,
  onViewSession,
}: {
  projectId: number;
  live: LiveSession;
  onStartSession: (prompt: string, skill?: string) => Promise<number>;
  onViewSession: (sessionId: number) => void;
}) {
  const hasPrd = live.prdDraft !== null;
  const hasIssue = live.fileIssueDraft !== null;
  const hasDraft = hasPrd || hasIssue;
  const [tab, setTab] = useState<'dashboard' | 'prd' | 'issue'>('dashboard');

  // When a draft first arrives (or is replaced after revision), auto-focus its
  // tab so it surfaces. A draft going away restores Dashboard as the default.
  useEffect(() => {
    if (hasIssue) setTab('issue');
    else if (hasPrd) setTab('prd');
    else setTab('dashboard');
  }, [hasPrd, hasIssue]);

  return (
    <div className="cz-rail">
      {hasDraft && (
        <div className="cz-rail-tabs" role="tablist" aria-label="Session rail">
          <button
            type="button"
            role="tab"
            id="cz-rail-tab-dashboard"
            aria-selected={tab === 'dashboard'}
            aria-controls="cz-rail-panel-dashboard"
            className={`cz-rail-tab${tab === 'dashboard' ? ' on' : ''}`}
            onClick={() => setTab('dashboard')}
          >
            Dashboard
          </button>
          {hasPrd && (
            <button
              type="button"
              role="tab"
              id="cz-rail-tab-prd"
              aria-selected={tab === 'prd'}
              aria-controls="cz-rail-panel-prd"
              className={`cz-rail-tab${tab === 'prd' ? ' on' : ''}`}
              onClick={() => setTab('prd')}
            >
              PRD
            </button>
          )}
          {hasIssue && (
            <button
              type="button"
              role="tab"
              id="cz-rail-tab-issue"
              aria-selected={tab === 'issue'}
              aria-controls="cz-rail-panel-issue"
              className={`cz-rail-tab${tab === 'issue' ? ' on' : ''}`}
              onClick={() => setTab('issue')}
            >
              Issue
            </button>
          )}
        </div>
      )}
      {(!hasDraft || tab === 'dashboard') && (
        <div
          role={hasDraft ? 'tabpanel' : undefined}
          id="cz-rail-panel-dashboard"
          aria-labelledby={hasDraft ? 'cz-rail-tab-dashboard' : undefined}
        >
          <ProjectDashboard
            projectId={projectId}
            hostBusy
            onStartSession={onStartSession}
            onViewSession={onViewSession}
          />
        </div>
      )}
      {hasDraft && tab === 'prd' && live.prdDraft && (
        <div
          role="tabpanel"
          id="cz-rail-panel-prd"
          aria-labelledby="cz-rail-tab-prd"
        >
          <PrdPanel
            draft={live.prdDraft}
            published={live.prdPublished}
            onRevise={live.onRevise}
            onApprove={live.onApprove}
          />
        </div>
      )}
      {hasDraft && tab === 'issue' && live.fileIssueDraft && (
        <div
          role="tabpanel"
          id="cz-rail-panel-issue"
          aria-labelledby="cz-rail-tab-issue"
        >
          <FileIssuePanel
            draft={live.fileIssueDraft}
            filed={live.fileIssueFiled}
            error={live.fileIssueError}
            onFile={live.onFileIssue}
            onDiscard={live.onDiscardFileIssue}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The idle-terminal launcher (#121): the full terminal layout with no Session
 * running. Empty body + idle BOOT line, statusline showing the chosen mode +
 * "idle", and the live input row doubles as the launcher — Enter on the first
 * line starts the Session in place via the same start-Session flow, with the
 * dashboard one click away in the rail beside it.
 */
function IdleTerminal({
  project,
  mode,
  skill,
  skills,
  prompt,
  onModeChange,
  onSkillChange,
  onPromptChange,
  onClose,
  onLaunch,
}: {
  project: Project;
  mode: 'grill' | 'session';
  skill: string;
  skills: Skill[];
  prompt: string;
  onModeChange: (mode: 'grill' | 'session') => void;
  onSkillChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onClose: () => void;
  onLaunch: (prompt: string, skill?: string) => Promise<number>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmed = prompt.trim();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    const launchSkill = mode === 'grill' ? 'grill-with-docs' : skill || undefined;
    try {
      await onLaunch(trimmed, launchSkill);
      onPromptChange('');
    } catch {
      // startSessionWith surfaces the error in the page-level banner; keep the
      // line so the user can retry without retyping.
    }
  }

  const bootText = `idle — ${mode === 'grill' ? 'Grill mode' : 'Session mode'} · type a prompt and press Enter to launch`;
  const modeLabel = mode === 'grill' ? 'Grill' : 'Session';

  return (
    <div className="cz-term idle" aria-label="Idle terminal launcher">
      <div className="cz-term-bar">
        <div className="lights" aria-hidden="true">
          <span className="r" />
          <span className="y" />
          <span className="g" />
        </div>
        <span className="brand">
          <SofaMark size={18} stroke="currentColor" /> sofa
        </span>
        <span className="meta mono">launcher · {project.name}</span>
        <span className="live still">
          <span className="dot" aria-hidden="true" />
          idle
        </span>
        <button type="button" className="cz-term-end" onClick={onClose}>
          Close ✕
        </button>
      </div>

      <div className="cz-term-body">
        <TermLineRow line={{ tag: 'BOOT', text: bootText }} />
        <div
          className="cz-term-launchopts"
          role="radiogroup"
          aria-label="Composer mode"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'grill'}
            className={`cz-composer-tab${mode === 'grill' ? ' on' : ''}`}
            onClick={() => onModeChange('grill')}
          >
            <span aria-hidden="true">◐</span> Grill
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'session'}
            className={`cz-composer-tab${mode === 'session' ? ' on' : ''}`}
            onClick={() => onModeChange('session')}
          >
            <span aria-hidden="true">✲</span> Session
          </button>
          {mode === 'session' && (
            <label className="cz-skill">
              <span className="k">Skill</span>
              <select
                aria-label="Session skill"
                value={skill}
                onChange={(e) => onSkillChange(e.target.value)}
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
        </div>
      </div>

      <div
        className="cz-term-statusline"
        role="status"
        aria-label="Launcher statusline"
      >
        <span className={`stl-mode mode-${mode}`}>{modeLabel}</span>
        {mode === 'session' && skill && (
          <span className="stl-cell stl-skill">{skill}</span>
        )}
        <span className="stl-spacer" />
        <span className="stl-cell stl-elapsed mono">idle</span>
      </div>

      <form className="cz-term-input" onSubmit={submit}>
        <span className="user">david@sofa</span>
        <span className="caret">▸</span>
        <input
          ref={inputRef}
          aria-label={mode === 'grill' ? 'Grilling Session seed' : 'Session prompt'}
          value={prompt}
          spellCheck={false}
          placeholder={
            mode === 'grill' ? 'e.g. The UI needs fixing' : 'e.g. tidy the README'
          }
          onChange={(e) => onPromptChange(e.target.value)}
        />
        <span className="hint" aria-hidden="true">
          ⏎ launch
        </span>
      </form>
    </div>
  );
}

/**
 * One open Project's self-contained block. Idle, it shows the launch controls
 * (Grilling hero + secondary skill dispatch bar) over the dashboard grid. When
 * a Session is launched from it the card morphs in place (ADR 0008) into the
 * live phase: the Session Terminal beside a fixed rail that keeps the dashboard
 * (and Dispatch) interactive. Per-Project state keeps dispatch unambiguous when
 * several Projects are open.
 */
function ProjectCard({
  project,
  skills,
  prompt,
  skill,
  dashboardOpen,
  liveSession,
  hostBusy,
  receded,
  onPromptChange,
  onSkillChange,
  onToggleDashboard,
  onLoadSessions,
  onStartSession,
  onViewSession,
}: {
  project: Project;
  skills: Skill[];
  prompt: string;
  skill: string;
  dashboardOpen: boolean;
  /** Set when a live Session belongs to this card — drives the morph to the live phase. */
  liveSession: LiveSession | null;
  /** True when an interactive Session is live anywhere — locks Process Notes. */
  hostBusy: boolean;
  /** Another card is hosting the live Session; recede this one but keep it visible. */
  receded: boolean;
  onPromptChange: (value: string) => void;
  onSkillChange: (value: string) => void;
  onToggleDashboard: () => void;
  onLoadSessions: () => void;
  onStartSession: (prompt: string, skill?: string) => Promise<number>;
  onViewSession: (sessionId: number) => void;
}) {
  const [mode, setMode] = useState<'grill' | 'session'>('grill');
  // The empty Session Terminal launcher (#121) — when open, replaces the idle
  // Composer + dashboard grid with the full terminal layout in an idle state.
  // It collapses back to the default dashboard-first view whenever a Session
  // arrives or leaves, so the resting view per Project stays dashboard-first.
  const [idleTerminalOpen, setIdleTerminalOpen] = useState(false);
  useEffect(() => {
    if (liveSession) setIdleTerminalOpen(false);
  }, [liveSession]);
  const trimmed = prompt.trim();

  async function submitComposer(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    const launchSkill = mode === 'grill' ? 'grill-with-docs' : skill || undefined;
    try {
      await onStartSession(trimmed, launchSkill);
      onPromptChange('');
    } catch {
      // startSessionWith surfaces the error in the page-level banner; keep the
      // prompt in the field so the user can retry without retyping it.
    }
  }

  return (
    <div className={`cz-project${receded ? ' receded' : ''}`}>
      <div className="cz-projhead">
        <div className="av">
          <SofaMark size={24} stroke="currentColor" />
        </div>
        <div>
          <div className="nm">{project.name}</div>
          <div className="pa mono">{project.dir}</div>
        </div>
        {liveSession && (
          <div className="cz-livechip mono">
            <span className="dot" aria-hidden="true" />
            Session #{liveSession.session.id}
          </div>
        )}
        <div className="acts">
          <button type="button" className="cz-tab" onClick={onLoadSessions}>
            Past Sessions
          </button>
          {!liveSession && (
            <button type="button" className="cz-tab" onClick={onToggleDashboard}>
              {dashboardOpen ? 'Hide dashboard' : 'Show dashboard'}
            </button>
          )}
        </div>
      </div>

      {liveSession ? (
        <div className="cz-live">
          <div className="cz-term-col">
            <SessionTerminal live={liveSession} />
          </div>
          <SessionRail
            projectId={project.id}
            live={liveSession}
            onStartSession={onStartSession}
            onViewSession={onViewSession}
          />
        </div>
      ) : idleTerminalOpen ? (
        <div className="cz-live">
          <div className="cz-term-col">
            <IdleTerminal
              project={project}
              mode={mode}
              skill={skill}
              skills={skills}
              prompt={prompt}
              onModeChange={setMode}
              onSkillChange={onSkillChange}
              onPromptChange={onPromptChange}
              onClose={() => setIdleTerminalOpen(false)}
              onLaunch={onStartSession}
            />
          </div>
          <div className="cz-rail">
            <ProjectDashboard
              projectId={project.id}
              hostBusy={hostBusy}
              onStartSession={onStartSession}
              onViewSession={onViewSession}
            />
          </div>
        </div>
      ) : (
        <>
          <form
            className="cz-cush cz-hero cz-accent cz-composer cz-launcher"
            onSubmit={submitComposer}
            aria-label="Start a Grilling Session or Session"
          >
            <div
              className="cz-composer-toggle"
              role="radiogroup"
              aria-label="Composer mode"
            >
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'grill'}
                className={`cz-composer-tab${mode === 'grill' ? ' on' : ''}`}
                onClick={() => setMode('grill')}
              >
                <span aria-hidden="true">◐</span> Grill
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'session'}
                className={`cz-composer-tab${mode === 'session' ? ' on' : ''}`}
                onClick={() => setMode('session')}
              >
                <span aria-hidden="true">✲</span> Session
              </button>
            </div>
            <label className="cz-hero-label" htmlFor={`composer-prompt-${project.id}`}>
              <span className="cz-launcher-caret mono" aria-hidden="true">
                david@sofa ▸
              </span>{' '}
              {mode === 'grill'
                ? 'What do you want to work on today?'
                : 'What should the Session do?'}
            </label>
            <div className="cz-hero-row">
              <input
                id={`composer-prompt-${project.id}`}
                aria-label={mode === 'grill' ? 'Grilling Session seed' : 'Session prompt'}
                className="cz-hero-input mono"
                spellCheck={false}
                placeholder={mode === 'grill' ? 'e.g. The UI needs fixing' : 'e.g. tidy the README'}
                value={prompt}
                onChange={(e) => onPromptChange(e.target.value)}
              />
              {mode === 'session' && (
                <label className="cz-skill">
                  <span className="k">Skill</span>
                  <select
                    aria-label="Session skill"
                    value={skill}
                    onChange={(e) => onSkillChange(e.target.value)}
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
              <button
                type="submit"
                className="cz-btn tan"
                disabled={!trimmed || receded}
                title={receded ? 'End the active Session first — one Session at a time.' : undefined}
              >
                {mode === 'grill' ? 'Start Grilling' : 'Start Session'}
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 3l14 9-14 9z" />
                </svg>
              </button>
              <button
                type="button"
                className="cz-btn cz-launcher-open-term"
                disabled={receded}
                onClick={() => setIdleTerminalOpen(true)}
                title={
                  receded
                    ? 'End the active Session first — one Session at a time.'
                    : 'Open an empty Session Terminal and launch from there.'
                }
              >
                Open terminal ▸_
              </button>
            </div>
            {receded && (
              <p className="cz-composer-lockhint" role="note">
                One Session at a time — end the active Session to launch from this Project.
              </p>
            )}
          </form>

          {dashboardOpen && (
            <ProjectDashboard
              projectId={project.id}
              hostBusy={hostBusy}
              onStartSession={onStartSession}
              onViewSession={onViewSession}
            />
          )}
        </>
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
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
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
  const [fileIssueDraft, setFileIssueDraft] = useState<FileIssueDraft | null>(null);
  const [fileIssueFiled, setFileIssueFiled] = useState<FileIssueFiling | null>(null);
  const [fileIssueError, setFileIssueError] = useState<string | null>(null);
  const [pastSessions, setPastSessions] = useState<PastSession[] | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  // Dashboards are expanded by default; this tracks the ones the user collapsed.
  const [hiddenDashboards, setHiddenDashboards] = useState<Record<number, boolean>>({});

  const promptFor = (id: number) => prompts[id] ?? '';

  async function refresh() {
    const res = await fetch('/api/projects');
    const list: Project[] = await res.json();
    setProjects(list);
    setActiveProjectId((current) => {
      if (current !== null && list.some((p) => p.id === current)) return current;
      return list[0]?.id ?? null;
    });
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
    const opened = (await res.json().catch(() => null)) as Project | null;
    setDir('');
    const listRes = await fetch('/api/projects');
    const list: Project[] = await listRes.json();
    setProjects(list);
    if (opened && list.some((p) => p.id === opened.id)) {
      setActiveProjectId(opened.id);
    } else {
      setActiveProjectId((current) =>
        current !== null && list.some((p) => p.id === current) ? current : list[0]?.id ?? null,
      );
    }
  }

  async function closeProject(id: number) {
    setError(null);
    const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? `failed to close project (${res.status})`);
      return;
    }
    const listRes = await fetch('/api/projects');
    const list: Project[] = await listRes.json();
    setProjects(list);
    setActiveProjectId((current) => {
      if (current !== id && list.some((p) => p.id === current)) return current;
      return list[0]?.id ?? null;
    });
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

  /** Collapse the live card back to its idle Composer, dropping all Session state. */
  function collapseSession() {
    sourceRef.current?.close();
    setSession(null);
    setTranscript([]);
    setPending([]);
    setStatus(null);
    setPrdDraft(null);
    setPrdPublished(null);
    setFileIssueDraft(null);
    setFileIssueFiled(null);
    setFileIssueError(null);
  }

  /**
   * The Session Terminal's "End session" action: terminate a still-running
   * Session via the end endpoint (ADR 0008), then collapse the card. A Session
   * already done/errored (e.g. a viewed past transcript) just collapses.
   */
  async function endAndCollapse() {
    if (session && (status === 'streaming' || status === 'awaiting')) {
      await endSession(session.id);
    }
    collapseSession();
  }

  async function fileIssue(sessionId: number, title: string, body: string) {
    setFileIssueError(null);
    const res = await fetch(`/api/sessions/${sessionId}/file-issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setFileIssueError(data?.error ?? `filing the Issue failed (${res.status})`);
      return;
    }
    const { number, url } = (await res.json()) as { number: number; url: string };
    setFileIssueFiled({ number, url });
    setTranscript((t) => [...t, { kind: 'resolution', text: `Issue filed as #${number}.` }]);
  }

  function discardFileIssue() {
    setFileIssueDraft(null);
    setFileIssueFiled(null);
    setFileIssueError(null);
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
    setSession({
      id: started.id,
      projectId: project.id,
      projectName: project.name,
      prompt,
      skill,
      dir: project.dir,
      startedAt: started.startedAt,
    });
    setTranscript([]);
    setPending([]);
    setStatus('streaming');
    setPrdDraft(null);
    setPrdPublished(null);
    setFileIssueDraft(null);
    setFileIssueFiled(null);
    setFileIssueError(null);
    attachStream(started.id);
    // Backfill the BOOT line's model from the Project's Session-model setting,
    // without blocking the morph. Best-effort: a failure just omits the cell.
    void fetch(`/api/projects/${project.id}/settings`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { sessionModel?: string | null } | null) => {
        const model = data?.sessionModel ?? 'default';
        setSession((prev) => (prev && prev.id === started.id ? { ...prev, model } : prev));
      })
      .catch(() => {});
    return started.id as number;
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
    const project = projects.find((p) => p.id === projectId);
    sourceRef.current?.close();
    setSession({
      id: persisted.id,
      projectId,
      projectName: project?.name ?? `Project ${projectId}`,
      prompt: persisted.prompt,
      dir: project?.dir,
      startedAt: persisted.startedAt,
    });
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
    source.addEventListener('file_issue_draft', (e) => {
      const { title, body } = JSON.parse((e as MessageEvent).data);
      setFileIssueDraft({ title, body });
      setFileIssueFiled(null);
      setFileIssueError(null);
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
    setSession({
      id: past.id,
      projectId: past.projectId,
      projectName,
      prompt: past.prompt,
      dir: projects.find((p) => p.id === past.projectId)?.dir,
      startedAt: past.startedAt,
    });
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
    setSession({
      id: past.id,
      projectId: past.projectId,
      projectName,
      prompt,
      dir: projects.find((p) => p.id === past.projectId)?.dir,
      startedAt: past.startedAt,
    });
    setTranscript(events.map(toEntry));
    setStatus('streaming');
    setPrompts((prev) => ({ ...prev, [past.projectId]: '' }));
    attachStream(past.id);
  }

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const liveSessionProjectId = session?.projectId ?? null;
  const activeLive: LiveSession | null =
    session && activeProject && session.projectId === activeProject.id
      ? {
          session,
          transcript,
          pending,
          status,
          prdDraft,
          prdPublished,
          fileIssueDraft,
          fileIssueFiled,
          fileIssueError,
          onAnswer: (questionId, answer) => void answerQuestion(session.id, questionId, answer),
          onDecide: (requestId, decision) => void decidePermission(session.id, requestId, decision),
          onSend: (text) => {
            setStatus('streaming');
            void sendSessionMessage(session.id, text);
          },
          onEnd: () => void endAndCollapse(),
          onRevise: (text) => void revisePrd(session.id, text),
          onApprove: () => void approvePrd(session.id),
          onFileIssue: (title, body) => void fileIssue(session.id, title, body),
          onDiscardFileIssue: () => discardFileIssue(),
        }
      : null;

  return (
    <div className="cz-shell">
      <aside className="cz-projrail" aria-label="Project Rail">
        <div className="cz-railhead">
          <div className="cz-logo">
            <SofaMark size={28} stroke="currentColor" />
          </div>
          <div>
            <h1 className="cz-word">Sofa</h1>
            <div className="cz-sub">software factory</div>
          </div>
        </div>

        <nav className="cz-rail-list" aria-label="Open Projects">
          {projects.length === 0 ? (
            <p className="cz-muted cz-rail-empty">No Projects open yet.</p>
          ) : (
            <ul role="list">
              {projects.map((p) => {
                const isActive = p.id === activeProjectId;
                const isBusy = liveSessionProjectId === p.id;
                return (
                  <li key={p.id} className="cz-rail-item-row">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-label={`Project ${p.name}${isActive ? ' (Active)' : ''}`}
                      className={`cz-rail-item${isActive ? ' active' : ''}`}
                      onClick={() => setActiveProjectId(p.id)}
                    >
                      <span className="av" aria-hidden="true">
                        <SofaMark size={18} stroke="currentColor" />
                      </span>
                      <span className="meta">
                        <span className="nm">{p.name}</span>
                        <span className="pa mono">{p.dir}</span>
                      </span>
                      {isBusy && <span className="live-dot" aria-label="Live Session" />}
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${p.name}`}
                      title={`Close ${p.name}`}
                      className="cz-rail-close"
                      onClick={() => void closeProject(p.id)}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <form onSubmit={openProject} className="cz-rail-open">
          <input
            aria-label="Project directory"
            className="cz-field"
            placeholder="▸ C:\path\to\project"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
          />
          <div className="cz-rail-open-actions">
            <button type="button" className="cz-btn" onClick={() => setBrowsing(true)}>
              Browse…
            </button>
            <button type="submit" className="cz-btn tan" disabled={!dir.trim()}>
              Open Project
            </button>
          </div>
        </form>
      </aside>

      <main className="cz-main">
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

        {activeProject ? (
          <ProjectCard
            key={activeProject.id}
            project={activeProject}
            skills={skills}
            prompt={promptFor(activeProject.id)}
            skill={skillByProject[activeProject.id] ?? ''}
            dashboardOpen={!hiddenDashboards[activeProject.id]}
            liveSession={activeLive}
            hostBusy={session !== null}
            receded={session !== null && session.projectId !== activeProject.id}
            onPromptChange={(value) =>
              setPrompts((prev) => ({ ...prev, [activeProject.id]: value }))
            }
            onSkillChange={(value) =>
              setSkillByProject((prev) => ({ ...prev, [activeProject.id]: value }))
            }
            onToggleDashboard={() =>
              setHiddenDashboards((prev) => ({
                ...prev,
                [activeProject.id]: !prev[activeProject.id],
              }))
            }
            onLoadSessions={() => void loadSessions(activeProject)}
            onStartSession={(prompt, skill) => startSessionWith(activeProject, prompt, skill)}
            onViewSession={(sessionId) => void viewSessionById(activeProject.id, sessionId)}
          />
        ) : (
          <p className="cz-muted cz-main-empty">
            Open a Project from the Project Rail to get started.
          </p>
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
      </main>
    </div>
  );
}
