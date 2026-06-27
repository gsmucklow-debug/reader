'use strict';
// Bookshelf view: renders cover tiles into the active + finished shelves, with a
// title-card fallback for cover-less books. DOM-only; app.js injects the callbacks.
(function () {
  const emptyEl = document.getElementById('library-empty');
  const activeShelf = document.getElementById('shelf-active');
  const finishedShelf = document.getElementById('shelf-finished');
  const activeTitle = document.getElementById('active-title');
  const finishedTitle = document.getElementById('finished-title');

  // NOTE: the active/finished split is computed in main (library.js splitShelf, unit-tested) and
  // passed in pre-split — do NOT re-derive it here, so the shipped split == the tested split.

  // Deterministic calm color from the title (for the title-card fallback).
  function colorFor(str) {
    let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 35% 42%)`;
  }

  async function tile(rec, cbs) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'book-tile';
    el.dataset.id = rec.id;
    const art = document.createElement('div');
    art.className = 'cover';
    const url = rec.cover ? await window.reader.libraryCoverDataUrl(rec.id, rec.cover) : null;
    if (url) {
      const img = document.createElement('img'); img.src = url; img.alt = '';
      art.appendChild(img);
    } else {
      art.classList.add('title-card');
      art.style.background = colorFor(rec.title);
      const t = document.createElement('span'); t.textContent = rec.title; art.appendChild(t);
    }
    const cap = document.createElement('div'); cap.className = 'tile-title'; cap.textContent = rec.title;
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'tile-remove'; del.title = 'Remove from library';
    del.setAttribute('aria-label', `Remove ${rec.title}`); del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); cbs.onRemove(rec); });
    el.addEventListener('click', () => cbs.onOpen(rec));
    el.append(art, cap, del);
    return el;
  }

  // active + finished arrive PRE-SPLIT from main (library.js splitShelf, the tested logic).
  async function render(active, finished, cbs) {
    activeShelf.innerHTML = ''; finishedShelf.innerHTML = '';
    const total = active.length + finished.length;
    emptyEl.hidden = total > 0;
    activeTitle.hidden = active.length === 0;
    finishedTitle.hidden = finished.length === 0;
    for (const r of active) activeShelf.appendChild(await tile(r, cbs));
    for (const r of finished) finishedShelf.appendChild(await tile(r, cbs));
  }

  function show() { document.body.dataset.screen = 'library'; }
  function hide() { document.body.dataset.screen = 'reader'; }

  globalThis.ReaderLibrary = { render, show, hide };
})();
