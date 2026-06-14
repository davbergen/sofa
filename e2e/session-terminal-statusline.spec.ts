import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A scripted SSE stream that opens a Session and immediately yields the turn
// (turn_boundary) so the live statusline assertions run without spawning a real
// grilling agent.
const SESSION_ID = 7373;
const STREAM = [
  'event: assistant_text',
  'data: {"text":"thinking…"}',
  '',
  'event: turn_boundary',
  'data: {}',
  '',
  '',
].join('\n');

test('Session Terminal statusline: mode, skill, model, live elapsed; no token/branch placeholders', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-statusline-'));

  await page.goto('/');
  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

  // Stub the Session create with a known startedAt one minute ago so the live
  // elapsed cell starts at a stable, non-zero value.
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  await page.route(/\/api\/projects\/\d+\/sessions$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: SESSION_ID, startedAt }),
    });
  });
  await page.route(new RegExp(`/api/sessions/${SESSION_ID}/events$`), (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: STREAM }),
  );

  // The Project's sessionModel setting drives the model cell.
  await page.route(/\/api\/projects\/\d+\/settings$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessionModel: 'claude-opus-4-7' }),
    }),
  );

  // Start a grill from the hero — the card morphs into the live phase.
  await page.getByLabel('Grilling Session seed').fill('I want to remove field notes');
  await page.getByRole('button', { name: 'Start Grilling' }).click();

  // The statusline appears with the four cells the issue calls for.
  const statusline = page.getByRole('status', { name: 'Session statusline' });
  await expect(statusline).toBeVisible();

  // Mode badge: Grill (the grill-with-docs skill).
  await expect(statusline.getByText('Grill', { exact: true })).toBeVisible();

  // Skill cell shows the actual skill name.
  await expect(statusline.getByText('grill-with-docs', { exact: true })).toBeVisible();

  // Model cell reflects the Project's sessionModel setting.
  await expect(statusline.getByText('claude-opus-4-7', { exact: true })).toBeVisible();

  // Elapsed timer renders mm:ss derived from startedAt — with startedAt one
  // minute ago the initial value is ~01:00. (Live ticking is observed in the
  // browser; the SSE stub here closes immediately, which would freeze the
  // timer mid-test.)
  const elapsed = statusline.getByLabel('Elapsed time');
  await expect(elapsed).toHaveText(/^01:0\d$/);

  // The deferred cells from the visual handoff are absent — no placeholder
  // values like `—`, `n/a`, no `tokens`/`branch` wording in the statusline.
  await expect(statusline.getByText('—')).toHaveCount(0);
  await expect(statusline.getByText(/n\/a/i)).toHaveCount(0);
  await expect(statusline.getByText(/tokens?/i)).toHaveCount(0);
  await expect(statusline.getByText(/branch/i)).toHaveCount(0);
  await expect(statusline.getByText('⎇')).toHaveCount(0);
});
