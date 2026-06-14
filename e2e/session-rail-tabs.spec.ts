import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A scripted SSE stream that emits a `prd_draft` event so the rail reveals and
// auto-focuses the PRD tab without running a real grilling agent.
const SESSION_ID = 5151;
const STREAM = [
  'event: assistant_text',
  'data: {"text":"drafting a PRD"}',
  '',
  'event: prd_draft',
  'data: {"title":"PRD: tidy the notes pane","markdown":"# Goal\\n\\nTidy the notes pane."}',
  '',
  'event: done',
  'data: {}',
  '',
  '',
].join('\n');

test('Session rail tabs: prd_draft reveals and auto-focuses PRD tab; Dashboard stays reachable', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-rail-'));

  await page.goto('/');
  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

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

  // Start a grill — the card morphs into the live phase. Before any prd_draft
  // arrives, the rail has no tab strip and just shows the Dashboard.
  await page.getByLabel('Grilling Session seed').fill('Tidy the notes pane');
  await page.getByRole('button', { name: 'Start Grilling' }).click();

  // PRD tab appears once the prd_draft event lands, auto-focused.
  const prdTab = page.getByRole('tab', { name: 'PRD' });
  const dashTab = page.getByRole('tab', { name: 'Dashboard' });
  await expect(prdTab).toBeVisible();
  await expect(dashTab).toBeVisible();
  await expect(prdTab).toHaveAttribute('aria-selected', 'true');
  await expect(dashTab).toHaveAttribute('aria-selected', 'false');

  // The PRD draft renders in the PRD panel; the revise + approve controls work
  // exactly as before.
  await expect(page.getByRole('heading', { name: 'PRD: tidy the notes pane' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and publish to GitHub' })).toBeVisible();

  // Switching to the Dashboard tab keeps Dispatch reachable while a draft exists.
  await dashTab.click();
  await expect(dashTab).toHaveAttribute('aria-selected', 'true');
  await expect(prdTab).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('button', { name: 'Approve and publish to GitHub' })).toHaveCount(0);
  // The Dashboard panel is back in view — its Ready Issues section is rendered.
  await expect(page.locator('section[aria-label="Ready Issues"]')).toBeVisible();

  // And the PRD tab can be re-focused with a click.
  await prdTab.click();
  await expect(prdTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'PRD: tidy the notes pane' })).toBeVisible();
});
