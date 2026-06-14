import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Extends the grilling-hero.spec.ts route-stub pattern: one Composer per Project
// hosts a Grill / Session toggle that swaps which skill is sent on launch
// without spawning a real agent.

test('Merged Composer toggles Grill / Session and posts the right { prompt, skill }', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-composer-'));

  await page.goto('/');
  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

  // Stub the Session create so the assertion runs without spawning a real agent.
  let captured: { prompt?: string; skill?: string } | null = null;
  let sessionCounter = 0;
  await page.route(/\/api\/projects\/\d+\/sessions$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    captured = route.request().postDataJSON() as { prompt?: string; skill?: string };
    sessionCounter += 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 4000 + sessionCounter }),
    });
  });
  // Close the live event stream right away so the page stays observable.
  await page.route(/\/api\/sessions\/\d+\/events$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );
  // Terminate any live Session immediately on End session so the card collapses
  // and the Composer returns for the second assertion path.
  await page.route(/\/api\/sessions\/\d+\/end$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  // The toggle is visible and Grill mode is the default.
  const grillTab = page.getByRole('radio', { name: /Grill/ });
  const sessionTab = page.getByRole('radio', { name: /Session/ });
  await expect(grillTab).toBeVisible();
  await expect(sessionTab).toBeVisible();
  await expect(grillTab).toHaveAttribute('aria-checked', 'true');

  // In Grill mode the skill picker is hidden and submitting posts grill-with-docs.
  await expect(page.getByLabel('Session skill')).toHaveCount(0);
  const prompt = page.getByLabel('Grilling Session seed');
  await expect(prompt).toBeVisible();
  const grillSubmit = page.getByRole('button', { name: 'Start Grilling' });
  await expect(grillSubmit).toBeDisabled();
  await prompt.fill('grill seed');
  await expect(grillSubmit).toBeEnabled();
  await grillSubmit.click();
  await expect.poll(() => captured).not.toBeNull();
  expect(captured).toEqual({ prompt: 'grill seed', skill: 'grill-with-docs' });

  // Collapse the live card so the Composer returns for the Session-mode test.
  await page.getByRole('button', { name: /End session/ }).click();
  captured = null;

  // Switch to Session mode — picker appears, submit becomes "Start Session".
  await sessionTab.click();
  await expect(sessionTab).toHaveAttribute('aria-checked', 'true');
  const picker = page.getByLabel('Session skill');
  await expect(picker).toBeVisible();
  const sessionPrompt = page.getByLabel('Session prompt');
  await sessionPrompt.fill('session prompt');
  await page.getByRole('button', { name: 'Start Session' }).click();
  await expect.poll(() => captured).not.toBeNull();
  // No skill chosen — the picker default "(no skill)" omits the field.
  expect(captured).toEqual({ prompt: 'session prompt' });
});
