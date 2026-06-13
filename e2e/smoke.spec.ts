import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

test('open a Project from the UI and see it listed', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-smoke-'));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sofa' })).toBeVisible();

  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

  // The Project renders as its own block with its name and path.
  await expect(page.getByText(basename(dir), { exact: true })).toBeVisible();
  await expect(page.getByText(dir, { exact: true })).toBeVisible();

  // Its dashboard is expanded by default, so the three factory-floor panels
  // are reachable by their accessible names without expanding anything.
  await expect(page.getByRole('region', { name: 'Ready Issues' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Worker Runs' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Token Usage' })).toBeVisible();
});
