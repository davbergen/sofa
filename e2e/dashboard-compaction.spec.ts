import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Issue #120 — Ready Issues / Project Settings / Token Usage compaction. The
// three remaining dashboard cards stop occupying fixed vertical space:
//
//   * Project Settings collapses behind the gear header (set-once).
//   * Token Usage shows total + bars always; per-day list is behind a toggle.
//   * Ready Issues sorts dispatchable Issues (no open PR) above Issues that
//     still render with Dispatch greyed and a PR link.
test('dashboard compaction: Settings collapsed-then-expand, Usage per-day toggle, Ready Issues dispatchable-first ordering', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-compact120-'));

  // Two Ready Issues: #11 has a live PR (shown second), #22 is dispatchable
  // (must render first regardless of API order).
  const issues = [
    { number: 11, title: 'has an open PR', url: 'https://example.test/issues/11' },
    { number: 22, title: 'dispatchable now', url: 'https://example.test/issues/22' },
  ];

  await page.route(/\/api\/projects\/\d+\/issues$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(issues) }),
  );
  await page.route(/\/api\/projects\/\d+\/runs$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(/\/api\/projects\/\d+\/reconcile$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        runs: [],
        issuesWithOpenPr: [
          { issue: 11, prNumber: 911, prUrl: 'https://example.test/pr/911' },
        ],
      }),
    }),
  );
  await page.route(/\/api\/projects\/\d+\/usage$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 4321,
        },
        byDay: [
          {
            day: '2026-06-14',
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 4321,
          },
        ],
        byRun: [],
      }),
    }),
  );
  await page.route(/\/api\/projects\/\d+\/field-notes$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hasNote: false, items: [] }),
    }),
  );
  await page.route(/\/api\/projects\/\d+\/settings$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ workerModel: null, sessionModel: null }),
    }),
  );

  await page.goto('/');
  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

  // --- Project Settings: collapsed by default, expands on click ---
  const settingsRegion = page.getByRole('region', { name: 'Project Settings' });
  await expect(settingsRegion).toBeVisible();
  const settingsToggle = settingsRegion.getByRole('button', { name: 'Project Settings' });
  await expect(settingsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(settingsRegion.getByLabel('Worker model')).toBeHidden();
  await settingsToggle.click();
  await expect(settingsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(settingsRegion.getByLabel('Worker model')).toBeVisible();
  await expect(settingsRegion.getByLabel('Session model')).toBeVisible();

  // --- Token Usage: total + bars always visible; per-day toggle hides list ---
  const usageRegion = page.getByRole('region', { name: 'Token Usage' });
  await expect(usageRegion).toContainText('4,321');
  // The per-day breakdown is hidden behind a toggle.
  await expect(usageRegion.getByText('2026-06-14')).toBeHidden();
  const usageToggle = usageRegion.getByRole('button', { name: /per-day breakdown/ });
  await expect(usageToggle).toHaveAttribute('aria-expanded', 'false');
  await usageToggle.click();
  await expect(usageToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(usageRegion.getByText('2026-06-14')).toBeVisible();

  // --- Ready Issues: dispatchable (#22) sorts above the PR-open (#11) row ---
  const issuesRegion = page.getByRole('region', { name: 'Ready Issues' });
  // Wait for the reconcile-fed openPr map to land so #11's PR link renders.
  await expect(issuesRegion.getByRole('link', { name: /PR #911 open/ })).toBeVisible();
  const rows = await issuesRegion.locator('.cz-issue').all();
  expect(rows.length).toBe(2);
  await expect(rows[0]).toContainText('#22');
  await expect(rows[0]).toContainText('dispatchable now');
  await expect(rows[1]).toContainText('#11');
  await expect(rows[1]).toContainText('has an open PR');
  // Dispatch behavior unchanged: dispatchable Issue is enabled, PR-open Issue
  // has Dispatch greyed and shows the live PR link.
  await expect(rows[0].getByRole('button', { name: /Dispatch/ })).toBeEnabled();
  await expect(rows[1].getByRole('button', { name: /Dispatch/ })).toBeDisabled();
});
