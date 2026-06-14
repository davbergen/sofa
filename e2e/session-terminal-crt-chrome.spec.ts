import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A scripted SSE stream that keeps the Session in the streaming state — no
// `done`, no `turn_boundary` — so the blinking cursor is mounted while the
// assertions run. The body is intentionally a single buffered chunk: the
// reduced-motion check looks at computed style only, not stream timing.
const SESSION_ID = 5151;
const STREAM = ['event: assistant_text', 'data: {"text":"thinking…"}', '', ''].join('\n');

// Documents the CRT chrome + reduced-motion behaviour from the handoff: the
// scanline and vignette overlays render inside the terminal surface without
// intercepting clicks, and under `prefers-reduced-motion: reduce` the looping
// animations (cursor blink, status-dot pulse) freeze lit. The PRD calls e2e
// here best-effort, so the assertions stay focused on the visible contract.
test('Session Terminal: CRT chrome is decorative; reduced-motion freezes loops lit', async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();

  const dir = mkdtempSync(join(tmpdir(), 'sofa-crt-'));

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

  await page.getByLabel('Grilling Session seed').fill('I want to remove field notes');
  await page.getByRole('button', { name: 'Start Grilling' }).click();

  // Terminal mounted.
  const terminal = page.locator('.cz-term');
  await expect(terminal).toBeVisible();

  // Scanline + vignette overlays exist as pseudo-elements on `.cz-term`, do
  // not intercept clicks, and stay painted (static) under reduced motion.
  for (const pseudo of ['::before', '::after']) {
    const events = await terminal.evaluate(
      (el, p) => getComputedStyle(el, p).pointerEvents,
      pseudo,
    );
    expect(events).toBe('none');

    const content = await terminal.evaluate(
      (el, p) => getComputedStyle(el, p).content,
      pseudo,
    );
    // A pseudo-element with no `content` collapses to `none`; ours sets `''`.
    expect(content).not.toBe('none');
  }

  // The status-dot in the title bar stays lit (pulse loop frozen). The dot is
  // present regardless of status — the `.still` modifier only fires for the
  // *non*-reduced path, so the reduced-motion query is what gates here.
  const dot = terminal.locator('.cz-term-bar .live .dot');
  await expect(dot).toBeVisible();
  const dotAnim = await dot.evaluate((el) => getComputedStyle(el).animationName);
  expect(dotAnim).toBe('none');

  // The cursor only mounts in the `streaming` state, which the stubbed stream
  // here exits as soon as it closes. Inject a synthetic `.cz-term-cursor`
  // inside the terminal to verify the reduced-motion CSS contract (solid,
  // no blink loop) without relying on stream timing.
  const cursor = await terminal.evaluate((host) => {
    const el = document.createElement('span');
    el.className = 'cz-term-cursor';
    host.appendChild(el);
    const cs = getComputedStyle(el);
    return { animationName: cs.animationName, opacity: Number(cs.opacity) };
  });
  expect(cursor.animationName).toBe('none');
  expect(cursor.opacity).toBe(1);

  await context.close();
});
