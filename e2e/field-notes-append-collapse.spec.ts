import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Issue #119 — Field Notes: inline manual append + acted-collapse.
//
// Two assertions in one slice:
//   1. Typing into the inline "add Item" input and submitting POSTs to the
//      append endpoint and the new Item appears as a normal unacted Item with
//      its full action row.
//   2. An acted Item (Filed or Grilled) renders as a one-liner: its tag and
//      Issue/Session link are present, its action row (Grill / Create Issue)
//      is gone.
test('Field Notes: inline append adds a normal Item; acted Items collapse to a one-liner', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-fn119-'));

  // Two Items: one acted (Filed) — should collapse — and one fresh — should
  // show its full action row. The fresh one is also the one we'll later
  // assert against once the inline append fires.
  const initialNotes = {
    hasNote: true,
    items: [
      {
        id: 11,
        text: 'already filed',
        acted: true,
        action: 'issue',
        sessionId: null,
        issueNumber: 42,
        issueUrl: 'https://example.test/issues/42',
      },
      {
        id: 12,
        text: 'still pending',
        acted: false,
        action: null,
        sessionId: null,
        issueNumber: null,
        issueUrl: null,
      },
    ],
  };

  const appendedNotes = {
    hasNote: true,
    items: [
      ...initialNotes.items,
      {
        id: 13,
        text: 'typed inline',
        acted: false,
        action: null,
        sessionId: null,
        issueNumber: null,
        issueUrl: null,
      },
    ],
  };

  await page.route(/\/api\/projects\/\d+\/issues$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(/\/api\/projects\/\d+\/runs$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(/\/api\/projects\/\d+\/reconcile$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [], issuesWithOpenPr: [] }),
    }),
  );
  await page.route(/\/api\/projects\/\d+\/usage$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ total: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 }, byDay: [], byRun: [] }),
    }),
  );
  await page.route(/\/api\/projects\/\d+\/settings$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  let appended = false;
  await page.route(/\/api\/projects\/\d+\/field-notes$/, (route) => {
    if (route.request().method() === 'POST') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(appended ? appendedNotes : initialNotes),
    });
  });

  let capturedText: string | null = null;
  await page.route(/\/api\/projects\/\d+\/field-notes\/items$/, async (route) => {
    capturedText = (route.request().postDataJSON() as { text?: string })?.text ?? null;
    appended = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(appendedNotes),
    });
  });

  await page.goto('/');
  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

  const fn = page.getByRole('region', { name: 'Field Notes' });
  await expect(fn).toBeVisible();

  // Acted Item: tag, link, and Remove are present; Grill / Create Issue are not.
  // The acted line is recognisable by its aria-label.
  const actedLine = fn.getByLabel('Acted Field Note Item');
  await expect(actedLine).toBeVisible();
  await expect(actedLine.getByText('Filed', { exact: true })).toBeVisible();
  await expect(actedLine.getByRole('link', { name: 'Issue #42' })).toHaveAttribute(
    'href',
    'https://example.test/issues/42',
  );
  await expect(actedLine.getByText('already filed')).toBeVisible();
  await expect(actedLine.getByRole('button', { name: 'Remove' })).toBeVisible();
  // The collapsed acted Item carries no Grill / Create Issue buttons.
  await expect(actedLine.getByRole('button', { name: 'Grill' })).toHaveCount(0);
  await expect(actedLine.getByRole('button', { name: 'Create Issue' })).toHaveCount(0);

  // The unacted Item still shows its full action row.
  await expect(fn.getByText('still pending')).toBeVisible();
  await expect(fn.getByRole('button', { name: 'Create Issue' })).toBeVisible();

  // Inline append: type, submit, and the new Item lands as a normal unacted
  // Item with its action row.
  const input = fn.getByLabel('New Field Note Item text');
  const submit = fn.getByRole('button', { name: 'Add Item' });
  await expect(submit).toBeDisabled();
  await input.fill('typed inline');
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect.poll(() => capturedText).toBe('typed inline');
  // The input clears so David can keep typing without an extra click.
  await expect(input).toHaveValue('');
  // The new Item shows up as a normal unacted Item — it has the Create Issue
  // button alongside the original pending one.
  await expect(fn.getByText('typed inline')).toBeVisible();
  await expect(fn.getByRole('button', { name: 'Create Issue' })).toHaveCount(2);
});
