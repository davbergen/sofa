import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Extends the grilling-hero.spec.ts route-stub pattern. The idle launcher and
// the empty Session Terminal both feed the same `/sessions` POST, so the
// assertions can run without a real grilling agent — one stub captures the
// payload whichever path launched the Session.
const SESSION_ID = 4321;

test('Idle launcher is terminal-styled and the empty terminal launches a Session on first Enter', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sofa-launcher-'));

  await page.goto('/');
  await page.getByLabel('Project directory').fill(dir);
  await page.getByRole('button', { name: 'Open Project' }).click();

  // Idle launcher renders as a terminal prompt: the merged Composer toggle
  // is the terminal-style Grill/Session row, the seed input is the
  // mono-styled prompt line, and an Open terminal control sits beside the
  // Start button to enter the full empty terminal layout.
  const grillTab = page.getByRole('radio', { name: /Grill/ });
  await expect(grillTab).toBeVisible();
  await expect(grillTab).toHaveAttribute('aria-checked', 'true');
  const seed = page.getByLabel('Grilling Session seed');
  await expect(seed).toBeVisible();
  await expect(seed).toHaveClass(/mono/);
  const openTerminal = page.getByRole('button', { name: /Open terminal/ });
  await expect(openTerminal).toBeVisible();

  // Stub the Session create + its event stream so the assertions run without
  // spawning a real grilling agent.
  let captured: { prompt?: string; skill?: string } | null = null;
  await page.route(/\/api\/projects\/\d+\/sessions$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    captured = route.request().postDataJSON() as { prompt?: string; skill?: string };
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: SESSION_ID }),
    });
  });
  await page.route(new RegExp(`/api/sessions/${SESSION_ID}/events$`), (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }),
  );

  // Open terminal morphs the Active Project pane into the empty terminal
  // layout: idle BOOT line + "idle" launcher statusline + dashboard in the
  // side rail (Ready Issues stays one click away).
  await openTerminal.click();
  const idle = page.locator('[aria-label="Idle terminal launcher"]');
  await expect(idle).toBeVisible();
  await expect(page.getByText(/idle — Grill mode/)).toBeVisible();
  const launcherStatusline = page.getByRole('status', { name: 'Launcher statusline' });
  await expect(launcherStatusline).toContainText('idle');
  await expect(launcherStatusline).toContainText('Grill');
  // Dashboard is one click away in the side rail — its Ready Issues card is
  // mounted (the request the dashboard makes on render is the cheap way to
  // observe it without depending on backend state).
  await expect(page.locator('[aria-label="Ready Issues"]')).toBeVisible();

  // The user can sit in the empty terminal indefinitely without launching —
  // no /sessions POST has fired yet.
  expect(captured).toBeNull();

  // Typing a first line and pressing Enter launches the Session in place via
  // the existing start-Session flow, sending the correct skill per mode.
  const launcherInput = page.getByLabel('Grilling Session seed');
  await launcherInput.fill('clean up the launcher');
  await launcherInput.press('Enter');

  await expect.poll(() => captured).not.toBeNull();
  expect(captured).toEqual({ prompt: 'clean up the launcher', skill: 'grill-with-docs' });

  // The terminal stays in place and morphs into the live Session — the
  // End session control replaces the idle Close affordance.
  await expect(page.getByRole('button', { name: /End session/ })).toBeVisible();
});
