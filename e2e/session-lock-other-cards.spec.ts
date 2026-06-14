import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Issue #117 — re-asserts the one-Session-at-a-time invariant under the Project
// Rail / single Active Project shell (ADR 0009). With two Projects open and a
// Session live in A, switching to B in the rail leaves A's Session running, B
// shows its own idle workbench whose launcher is locked with the hint, but B's
// Dispatch stays fully enabled. Switching back to A reattaches the live
// terminal; ending the Session clears the lock and the rail pulse.
const SESSION_ID = 9117;

test("Background Session survives a Project switch (rail model)", async ({
  page,
}) => {
  const dirA = mkdtempSync(join(tmpdir(), 'sofa-bg-A-'));
  const dirB = mkdtempSync(join(tmpdir(), 'sofa-bg-B-'));
  const nameA = basename(dirA);
  const nameB = basename(dirB);

  // One ready Issue per Project so Dispatch buttons render and we can assert
  // their enabled state on the receded Project.
  await page.route(/\/api\/projects\/\d+\/issues$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { number: 1, title: 'demo issue', url: 'https://example.test/issues/1' },
      ]),
    }),
  );
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

  // Stub Session create + a never-closing empty event stream so the live phase
  // stays observable across switches.
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

  // Open A then B; B is most recently opened so the rail makes B Active.
  await page.getByLabel('Project directory').fill(dirA);
  await page.getByRole('button', { name: 'Open Project' }).click();
  await page.getByLabel('Project directory').fill(dirB);
  await page.getByRole('button', { name: 'Open Project' }).click();

  const rail = page.getByRole('complementary', { name: 'Project Rail' });
  const tabA = rail.getByRole('tab', { name: new RegExp(`^Project ${nameA}`) });
  const tabB = rail.getByRole('tab', { name: new RegExp(`^Project ${nameB}`) });

  // Switch to A and launch a Session from A's Composer.
  await tabA.click();
  await expect(tabA).toHaveAttribute('aria-selected', 'true');
  const composers = page.getByRole('form', {
    name: 'Start a Grilling Session or Session',
  });
  await expect(composers).toHaveCount(1);
  await page.getByLabel('Grilling Session seed').fill('first project work');
  await page.getByRole('button', { name: 'Start Grilling' }).click();

  // A's card morphs to the live phase — its Session #N chip is visible and the
  // Composer is gone (replaced by the Session Terminal).
  await expect(page.getByText(`Session #${SESSION_ID}`)).toBeVisible();
  await expect(composers).toHaveCount(0);

  // Rail shows a live pulse on A (the busy Project), not on B.
  await expect(tabA.locator('.live-dot')).toBeVisible();
  await expect(tabB.locator('.live-dot')).toHaveCount(0);

  // Switch to B in the rail — A's Session is left running (background).
  await tabB.click();
  await expect(tabB).toHaveAttribute('aria-selected', 'true');

  // B shows its own idle workbench: exactly one Composer is on screen, and it
  // is B's. The live Session Terminal is not rendered for B.
  await expect(composers).toHaveCount(1);
  await expect(page.getByText(`Session #${SESSION_ID}`)).toHaveCount(0);

  // B's launcher is locked with the one-Session hint, even with a filled prompt.
  const startOnB = page.getByRole('button', { name: 'Start Grilling' });
  await page.getByLabel('Grilling Session seed').fill('second project work');
  await expect(startOnB).toBeDisabled();
  await expect(
    page.getByText(/One Session at a time — end the active Session/),
  ).toBeVisible();

  // B's Dispatch stays enabled — the Ralph Loop is independent of the
  // single-Session lock.
  const dispatchOnB = page.getByRole('button', { name: 'Dispatch' });
  await expect(dispatchOnB.first()).toBeEnabled();

  // The live pulse stays on A while B is Active.
  await expect(tabA.locator('.live-dot')).toBeVisible();
  await expect(tabB.locator('.live-dot')).toHaveCount(0);

  // Switch back to A — the live Session Terminal reattaches in place.
  await tabA.click();
  await expect(tabA).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(`Session #${SESSION_ID}`)).toBeVisible();
  await expect(composers).toHaveCount(0);

  // End the Session from A — the lock and the rail pulse clear.
  await page.getByRole('button', { name: /End session/ }).click();
  await expect(page.getByText(`Session #${SESSION_ID}`)).toHaveCount(0);
  await expect(tabA.locator('.live-dot')).toHaveCount(0);
  await expect(tabB.locator('.live-dot')).toHaveCount(0);

  // Switching to B now finds its Composer unlocked.
  await tabB.click();
  await expect(page.getByRole('button', { name: 'Start Grilling' })).toBeEnabled();
  await expect(
    page.getByText(/One Session at a time — end the active Session/),
  ).toHaveCount(0);
});
