'use strict';

// Electron GUI smoke test (run with: npm run smoke).
// Phase 1.5: proves the window opens, the real load path renders addressable
// sentence spans, pagination flips real pages, all three view modes work, the
// TOC jumps chapters, the font switcher re-paginates, and comfort settings
// survive an app restart. Not part of `npm test` — needs a display + electron.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'alice.epub');
const SHOTS = path.join(ROOT, 'test', 'smoke', 'screenshots');

// Isolate settings.json to a throwaway userData dir so the test neither reads
// nor clobbers the real user's saved comfort settings.
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-smoke-'));

function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // else electron acts as plain node (no GUI)
  return electron.launch({ args: [ROOT, `--user-data-dir=${USERDATA}`], env });
}

async function dropBook(win) {
  const b64 = fs.readFileSync(FIXTURE).toString('base64');
  await win.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'alice.epub', { type: 'application/epub+zip' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    );
  }, b64);
  await win.waitForSelector('#reading span.sentence', { timeout: 20000 });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // 1. Window opens to the calm empty state.
  assert.strictEqual(await win.title(), 'Reader');
  assert.ok(await win.isVisible('#empty-state'), 'empty state should show on launch');
  await win.screenshot({ path: path.join(SHOTS, '1-empty.png') });

  // 2. Real drag-and-drop path renders addressable spans (Phase 1 contract).
  await dropBook(win);
  const stats = await win.evaluate(() => ({
    title: document.title,
    spans: document.querySelectorAll('span.sentence').length,
    firstHasIndices: !!document.querySelector(
      'span.sentence[data-chapter="0"][data-paragraph="0"][data-sentence="0"]'
    ),
    emptyHidden: document.getElementById('empty-state').hidden,
    viewportVisible: !document.getElementById('reading-viewport').hidden,
  }));
  assert.ok(stats.viewportVisible, 'drop should reveal the reading viewport');
  assert.ok(stats.emptyHidden, 'drop should hide the empty state');
  assert.ok(stats.title.includes('Alice'), `document.title was "${stats.title}"`);
  // Only the CURRENT chapter is mounted now (Phase 1.5), so the count is per-chapter.
  assert.ok(stats.spans > 0, `expected sentence spans in chapter 1, got ${stats.spans}`);
  assert.ok(stats.firstHasIndices, 'first sentence must carry data-* indices');
  await win.screenshot({ path: path.join(SHOTS, '2-loaded.png') });

  // 3. AC#1 — single-page pagination flips real pages with ← / →. The orientation
  //    strip changes on every flip (page within a chapter, or rolling to the next
  //    chapter's first page).
  const read = () => win.evaluate(() => ({
    view: document.body.dataset.view,
    orient: document.getElementById('orientation').textContent,
    transform: document.getElementById('reading').style.transform,
  }));
  const before = await read();
  assert.match(before.orient, /Chapter 1 of \d+ . Page 1 \/ \d+/, `orient was "${before.orient}"`);
  await win.locator('body').click({ position: { x: 5, y: 5 } }); // ensure body focus
  await win.keyboard.press('ArrowRight');
  await win.waitForTimeout(250);
  const afterFwd = await read();
  assert.notStrictEqual(afterFwd.orient, before.orient, 'ArrowRight must change the page/chapter');
  await win.keyboard.press('ArrowLeft');
  await win.waitForTimeout(250);
  const afterBack = await read();
  assert.strictEqual(afterBack.orient, before.orient, 'ArrowLeft must return to the start');

  // AC#1 cross-chapter roll: flipping past the last page lands on the NEXT
  // chapter's first page; ← on page 1 lands on the PREVIOUS chapter's last page.
  await win.keyboard.press('End');            // chapter 1, last page (2/2)
  await win.waitForTimeout(180);
  await win.keyboard.press('ArrowRight');     // roll forward into chapter 2
  await win.waitForTimeout(280);
  const rolled = await read();
  assert.match(rolled.orient, /Chapter 2 of 13 . Page 1 \//, `roll forward landed "${rolled.orient}"`);
  await win.keyboard.press('ArrowLeft');       // roll back to chapter 1's last page
  await win.waitForTimeout(280);
  const rolledBack = await read();
  assert.match(rolledBack.orient, /Chapter 1 of 13 . Page 2 \/ 2/, `roll back landed "${rolledBack.orient}"`);

  // 4. AC#2 / AC#3 — cycle all three view modes without crashing.
  await win.click('#view-toggle button[data-view="two"]');
  await win.waitForTimeout(150);
  const two = await read();
  assert.strictEqual(two.view, 'two', 'two-page mode should be active');
  assert.match(two.orient, /Page \d+ \/ \d+/, 'two-page mode still reports pages');
  await win.screenshot({ path: path.join(SHOTS, '5-two-page.png') });

  await win.click('#view-toggle button[data-view="continuous"]');
  await win.waitForTimeout(150);
  const scroll = await read();
  assert.strictEqual(scroll.view, 'continuous', 'scroll mode should be active');
  assert.ok(!/Page/.test(scroll.orient), 'scroll mode shows no page count');

  await win.click('#view-toggle button[data-view="single"]');
  await win.waitForTimeout(150);
  assert.strictEqual((await read()).view, 'single', 'back to single');

  // 4b. Pagination integrity (single mode): no page is blank and the chapter's
  //     last sentence lands on the last page — catches both an over-count (ceil
  //     adds an empty trailing page) and an under-count (round drops the tail).
  const integrity = async () => {
    await win.keyboard.press('Home');
    await win.waitForTimeout(220);
    const onFirst = await win.evaluate(visibleText);
    await win.keyboard.press('End');
    await win.waitForTimeout(220);
    return win.evaluate(visibleText);
  };
  // helper evaluated in-page: is any sentence span visible inside the viewport,
  // and is the DOM-last span of the chapter visible on the current page?
  const visibleText = function () {
    const vp = document.getElementById('reading-viewport');
    const vr = vp.getBoundingClientRect();
    const spans = document.querySelectorAll('#reading span.sentence');
    const within = (r) => r.width > 0 && r.height > 0 && r.left >= vr.left - 2 && r.right <= vr.right + 2;
    let anyVisible = false;
    for (const s of spans) { if (within(s.getBoundingClientRect())) { anyVisible = true; break; } }
    const last = spans[spans.length - 1];
    return {
      pages: document.getElementById('orientation').textContent,
      anyVisible,
      lastSpanVisible: last ? within(last.getBoundingClientRect()) : false,
    };
  };
  // chapter 1 already has 2 pages; also sample a content-rich middle chapter.
  await win.evaluate(() => { for (let i = 0; i < 200; i++) document.getElementById('prev-chapter').click(); });
  await win.waitForTimeout(150);
  let integ = await integrity();
  assert.ok(integ.anyVisible, `last page of chapter 1 is blank (over-count): ${integ.pages}`);
  assert.ok(integ.lastSpanVisible, `chapter 1 last sentence cut off (under-count): ${integ.pages}`);

  await win.evaluate(() => { document.getElementById('next-chapter').click(); document.getElementById('next-chapter').click(); document.getElementById('next-chapter').click(); });
  await win.waitForTimeout(200);
  integ = await integrity();
  assert.ok(integ.anyVisible, `last page of chapter 4 is blank (over-count): ${integ.pages}`);
  assert.ok(integ.lastSpanVisible, `chapter 4 last sentence cut off (under-count): ${integ.pages}`);

  // 5. AC#4 — TOC opens, jumps to a chapter, and closes.
  await win.click('#toc-btn');
  await win.waitForTimeout(250);
  assert.ok(
    await win.evaluate(() => document.getElementById('toc-panel').classList.contains('open')),
    'TOC panel should open'
  );
  const tocInfo = await win.evaluate(() => {
    const items = [...document.querySelectorAll('#toc-list li')];
    return { count: items.length, titles: items.map((li) => li.textContent) };
  });
  const chapterCount = tocInfo.count;
  assert.ok(chapterCount >= 2, `expected several chapters in TOC, got ${chapterCount}`);
  // Real chapter titles must come through (from the EPUB nav/ncx), not all "Untitled".
  assert.ok(
    tocInfo.titles.some((t) => /Rabbit-Hole|Pool of Tears|CHAPTER/i.test(t)),
    `TOC should show real chapter titles, got: ${JSON.stringify(tocInfo.titles.slice(0, 5))}`
  );
  await win.evaluate(() => {
    const items = document.querySelectorAll('#toc-list li');
    items[items.length - 1].click(); // jump to the last chapter
  });
  await win.waitForTimeout(300);
  const jumped = await read();
  assert.match(jumped.orient, new RegExp(`Chapter ${chapterCount} of ${chapterCount}`),
    `TOC jump should land on the last chapter, orient was "${jumped.orient}"`);
  assert.ok(
    !(await win.evaluate(() => document.getElementById('toc-panel').classList.contains('open'))),
    'TOC should close after a jump'
  );
  // back to chapter 1 for the font test (prev-chapter disables itself at ch.1)
  await win.evaluate(() => { for (let i = 0; i < 200; i++) document.getElementById('prev-chapter').click(); });
  await win.waitForTimeout(200);

  // 6. AC#5 — font switch applies a bundled family, the font actually loads
  //    (offline), and the page is re-paginated; spans stay addressable.
  await win.click('#settings-btn');
  await win.click('#font-list button[data-family="Inter"]');
  await win.waitForTimeout(300);
  const fontState = await win.evaluate(() => ({
    cssVar: getComputedStyle(document.documentElement).getPropertyValue('--reading-font'),
    applied: getComputedStyle(document.getElementById('reading')).fontFamily,
    loaded: document.fonts.check('1em "Inter"'),
    spanStillThere: !!document.querySelector('#reading span.sentence[data-chapter]'),
    orient: document.getElementById('orientation').textContent,
  }));
  assert.match(fontState.cssVar, /Inter/, 'reading font var should switch to Inter');
  assert.match(fontState.applied, /Inter/, 'computed reading font-family should be Inter');
  assert.ok(fontState.loaded, 'Inter woff2 must actually load from the bundled file (offline)');
  assert.ok(fontState.spanStillThere, 'sentence spans must remain addressable after re-paginating');
  assert.match(fontState.orient, /Page \d+ \/ \d+/, 'still paginated after font change');

  // 7. Phase 2 seams resolve against the current chapter.
  const seam = await win.evaluate(() => {
    const el = window.highlightSentence(0, 0, 0);
    window.goToPageContaining(el); // must not throw
    return el ? el.textContent.slice(0, 30) : null;
  });
  assert.ok(seam, 'highlightSentence(0,0,0) should find a span in the current chapter');

  // 8. AC#6 — set ALL comfort prefs to NON-DEFAULT values, then prove every one
  //    survives a restart (defaults would pass a weaker test trivially).
  await win.click('#theme-toggle button[data-theme="dark"]');
  await win.click('#view-toggle button[data-view="two"]');
  await win.click('#font-larger');   // 20 -> 22
  await win.click('#font-larger');   // 22 -> 24
  await win.evaluate(() => {
    const r = document.getElementById('width-range');
    r.value = '60';                  // non-default page width
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.waitForTimeout(700); // let the debounced save + IPC write settings.json
  await win.screenshot({ path: path.join(SHOTS, '3-dark-single.png') });
  await app.close();

  assert.ok(fs.existsSync(path.join(USERDATA, 'settings.json')), 'settings.json should be written');

  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(300); // settings load is async on boot
  const persisted = await win.evaluate(() => ({
    theme: document.body.dataset.theme,
    view: document.body.dataset.view,
    font: getComputedStyle(document.documentElement).getPropertyValue('--reading-font'),
    size: getComputedStyle(document.documentElement).getPropertyValue('--reading-font-size').trim(),
    width: getComputedStyle(document.documentElement).getPropertyValue('--reading-max-width').trim(),
    range: document.getElementById('width-range').value,
  }));
  assert.strictEqual(persisted.theme, 'dark', 'theme should persist across restart');
  assert.strictEqual(persisted.view, 'two', 'view mode should persist across restart');
  assert.match(persisted.font, /Inter/, 'font should persist across restart');
  assert.strictEqual(persisted.size, '24px', 'text size should persist across restart');
  assert.strictEqual(persisted.range, '60', 'page width should persist across restart');
  assert.strictEqual(persisted.width, '60rem', 'page width var should persist across restart');
  await app.close();

  console.log('SMOKE OK:', JSON.stringify(stats),
    '| flip', JSON.stringify({ before: before.orient, fwd: afterFwd.orient }),
    '| font', JSON.stringify(fontState.loaded),
    '| persisted', JSON.stringify(persisted));
})().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
