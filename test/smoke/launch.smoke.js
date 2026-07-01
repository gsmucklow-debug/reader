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
const { clipKey } = require('../../src/main/clip-cache');

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

async function dropFile(win, fixturePath, fileName, mime) {
  const b64 = fs.readFileSync(fixturePath).toString('base64');
  await win.evaluate(({ b64, fileName, mime }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], fileName, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    );
  }, { b64, fileName, mime });
  await win.waitForSelector('#reading span.sentence', { timeout: 20000 });
}

async function dropBook(win) {
  return dropFile(win, FIXTURE, 'alice.epub', 'application/epub+zip');
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Capture renderer console errors to surface them in smoke output.
  win.on('console', (msg) => {
    if (msg.type() === 'error') console.error('  [renderer]', msg.text());
  });

  // 1. App opens to the library home screen (Phase 3). On first run, no books yet.
  assert.strictEqual(await win.title(), 'Reader');
  // showLibrary() renders the empty state immediately (no IPC wait), so the card
  // appears almost at once. waitForFunction checks the JS attribute, not CSS visibility.
  // showLibrary() renders the empty state immediately (no IPC wait), so the card
  // appears almost at once. waitForFunction checks the JS attribute, not CSS visibility.
  await win.waitForFunction(() => {
    const el = document.getElementById('library-empty');
    return el && !el.hidden;
  }, null, { timeout: 5000 });
  assert.ok(
    await win.evaluate(() => document.body.dataset.screen === 'library'),
    'app should open to the library screen'
  );
  await win.screenshot({ path: path.join(SHOTS, '1-empty.png') });

  // 2. Real drag-and-drop path adds the book to the library and opens the reader.
  //    Now routes through addAndOpen → libraryAdd → openFromLibrary → showDocument.
  await dropBook(win);
  const stats = await win.evaluate(() => ({
    title: document.title,
    spans: document.querySelectorAll('span.sentence').length,
    firstHasIndices: !!document.querySelector(
      'span.sentence[data-chapter="0"][data-paragraph="0"][data-sentence="0"]'
    ),
    viewportVisible: !document.getElementById('reading-viewport').hidden,
    screen: document.body.dataset.screen,
  }));
  assert.ok(stats.viewportVisible, 'drop should reveal the reading viewport');
  assert.strictEqual(stats.screen, 'reader', 'drop should switch to the reader screen');
  assert.ok(stats.title.includes('Alice'), `document.title was "${stats.title}"`);
  // Only the CURRENT chapter is mounted now (Phase 1.5), so the count is per-chapter.
  assert.ok(stats.spans > 0, `expected sentence spans in chapter 1, got ${stats.spans}`);
  assert.ok(stats.firstHasIndices, 'first sentence must carry data-* indices');
  await win.screenshot({ path: path.join(SHOTS, '2-loaded.png') });

  // 2b. Phase 2.6 — the comfort popover is split into two mutually-exclusive
  //     popovers: "Aa" → Comfort, "Voice" → Voice. Opening one closes the other;
  //     Esc closes whichever is open.
  const popState = () => win.evaluate(() => ({
    comfort: !document.getElementById('comfort-panel').hidden,
    voice: !document.getElementById('voice-panel').hidden,
  }));
  await win.click('#settings-btn');
  let pop = await popState();
  assert.ok(pop.comfort && !pop.voice, 'Aa opens Comfort only');
  await win.click('#voice-btn');
  pop = await popState();
  assert.ok(pop.voice && !pop.comfort, 'Voice opens Voice only; opening it closes Comfort');
  await win.keyboard.press('Escape');
  pop = await popState();
  assert.ok(!pop.comfort && !pop.voice, 'Escape closes whichever popover is open');

  // 2c. Phase 2.6 — a heading is an addressable, narratable span (an <hN> that
  //     CONTAINS a sentence span), and the old injected, never-read chapter-title
  //     heading is gone everywhere.
  const headingInfo = await win.evaluate(() => {
    const h = document.querySelector(
      'h2.chapter-heading span.sentence[data-chapter][data-paragraph][data-sentence]'
    );
    return {
      hasHeadingSpan: !!h,
      headingText: h ? h.textContent.slice(0, 40) : null,
      oldTitleCount: document.querySelectorAll('h2.chapter-title').length,
    };
  });
  assert.ok(headingInfo.hasHeadingSpan,
    'a heading must render as an addressable, narratable sentence span');
  assert.strictEqual(headingInfo.oldTitleCount, 0,
    'no injected chapter-title heading should exist anywhere');
  console.log('  ✓ heading is a narratable span:', JSON.stringify(headingInfo.headingText));

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
  await win.keyboard.press('End');            // chapter 1, last page
  await win.waitForTimeout(180);
  // Capture ch1's last-page orientation rather than hardcoding "Page 2 / 2": the
  // front-matter chapter's page count depends on how its headings lay out (Phase 2.6
  // renders them as sized <hN>), so this stays correct whether it's 2 or 3 pages.
  const ch1Last = (await read()).orient;
  assert.match(ch1Last, /Chapter 1 of 13 . Page \d+ \/ \d+/, `ch1 last page was "${ch1Last}"`);
  await win.keyboard.press('ArrowRight');     // roll forward into chapter 2
  await win.waitForTimeout(280);
  const rolled = await read();
  assert.match(rolled.orient, /Chapter 2 of 13 . Page 1 \//, `roll forward landed "${rolled.orient}"`);
  await win.keyboard.press('ArrowLeft');       // roll back to chapter 1's last page
  await win.waitForTimeout(280);
  const rolledBack = await read();
  assert.strictEqual(rolledBack.orient, ch1Last, `roll back should land on ch1's last page, got "${rolledBack.orient}"`);

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

  // 7b. Phase 2 — narration engages and ADVANCES through the REAL engine.
  //     Manual-listen checklist (voice quality, sync by ear, offline-in-exe) lives
  //     in HOW-TO-RUN.md — Playwright can't hear audio, so this asserts the DOM
  //     mechanism only: press Play → real IPC → utilityProcess → decode → play →
  //     .is-reading lands on the first sentence → clip ends → highlight advances.
  //     Long timeouts: the first clip includes Kokoro model warm-up.
  await win.click('#play-pause');
  await win.waitForSelector('.sentence.is-reading', { timeout: 60000 }); // first clip is slow (model warm-up)
  const firstReading = await win.evaluate(() => {
    const el = document.querySelector('.sentence.is-reading');
    return `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}`;
  });
  // Phase 2.6 — the play button shows the pause shape (.is-playing) while narrating.
  assert.ok(
    await win.evaluate(() => document.getElementById('play-pause').classList.contains('is-playing')),
    '#play-pause should carry .is-playing while narration is running'
  );
  // Highlight must move to a DIFFERENT sentence — proves clip-ended → advance
  // through the real engine, not just a one-shot highlight of the first sentence.
  await win.waitForFunction((prev) => {
    const el = document.querySelector('.sentence.is-reading');
    return el && `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` !== prev;
  }, firstReading, { timeout: 120000 });
  const secondReading = await win.evaluate(() => {
    const el = document.querySelector('.sentence.is-reading');
    return el ? `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` : null;
  });
  assert.ok(secondReading && secondReading !== firstReading,
    `highlight should advance off the first sentence (${firstReading} -> ${secondReading})`);
  console.log('  ✓ narration highlight engaged and advanced', `(${firstReading} -> ${secondReading})`);

  // 7c. Phase 2.5 — switching the voice mid-narration keeps narration playing and
  //     marks the new voice active. Phase 2.6 moved the voice controls into the Voice
  //     popover, so open it first (clicking #play-pause in 7b closed any popover).
  //     reload() never flips `playing`, and markActiveVoice() runs synchronously in the
  //     click handler, so these hold regardless of when the async re-synth lands.
  //     (window.reader is a frozen contextBridge object, so a synthesize spy can't
  //     install — the voice-SPECIFIC engine proof lives in 7d via an on-disk clip.)
  await win.click('#voice-btn');
  await win.waitForSelector('#voice-list .voice-pick[data-voice="bm_george"]');
  await win.click('#voice-list .voice-pick[data-voice="bm_george"]');
  const afterVoice = await win.evaluate(() => ({
    activeVoice: document.querySelector('.voice-pick.active')?.dataset.voice,
    playing: document.getElementById('play-pause').getAttribute('aria-label') === 'Pause',
    hasHighlight: !!document.querySelector('.sentence.is-reading'),
  }));
  assert.strictEqual(afterVoice.activeVoice, 'bm_george', 'picked voice should be marked active');
  assert.ok(afterVoice.playing, 'narration should keep playing after a voice switch');
  assert.ok(afterVoice.hasHighlight, 'a sentence should still be highlighted after the switch');
  console.log('  ✓ voice switch kept narration playing, marked new voice active (bm_george)');

  // 7d. ▶ preview synthesizes a sample in the previewed voice through the REAL engine.
  //     Deterministic + voice-specific: the preview text is fixed and speed is still 1
  //     here (section 8 sets 1.25 later), so we know the EXACT cache filename. Assert it
  //     is absent (fresh tmpdir), click ▶, then poll the clips dir until it appears.
  //     The SAMPLE_TEXT literal mirrors app.js previewVoice() — keep them in sync.
  const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog.';
  const clipsDir = path.join(USERDATA, 'clips');
  const previewFile = clipKey(SAMPLE_TEXT, 'af_bella', 1);
  const has = (f) => fs.existsSync(clipsDir) && fs.readdirSync(clipsDir).includes(f);
  assert.ok(!has(previewFile), 'preview clip should not exist before clicking ▶ (fresh userData)');
  await win.click('.voice-row:has(.voice-pick[data-voice="af_bella"]) .voice-preview');
  for (let i = 0; i < 120 && !has(previewFile); i++) await win.waitForTimeout(500); // up to 60s
  assert.ok(has(previewFile), `▶ preview should synthesize an af_bella clip on disk (${previewFile})`);
  console.log('  ✓ ▶ preview synthesized an af_bella sample through the real engine');

  // Ensure narration is paused before the library loop test.
  await win.evaluate(() => {
    const b = document.getElementById('play-pause');
    if (b.getAttribute('aria-label') === 'Pause') b.click();
  });
  await win.waitForTimeout(2000); // let the 1.5s debounce + async write settle before going to library
  await win.screenshot({ path: path.join(SHOTS, '4-narrating.png') });

  // --- Phase 3: Library loop -----------------------------------------------
  // 7e. Click ← Library → shelf shows with the alice tile in the active section.
  await win.click('#library-btn');
  await win.waitForSelector('body[data-screen="library"]', { timeout: 5000 });
  const shelfAfterPause = await win.evaluate(() => ({
    screen: document.body.dataset.screen,
    activeTiles: document.querySelectorAll('#shelf-active .book-tile').length,
    finishedTiles: document.querySelectorAll('#shelf-finished .book-tile').length,
    activeHidden: document.getElementById('active-title').hidden,
  }));
  assert.strictEqual(shelfAfterPause.screen, 'library', 'Library button should return to the shelf');
  assert.ok(shelfAfterPause.activeTiles >= 1, 'alice should appear on the active shelf');
  assert.strictEqual(shelfAfterPause.finishedTiles, 0, 'not finished yet');
  assert.ok(!shelfAfterPause.activeHidden, 'Reading section header should be visible');
  console.log('  ✓ ← Library returned to shelf; alice tile visible in active section');

  // 7f. Click the alice tile → reader reopens at the ADVANCED sentence (auto-resume).
  //     The saved progress is the address from 7b (highlight advanced past 0.0.0).
  await win.click('#shelf-active .book-tile:first-child');
  await win.waitForSelector('body[data-screen="reader"]', { timeout: 5000 });
  await win.waitForSelector('.sentence.is-reading', { timeout: 10000 });
  const resumeAddr = await win.evaluate(() => {
    const el = document.querySelector('.sentence.is-reading');
    return el ? `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` : null;
  });
  assert.ok(resumeAddr !== null, 'a sentence should be highlighted on resume');
  assert.notStrictEqual(resumeAddr, '0.0.0', `resume should be past the start; got ${resumeAddr}`);
  console.log('  ✓ tile re-opened at resumed sentence:', resumeAddr, '(not 0.0.0)');

  // Resume-page accuracy check: the .is-reading span must be visible in the viewport
  // (the page flip landed correctly). Check in the current (single/two-page) mode.
  await win.waitForTimeout(500); // allow document.fonts.ready re-flip to settle
  const pageCheck = await win.evaluate(() => {
    const span = document.querySelector('.sentence.is-reading');
    if (!span) return { ok: false, reason: 'no is-reading span' };
    const vp = document.getElementById('reading-viewport');
    const vpR = vp.getBoundingClientRect();
    const sR = span.getBoundingClientRect();
    const visible = sR.width > 0 && sR.height > 0 && sR.top >= vpR.top - 10 && sR.bottom <= vpR.bottom + 10;
    return { ok: visible, view: document.body.dataset.view, addr: `${span.dataset.chapter}.${span.dataset.paragraph}.${span.dataset.sentence}` };
  });
  assert.ok(pageCheck.ok, `resumed span should be in viewport (correct page flip); view=${pageCheck.view} addr=${pageCheck.addr}`);
  console.log('  ✓ resumed span is visible in viewport (page flip correct)');

  // 7g. Remove the book (the × button, confirm the dialog), shelf becomes empty.
  // Back to library first.
  await win.click('#library-btn');
  await win.waitForSelector('body[data-screen="library"]', { timeout: 5000 });
  // Wait for the shelf to populate (showLibrary does an empty render first, then IPC).
  await win.waitForSelector('#shelf-active .book-tile', { timeout: 10000 });
  win.on('dialog', (d) => d.accept()); // auto-confirm the "Remove?" dialog
  await win.click('#shelf-active .tile-remove');
  await win.waitForTimeout(600); // let the remove + re-render settle
  const shelfAfterRemove = await win.evaluate(() => ({
    tiles: document.querySelectorAll('.book-tile').length,
    emptyShown: !document.getElementById('library-empty').hidden,
  }));
  assert.strictEqual(shelfAfterRemove.tiles, 0, 'shelf should be empty after removing alice');
  assert.ok(shelfAfterRemove.emptyShown, '#library-empty should reappear when no books remain');
  console.log('  ✓ book removed; shelf empty; library-empty visible');

  // 7h. Re-add alice; force the book to finished via IPC; shelf moves it to Finished.
  await dropBook(win);               // re-adds alice and opens reader (same library path)
  await win.waitForSelector('body[data-screen="reader"]', { timeout: 5000 });
  // Grab the book id and lastAddress from the current player/doc state.
  const bookMeta = await win.evaluate(async () => {
    const { active } = await window.reader.libraryShelf();
    const rec = active[0];
    if (!rec) return null;
    // Force progress = lastAddress so the book reads as finished.
    await window.reader.libraryUpdateProgress(rec.id, rec.lastAddress);
    return { id: rec.id, lastAddress: rec.lastAddress };
  });
  assert.ok(bookMeta, 'alice should be in the active shelf after re-add');
  await win.waitForTimeout(400);

  // Re-render the shelf; alice should now be in Finished.
  await win.click('#library-btn');
  await win.waitForSelector('body[data-screen="library"]', { timeout: 5000 });
  // Wait for shelf to populate from IPC (empty-first pattern).
  await win.waitForSelector('#shelf-finished .book-tile, #shelf-active .book-tile', { timeout: 10000 });
  const shelfFinished = await win.evaluate(() => ({
    activeTiles: document.querySelectorAll('#shelf-active .book-tile').length,
    finishedTiles: document.querySelectorAll('#shelf-finished .book-tile').length,
  }));
  assert.strictEqual(shelfFinished.activeTiles, 0, 'finished book should leave the active shelf');
  assert.strictEqual(shelfFinished.finishedTiles, 1, 'finished book should appear in the Finished section');
  console.log('  ✓ finished book moved to Finished section');

  // 7i. Opening a finished book resets progress → it returns to active shelf.
  await win.waitForSelector('#shelf-finished .book-tile', { timeout: 10000 });
  await win.click('#shelf-finished .book-tile:first-child');
  await win.waitForSelector('body[data-screen="reader"]', { timeout: 5000 });
  await win.waitForSelector('.sentence.is-reading', { timeout: 10000 });
  const restartAddr = await win.evaluate(() => {
    const el = document.querySelector('.sentence.is-reading');
    return el ? `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` : null;
  });
  assert.strictEqual(restartAddr, '0.0.0', `reopening a finished book should start at 0.0.0, got ${restartAddr}`);
  console.log('  ✓ reopening finished book restarted from 0.0.0');
  // Back to library to verify it's back in active.
  await win.click('#library-btn');
  await win.waitForSelector('body[data-screen="library"]', { timeout: 5000 });
  // Wait for shelf to populate from IPC (empty-first pattern).
  await win.waitForSelector('#shelf-active .book-tile', { timeout: 10000 });
  const shelfAfterReopen = await win.evaluate(() => ({
    activeTiles: document.querySelectorAll('#shelf-active .book-tile').length,
    finishedTiles: document.querySelectorAll('#shelf-finished .book-tile').length,
  }));
  assert.strictEqual(shelfAfterReopen.activeTiles, 1, 'reopened finished book should be back in active shelf');
  assert.strictEqual(shelfAfterReopen.finishedTiles, 0, 'Finished section should be empty again');
  console.log('  ✓ reopened finished book is back in active shelf');

  // Re-open to reader for the rest of the test (settings persistence section 8 needs the reader).
  await win.click('#shelf-active .book-tile:first-child');
  await win.waitForSelector('body[data-screen="reader"]', { timeout: 5000 });
  // ---- End of Phase 3 library loop ----------------------------------------

  // 8. AC#6 — set ALL comfort prefs to NON-DEFAULT values, then prove every one
  //    survives a restart (defaults would pass a weaker test trivially).
  //    Phase 2.6 note: the comfort vs voice controls live in SEPARATE popovers now,
  //    and a real click on a topbar/transport control closes any open popover. So do
  //    the topbar click first, then open Comfort for its controls, then Voice for its.
  await win.click('#view-toggle button[data-view="two"]');      // topbar (no panel)
  await win.click('#settings-btn');                              // open Comfort
  await win.click('#theme-toggle button[data-theme="dark"]');
  await win.click('#font-larger');   // 20 -> 22
  await win.click('#font-larger');   // 22 -> 24
  await win.evaluate(() => {
    const r = document.getElementById('width-range');
    r.value = '60';                  // non-default page width
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Phase 2.5 — non-default voice (already bm_george from 7c), speed, and pause.
  await win.click('#voice-btn');                                 // open Voice
  await win.evaluate(() => {
    const r = document.getElementById('speed-range');
    r.value = '1.25';                // non-default reading speed
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.click('#pause-toggle button[data-pause="longer"]'); // non-default end-of-chapter pause

  // Expressive GPU voice UI: the panel-open health probe (fired by the #voice-btn click
  // above) has resolved by now — wait for it to settle either way, then check the AC
  // that actually applies. This machine may or may not have a real Chatterbox server on
  // localhost:8004 (a leftover spike server), so branch on the observed state instead of
  // assuming "no server" — the important invariant is the segment's disabled state always
  // matches the health probe's result.
  await win.waitForFunction(
    () => document.getElementById('engine-hint').hidden !== undefined
      && document.querySelector('#engine-toggle button[data-engine="expressive"]').disabled
        === !document.getElementById('engine-hint').hidden,
    null, { timeout: 3000 },
  ).catch(() => {}); // best-effort settle wait; the assertions below are the real check
  const health = await win.evaluate(() => ({
    disabled: document.querySelector('#engine-toggle button[data-engine="expressive"]').disabled,
    hintHidden: document.getElementById('engine-hint').hidden,
  }));
  assert.strictEqual(health.disabled, health.hintHidden === false, 'expressive segment disabled state must match the hint visibility');
  if (health.disabled) {
    console.log('  ✓ expressive engine segment disables with a hint (no server reachable on this machine)');
  } else {
    console.log('  ✓ expressive engine segment stays enabled (a real server answered on localhost:8004)');
  }

  // Drive the engine switch via the test-only seam (mirrors how a restored persisted
  // setting would apply — applySettings sets state directly, no reload/button click) so
  // this proves the voice list / sliders / persistence regardless of server reachability
  // or whether the segment happens to be enabled on this machine.
  await win.evaluate(() => window.__test_setEngine('expressive'));
  await win.waitForSelector('#expressive-voice-section:not([hidden])', { timeout: 2000 });
  assert.ok(await win.$('#kokoro-voice-section[hidden]'), 'Kokoro voice section hides when Expressive is active');
  await win.click('#expressive-voice-list button.voice-pick[data-voice="Alice.wav"]');
  const setParam = async (id, value) => {
    await win.evaluate(({ id, value }) => {
      const r = document.getElementById(id);
      r.value = String(value);
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    }, { id, value });
  };
  await setParam('exaggeration-range', 1.1);
  await setParam('cfg-range', 0.65);
  await setParam('temperature-range', 0.9);
  await setParam('speedfactor-range', 1.3);
  console.log('  ✓ expressive engine toggle + voice + sliders render and apply in the UI');

  await win.waitForTimeout(700); // let the debounced save + IPC write settings.json
  await win.screenshot({ path: path.join(SHOTS, '3-dark-single.png') });
  await app.close();

  assert.ok(fs.existsSync(path.join(USERDATA, 'settings.json')), 'settings.json should be written');

  app = await launch();
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // Library persistence: app opens to the library and the book is still there (Phase 3 step 9).
  // showLibrary() renders empty first, then populates after IPC — wait for the tile.
  await win.waitForSelector('body[data-screen="library"]', { timeout: 5000 });
  await win.waitForSelector('.book-tile', { timeout: 10000 });
  const libraryPersisted = await win.evaluate(() => ({
    screen: document.body.dataset.screen,
    tileCount: document.querySelectorAll('.book-tile').length,
  }));
  assert.strictEqual(libraryPersisted.screen, 'library', 'app should open to library after restart');
  assert.ok(libraryPersisted.tileCount > 0, 'book should persist on shelf across a restart');
  console.log('  ✓ library persists across restart:', libraryPersisted.tileCount, 'tile(s)');
  // Re-open the book so we can check the persisted comfort settings below.
  await win.click('.book-tile:first-child');
  await win.waitForSelector('body[data-screen="reader"]', { timeout: 5000 });
  await win.waitForTimeout(300);
  const persisted = await win.evaluate(() => ({
    theme: document.body.dataset.theme,
    view: document.body.dataset.view,
    font: getComputedStyle(document.documentElement).getPropertyValue('--reading-font'),
    size: getComputedStyle(document.documentElement).getPropertyValue('--reading-font-size').trim(),
    width: getComputedStyle(document.documentElement).getPropertyValue('--reading-max-width').trim(),
    range: document.getElementById('width-range').value,
    voice: document.querySelector('.voice-pick.active')?.dataset.voice,
    speed: document.getElementById('speed-range').value,
    speedLabel: document.getElementById('speed-label').textContent,
    pause: document.querySelector('#pause-toggle button.active')?.dataset.pause,
    ttsEngine: document.getElementById('engine-toggle').querySelector('button.active')?.dataset.engine,
    expressiveSectionVisible: !document.getElementById('expressive-voice-section').hidden,
    expressiveVoice: document.getElementById('expressive-voice-list').querySelector('.voice-pick.active')?.dataset.voice,
    exaggeration: document.getElementById('exaggeration-range').value,
    cfgWeight: document.getElementById('cfg-range').value,
    temperature: document.getElementById('temperature-range').value,
    speedFactor: document.getElementById('speedfactor-range').value,
  }));
  assert.strictEqual(persisted.theme, 'dark', 'theme should persist across restart');
  assert.strictEqual(persisted.view, 'two', 'view mode should persist across restart');
  assert.match(persisted.font, /Inter/, 'font should persist across restart');
  assert.strictEqual(persisted.size, '24px', 'text size should persist across restart');
  assert.strictEqual(persisted.range, '60', 'page width should persist across restart');
  assert.strictEqual(persisted.width, '60rem', 'page width var should persist across restart');
  assert.strictEqual(persisted.voice, 'bm_george', 'voice should persist across restart');
  assert.strictEqual(persisted.speed, '1.25', 'reading speed should persist across restart');
  assert.strictEqual(persisted.speedLabel, '1.25×', 'speed label should reflect persisted value');
  assert.strictEqual(persisted.pause, 'longer', 'end-of-chapter pause should persist across restart');
  assert.strictEqual(persisted.ttsEngine, 'expressive', 'expressive engine should persist across restart');
  assert.ok(persisted.expressiveSectionVisible, 'expressive voice section should be visible after restart (engine=expressive)');
  assert.strictEqual(persisted.expressiveVoice, 'Alice.wav', 'expressive voice should persist across restart');
  assert.strictEqual(persisted.exaggeration, '1.1', 'exaggeration should persist across restart');
  assert.strictEqual(persisted.cfgWeight, '0.65', 'cfgWeight should persist across restart');
  assert.strictEqual(persisted.temperature, '0.9', 'temperature should persist across restart');
  assert.strictEqual(persisted.speedFactor, '1.3', 'speedFactor should persist across restart');
  console.log('  ✓ expressive engine/voice/sliders persist across restart');

  // --- Phase 4: Markdown reading -------------------------------------------
  await win.click('#library-btn');
  await win.waitForSelector('body[data-screen="library"]', { timeout: 5000 });
  await dropFile(
    win, path.join(ROOT, 'test', 'fixtures', 'sample.md'), 'sample.md', 'text/markdown'
  );
  await win.waitForSelector('body[data-screen="reader"]', { timeout: 5000 });

  // The first narratable span is the chapter heading itself (0.0.0).
  const mdFirst = await win.evaluate(() => {
    const el = document.querySelector('span.sentence');
    return el ? `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` : null;
  });
  assert.strictEqual(mdFirst, '0.0.0', `markdown first span should be 0.0.0, got ${mdFirst}`);

  // Narration advances through the REAL engine (same pattern as the EPUB check).
  await win.evaluate(() => document.getElementById('play-pause').click());
  await win.waitForFunction(() => {
    const el = document.querySelector('.sentence.is-reading');
    return el && `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` !== '0.0.0';
  }, null, { timeout: 30000 });
  await win.evaluate(() => {
    const b = document.getElementById('play-pause');
    if (b.getAttribute('aria-label') === 'Pause') b.click();
  });

  // The tile uses a TITLE-CARD (no embedded cover), not an <img>.
  await win.click('#library-btn');
  await win.waitForSelector('#shelf-active .book-tile', { timeout: 10000 });
  const mdTile = await win.evaluate(() => {
    const tiles = [...document.querySelectorAll('#shelf-active .book-tile')];
    const t = tiles.find((x) => (x.querySelector('.tile-title')?.textContent || '').includes('Sample'));
    return t ? { card: !!t.querySelector('.cover.title-card'), img: !!t.querySelector('.cover img') } : null;
  });
  assert.ok(mdTile && mdTile.card && !mdTile.img, 'markdown book should show a title-card, not a cover');
  console.log('  ✓ markdown (.md): title-card tile, opens, heading is 0.0.0, narration advances');

  // --- Phase 4 (part 2): DOCX reading --------------------------------------
  // The Markdown section above leaves the app on the library screen, so we drop
  // directly here (no leading #library-btn click — that is the reader-only back
  // button and would auto-wait/time out from the library screen).
  await win.waitForSelector('body[data-screen="library"]', { timeout: 5000 });
  await dropFile(
    win, path.join(ROOT, 'test', 'fixtures', 'sample.docx'), 'sample.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  await win.waitForSelector('body[data-screen="reader"]', { timeout: 5000 });

  // The first narratable span is the chapter heading itself (0.0.0).
  const docxFirst = await win.evaluate(() => {
    const el = document.querySelector('span.sentence');
    return el ? `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` : null;
  });
  assert.strictEqual(docxFirst, '0.0.0', `docx first span should be 0.0.0, got ${docxFirst}`);

  // Narration advances through the REAL engine.
  await win.evaluate(() => document.getElementById('play-pause').click());
  await win.waitForFunction(() => {
    const el = document.querySelector('.sentence.is-reading');
    return el && `${el.dataset.chapter}.${el.dataset.paragraph}.${el.dataset.sentence}` !== '0.0.0';
  }, null, { timeout: 30000 });
  await win.evaluate(() => {
    const b = document.getElementById('play-pause');
    if (b.getAttribute('aria-label') === 'Pause') b.click();
  });

  // The tile uses a TITLE-CARD (no embedded cover), not an <img>.
  await win.click('#library-btn');
  await win.waitForSelector('#shelf-active .book-tile', { timeout: 10000 });
  const docxTile = await win.evaluate(() => {
    const tiles = [...document.querySelectorAll('#shelf-active .book-tile')];
    const t = tiles.find((x) => (x.querySelector('.tile-title')?.textContent || '').includes('Sample Word'));
    return t ? { card: !!t.querySelector('.cover.title-card'), img: !!t.querySelector('.cover img') } : null;
  });
  assert.ok(docxTile && docxTile.card && !docxTile.img, 'docx book should show a title-card, not a cover');
  console.log('  ✓ docx (.docx): title-card tile, opens, heading is 0.0.0, narration advances');

  await app.close();

  console.log('SMOKE OK:', JSON.stringify(stats),
    '| flip', JSON.stringify({ before: before.orient, fwd: afterFwd.orient }),
    '| narration', JSON.stringify({ first: firstReading, advanced: secondReading }),
    '| font', JSON.stringify(fontState.loaded),
    '| persisted', JSON.stringify(persisted));
})().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
