import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Issue #104 — one interactive Session at a time across all open Projects.
// With two Projects open and a Session live in the first, the second
// Project's Composer launch button locks (with a hint), but its Dispatch
// button (Workers / Ralph Loop) stays fully enabled. Ending the Session
// re-enables the launch on the other card.
const SESSION_ID = 9104;

test("One Session at a time: other open Projects' launch locks; Dispatch stays enabled", async ({
  page,
}) => {
  const dirA = mkdtempSync(join(tmpdir(), 'sofa-lockA-'));
  const dirB = mkdtempSync(join(tmpdir(), 'sofa-lockB-'));

  // One ready Issue for every Project so Dispatch buttons render and we can
  // assert their enabled state on the receded card.
  await page.route(/\/api\/projects\/\d+\/issues$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { number: 1, title: 'demo issue', url: 'https://example.test/issues/1' },
      ]),
    }),
  );
  // Empty supporting data so the dashboard renders without errors.
  await page.route(/\/api\/projects\/\d+\/runs$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [], issuesWithOpenPr: [] }),
    }),
  );
  await page.route(/\/api\/projects\/\d+\/usage$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route(/\/api\/projects\/\d+\/field-notes$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(/\/api\/projects\/\d+\/settings$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  // Stub Session create + its event stream so no real agent runs. Hand back a
  // never-closing empty body so the live phase stays observable for the
  // assertions that follow.
  await page.route(/\/api\/projects\/\d+\/sessions$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: SESSION_ID, startedAt: new Date().toISOString() }),
    });
  });
  await page.route(new RegExp(`/api/sessions/${SESSION_ID}/events$`), (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );
  await page.route(new RegExp(`/api/sessions/${SESSION_ID}/end$`), (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  await page.goto('/');

  // Open two Projects.
  await page.getByLabel('Project directory').fill(dirA);
  await page.getByRole('button', { name: 'Open Project' }).click();
  await page.getByLabel('Project directory').fill(dirB);
  await page.getByRole('button', { name: 'Open Project' }).click();

  // Sanity: both Composers' Start Grilling buttons exist and are disabled
  // only because the prompt is empty.
  const startButtons = page.getByRole('button', { name: 'Start Grilling' });
  await expect(startButtons).toHaveCount(2);

  // Fill the prompt on both Composers so the only thing that could disable
  // the second button is the session lock.
  const prompts = page.getByLabel('Grilling Session seed');
  await prompts.nth(0).fill('first project work');
  await prompts.nth(1).fill('second project work');
  await expect(startButtons.nth(0)).toBeEnabled();
  await expect(startButtons.nth(1)).toBeEnabled();

  // Launch a Session from the first Project.
  await startButtons.nth(0).click();

  // The first card morphs into the live phase — its Session #N chip shows.
  await expect(page.getByText(`Session #${SESSION_ID}`)).toBeVisible();

  // The OTHER (still-idle) card's launch button is now locked with a hint,
  // even though its prompt is filled. Only one Start Grilling button remains
  // visible (the live card no longer renders one), and it is the receded
  // card's locked button.
  const lockedStart = page.getByRole('button', { name: 'Start Grilling' });
  await expect(lockedStart).toHaveCount(1);
  await expect(lockedStart).toBeDisabled();
  await expect(
    page.getByText(/One Session at a time — end the active Session/),
  ).toBeVisible();

  // Dispatch on the receded card is independent of the Session lock — it
  // stays enabled so the Ralph Loop keeps running while a grill is live.
  const dispatchButtons = page.getByRole('button', { name: 'Dispatch' });
  await expect(dispatchButtons.first()).toBeEnabled();

  // End the live Session — the locked launch re-enables on the other card.
  await page.getByRole('button', { name: /End session/ }).click();
  const reenabled = page.getByRole('button', { name: 'Start Grilling' });
  await expect(reenabled).toHaveCount(2);
  await expect(reenabled.nth(0)).toBeEnabled();
  await expect(reenabled.nth(1)).toBeEnabled();
});
