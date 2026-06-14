import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A scripted SSE stream (one buffered body, closed by `done`) so the assertions
// run without spawning a real grilling agent — the established pattern from
// `grilling-hero.spec.ts`, extended with a full event sequence so each
// event→line mapping (ADR 0008) can be observed.
const SESSION_ID = 4242;
const STREAM = [
  'event: assistant_text',
  'data: {"text":"understanding the request before asking anything"}',
  '',
  'event: file_write',
  'data: {"path":"src/store/notes.ts"}',
  '',
  'event: user_message',
  'data: {"text":"please keep it reversible"}',
  '',
  'event: question',
  'data: {"questionId":"q1","question":"Permanent delete, or a restorable archive?","options":[{"label":"Permanent delete"},{"label":"Restorable archive"}],"recommended":"Restorable archive"}',
  '',
  'event: done',
  'data: {}',
  '',
  '',
].join('\n');

test('Session Terminal morphs the card, maps each event to a line, and collapses on End session', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-term-'));

  await page.goto('/');
  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

  // Stub the Session create + its event stream so no real agent runs.
  await page.route(/\/api\/projects\/\d+\/sessions$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: SESSION_ID }),
    });
  });
  await page.route(new RegExp(`/api/sessions/${SESSION_ID}/events$`), (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: STREAM }),
  );

  // Capture the unstructured reply so we can assert it travels the message path.
  let replied: { text?: string } | null = null;
  await page.route(new RegExp(`/api/sessions/${SESSION_ID}/message$`), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    replied = route.request().postDataJSON() as { text?: string };
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // End session terminates a still-running Session via this endpoint (ADR 0008).
  let ended = false;
  await page.route(new RegExp(`/api/sessions/${SESSION_ID}/end$`), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    ended = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // The launching card has no terminal yet.
  const terminal = page.getByRole('button', { name: /End session/ });
  await expect(terminal).toHaveCount(0);

  // Start a grill from the hero — the card morphs into the live phase.
  await page.getByLabel('Grilling Session seed').fill('I want to remove field notes');
  await page.getByRole('button', { name: 'Start Grilling' }).click();

  // Morph: the Session Terminal appears in place.
  await expect(terminal).toBeVisible();

  // BOOT line opens the transcript with the Session identity (id, skill, cwd).
  await expect(
    page.getByText(new RegExp(`session #${SESSION_ID} · skill grill-with-docs`)),
  ).toBeVisible();

  // Each scripted event renders its tagged line.
  await expect(page.getByText('understanding the request before asking anything')).toBeVisible();
  await expect(page.getByText('src/store/notes.ts')).toBeVisible();
  await expect(page.getByText('please keep it reversible')).toBeVisible();
  await expect(page.getByText('session complete')).toBeVisible();

  // The `question` event renders the structured ASK block (options + recommended).
  const ask = page.getByRole('form', { name: 'Question: Permanent delete, or a restorable archive?' });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole('radio', { name: /Permanent delete/ })).toBeVisible();
  await expect(ask.getByText('(recommended)')).toBeVisible();

  // The free-text reply row sends an unstructured reply via the message path.
  await page.getByLabel('Reply').fill('also add an undo toast');
  await page.getByLabel('Reply').press('Enter');
  await expect.poll(() => replied).not.toBeNull();
  expect(replied).toEqual({ text: 'also add an undo toast' });

  // End session terminates the Session and collapses the card to the Composer.
  await terminal.click();
  await expect(terminal).toHaveCount(0);
  await expect(page.getByLabel('Grilling Session seed')).toBeVisible();
  await expect.poll(() => ended).toBe(true);
});
