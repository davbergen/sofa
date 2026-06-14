import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Issue #116 — one Active Project at a time via a left Project Rail (ADR 0009).
// Opening multiple Projects lists them all in the rail with exactly one marked
// Active, only the Active Project's dashboard renders in the main pane, and
// clicking another rail entry swaps which dashboard is mounted.
test('Project Rail: open multiple, exactly one Active, switching swaps the dashboard', async ({
  page,
}) => {
  const dirA = mkdtempSync(join(tmpdir(), 'sofa-railA-'));
  const dirB = mkdtempSync(join(tmpdir(), 'sofa-railB-'));
  const nameA = basename(dirA);
  const nameB = basename(dirB);

  // Empty supporting data so each dashboard renders cleanly.
  await page.route(/\/api\/projects\/\d+\/issues$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
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

  await page.goto('/');

  // Open Project A from the rail's open form.
  await page.getByLabel('Project directory').fill(dirA);
  await page.getByRole('button', { name: 'Open Project' }).click();

  // Open Project B from the same form.
  await page.getByLabel('Project directory').fill(dirB);
  await page.getByRole('button', { name: 'Open Project' }).click();

  const rail = page.getByRole('complementary', { name: 'Project Rail' });
  await expect(rail).toBeVisible();

  // Both Projects appear in the rail.
  const tabA = rail.getByRole('tab', { name: new RegExp(`^Project ${nameA}`) });
  const tabB = rail.getByRole('tab', { name: new RegExp(`^Project ${nameB}`) });
  await expect(tabA).toBeVisible();
  await expect(tabB).toBeVisible();

  // The most recently opened Project is Active; the other is not.
  await expect(tabB).toHaveAttribute('aria-selected', 'true');
  await expect(tabA).toHaveAttribute('aria-selected', 'false');

  // Exactly one Composer is rendered in the main pane, and it belongs to the
  // Active Project (B). Two stacked dashboards is the explicit no-go (ADR 0009).
  const composers = page.getByRole('form', {
    name: 'Start a Grilling Session or Session',
  });
  await expect(composers).toHaveCount(1);

  // Clicking A in the rail makes A Active and the main pane swaps to it.
  await tabA.click();
  await expect(tabA).toHaveAttribute('aria-selected', 'true');
  await expect(tabB).toHaveAttribute('aria-selected', 'false');
  await expect(composers).toHaveCount(1);

  // Switching does not list any second dashboard alongside the Active one.
  const dashboards = page.getByRole('region', { name: 'Ready Issues' });
  await expect(dashboards).toHaveCount(1);
});
