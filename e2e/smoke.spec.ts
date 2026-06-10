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

  const list = page.getByRole('list');
  await expect(list.getByText(basename(dir), { exact: true })).toBeVisible();
  await expect(list.getByText(dir, { exact: true })).toBeVisible();
});
