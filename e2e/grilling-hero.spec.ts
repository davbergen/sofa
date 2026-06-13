import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Project hero starts a grill-with-docs Session with the typed seed', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-hero-'));

  await page.goto('/');
  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

  const hero = page.getByLabel('Grilling Session seed');
  await expect(hero).toBeVisible();

  // The submit button is disabled while the hero is empty (acceptance criterion).
  const submit = page.getByRole('button', { name: 'Start Grilling' });
  await expect(submit).toBeDisabled();

  // Intercept the Session create so the assertion runs without spawning a real
  // grilling agent. The route stubs a started Session and closes the stream
  // immediately so the page is left in a stable, observable state.
  let captured: { prompt?: string; skill?: string } | null = null;
  await page.route(/\/api\/projects\/\d+\/sessions$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    captured = route.request().postDataJSON() as { prompt?: string; skill?: string };
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 4242 }),
    });
  });
  // Close the live event stream right away so the transcript view stays
  // deterministic — the assertions don't need any events to fire.
  await page.route(/\/api\/sessions\/4242\/events$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );

  const seed = 'The UI needs fixing';
  await hero.fill(seed);
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect.poll(() => captured).not.toBeNull();
  expect(captured).toEqual({ prompt: seed, skill: 'grill-with-docs' });
  await expect(hero).toHaveValue('');
});
