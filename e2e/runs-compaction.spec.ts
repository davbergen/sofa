import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Issue #118 — Worker Runs compaction. A terminal Run (pr_merged) renders as a
// dense one-liner with its issue #, title, state dot, token count, and PR link,
// expanding to its frozen phase stepper on click. An active Run (working)
// alongside it stays fully rendered with its stepper and activity feed.
test('Worker Runs: terminal Run collapses to a one-liner and expands on click; active Run stays full', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-runs118-'));

  const runs = [
    {
      id: 4002,
      issue: 7,
      issueTitle: 'finished one with a PR',
      state: 'pr_merged' as const,
      prUrl: 'https://example.test/pr/7',
      failureReason: null,
      phase: 'pushing' as const,
      startedAt: '2025-01-01T00:00:00.000Z',
    },
    {
      id: 4001,
      issue: 9,
      issueTitle: 'an active worker still running',
      state: 'working' as const,
      prUrl: null,
      failureReason: null,
      phase: 'working' as const,
      startedAt: '2025-01-02T00:00:00.000Z',
    },
  ];

  await page.route(/\/api\/projects\/\d+\/issues$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(/\/api\/projects\/\d+\/runs$/, (route) => {
    if (route.request().method() === 'POST') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(runs),
    });
  });
  await page.route(/\/api\/projects\/\d+\/reconcile$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs, issuesWithOpenPr: [] }),
    }),
  );
  await page.route(/\/api\/projects\/\d+\/usage$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 12345 },
        byDay: [],
        byRun: [{ runId: 4002, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 12345 }],
      }),
    }),
  );
  await page.route(/\/api\/projects\/\d+\/field-notes$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(/\/api\/projects\/\d+\/settings$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  // Keep the activity SSE for the live Worker open with an empty body so the
  // feed mounts without crashing.
  await page.route(/\/api\/runs\/\d+\/activity$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );

  await page.goto('/');
  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

  const runsRegion = page.getByRole('region', { name: 'Worker Runs' });
  await expect(runsRegion).toBeVisible();

  // The terminal Run renders as a one-liner: its toggle button carries the
  // issue #, title, state, and token count; the PR link is right next to it.
  const expandButton = page.getByRole('button', { name: /^Expand run for issue #7$/ });
  await expect(expandButton).toBeVisible();
  await expect(expandButton).toContainText('#7');
  await expect(expandButton).toContainText('finished one with a PR');
  await expect(expandButton).toContainText('pr merged');
  await expect(expandButton).toContainText('12,345 tok');
  await expect(runsRegion.getByRole('link', { name: 'PR →' })).toHaveAttribute(
    'href',
    'https://example.test/pr/7',
  );

  // The terminal Run's stepper is not visible while collapsed — exactly one
  // stepper is on screen, and it belongs to the active Run.
  await expect(runsRegion.getByRole('group', { name: 'Worker phases' })).toHaveCount(1);

  // The active Run shows in full: its title and its activity-feed toggle are
  // both visible alongside the (only) stepper.
  await expect(runsRegion.getByText('an active worker still running')).toBeVisible();
  await expect(runsRegion.getByRole('button', { name: 'show detail' })).toBeVisible();
  // Kill is on the active Run; Remove is on the terminal Run.
  await expect(runsRegion.getByRole('button', { name: 'Kill' })).toBeVisible();
  await expect(
    runsRegion.getByRole('button', { name: 'Remove run for issue #7' }),
  ).toBeVisible();

  // Clicking the terminal row's toggle expands it: its frozen stepper now
  // renders too (two steppers on screen) and the toggle flips its accessible
  // name to Collapse.
  await expandButton.click();
  await expect(runsRegion.getByRole('group', { name: 'Worker phases' })).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: /^Collapse run for issue #7$/ }),
  ).toBeVisible();

  // Collapsing again hides the frozen stepper.
  await page.getByRole('button', { name: /^Collapse run for issue #7$/ }).click();
  await expect(runsRegion.getByRole('group', { name: 'Worker phases' })).toHaveCount(1);
});
