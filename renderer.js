const grid = document.getElementById('grid');
const loading = document.getElementById('loading');

let items = [];
let selected = 0;
let editing = false;

function beginEdit(nameEl, desktopIndex) {
  if (editing) return;
  editing = true;
  const original = nameEl.textContent;
  nameEl.classList.add('editing');
  nameEl.setAttribute('contenteditable', 'plaintext-only');
  nameEl.spellcheck = false;
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = async (commit) => {
    if (!editing) return;
    editing = false;
    nameEl.removeAttribute('contenteditable');
    nameEl.classList.remove('editing');
    window.getSelection().removeAllRanges();
    const newName = nameEl.textContent.replace(/[\r\n]/g, '').trim();
    if (!commit || !newName || newName === original) {
      nameEl.textContent = original;
      return;
    }
    nameEl.textContent = newName;
    try { await window.api.rename(desktopIndex, newName); } catch (e) {}
  };

  const onKey = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); nameEl.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); editing = false; nameEl.textContent = original; nameEl.blur(); }
    ev.stopPropagation();
  };
  nameEl.addEventListener('keydown', onKey);
  nameEl.addEventListener('blur', () => {
    nameEl.removeEventListener('keydown', onKey);
    finish(true);
  }, { once: true });
}

function chooseCols(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  if (n <= 16) return 4;
  return 5;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render(data) {
  const tiles = data.tiles;
  selected = data.current >= 0 ? data.current : 0;
  grid.style.setProperty('--cols', chooseCols(tiles.length + 1));
  grid.innerHTML = '';
  items = [];

  tiles.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'tile' + (t.current ? ' current' : '');
    el.innerHTML = `
      <div class="name" title="Click to rename">${escapeHtml(t.name)}</div>
      <div class="thumb">
        ${t.image ? `<img src="${t.image}" alt="" />` : ''}
        <div class="current-badge">CURRENT</div>
        <button class="tile-delete" title="Delete this desktop" aria-label="Delete desktop">×</button>
      </div>
    `;
    const nameEl = el.querySelector('.name');
    const thumbEl = el.querySelector('.thumb');
    const delBtn = el.querySelector('.tile-delete');
    nameEl.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selected = i; updateSelection();
      beginEdit(nameEl, t.index);
    });
    thumbEl.addEventListener('click', (ev) => {
      if (ev.target.closest('.tile-delete')) return;
      ev.stopPropagation();
      selected = i; updateSelection();
      activate(i);
    });
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      askDeleteDesktop(t.index, t.name);
    });
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      selected = i; updateSelection();
      openFxModal(t.index, t.name);
    });
    grid.appendChild(el);
    items.push({ el, kind: 'desktop', index: t.index, nameEl });
  });

  const plus = document.createElement('div');
  plus.className = 'tile plus';
  plus.innerHTML = `
    <div class="name">New Desktop</div>
    <div class="thumb"><div class="sign">+</div></div>
  `;
  plus.addEventListener('click', () => activatePlus());
  grid.appendChild(plus);
  items.push({ el: plus, kind: 'plus' });

  loading.classList.add('hidden');
  updateSelection();
  reapplyAllEffects();
}

function updateSelection() {
  items.forEach((it, i) => it.el.classList.toggle('selected', i === selected));
  const cur = items[selected];
  if (cur) cur.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function move(dx, dy) {
  const cols = parseInt(getComputedStyle(grid).getPropertyValue('--cols')) || 1;
  const n = items.length;
  let next = selected + dx + dy * cols;
  if (next < 0) next = 0;
  if (next >= n) next = n - 1;
  selected = next;
  updateSelection();
}

async function activate(i) {
  const it = items[i];
  if (!it) return;
  if (it.kind === 'plus') return activatePlus();
  await window.api.goto(it.index);
}

async function activatePlus() {
  loading.textContent = 'Creating desktop…';
  loading.classList.remove('hidden');
  const data = await window.api.create();
  if (data) render(data);
  loading.classList.add('hidden');
  if (items.length >= 2) { selected = items.length - 2; updateSelection(); }
}

window.addEventListener('keydown', (e) => {
  if (editing) return;
  if (isModalOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); return; }
    if (e.key === 'Enter') { e.preventDefault(); confirmOkBtn.click(); return; }
    return;
  }
  if (e.key === 'Escape') { window.api.hide(); return; }
  if (e.key === 'Delete') {
    const it = items[selected];
    if (it && it.kind === 'desktop') {
      const t = { index: it.index, name: (it.nameEl && it.nameEl.textContent) || '' };
      askDeleteDesktop(t.index, t.name);
      e.preventDefault();
    }
    return;
  }
  if (e.key === 'F2') {
    const it = items[selected];
    if (it && it.kind === 'desktop' && it.nameEl) beginEdit(it.nameEl, it.index);
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowLeft') { move(-1, 0); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { move(1, 0); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { move(0, -1); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { move(0, 1); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === ' ') { activate(selected); e.preventDefault(); }
});

const closeBtn = document.getElementById('close-btn');
if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); window.api.quit(); });

if (window.api.onVisibility) {
  window.api.onVisibility((v) => {
    document.body.classList.toggle('hidden', !v);
    if (!v) {
      closeConfirm();
      // Pause all FX loops to stop consuming CPU while hidden
      tileFx.forEach((state) => { if (state.raf) cancelAnimationFrame(state.raf); state.raf = 0; });
    } else {
      // Resume by re-applying (simplest path)
      reapplyAllEffects();
    }
  });
}

// ---------------- Confirm modal ----------------
const confirmModal = document.getElementById('confirm-modal');
const confirmNameEl = document.getElementById('confirm-name');
const confirmOkBtn = document.getElementById('confirm-ok');
const confirmCancelBtn = document.getElementById('confirm-cancel');
let pendingDeleteIndex = null;

function askDeleteDesktop(index, name) {
  pendingDeleteIndex = index;
  if (confirmNameEl) confirmNameEl.textContent = name || ('Desktop ' + (index + 1));
  confirmModal.classList.remove('hidden');
  setTimeout(() => confirmCancelBtn && confirmCancelBtn.focus(), 0);
}
function closeConfirm() {
  pendingDeleteIndex = null;
  confirmModal.classList.add('hidden');
}
confirmCancelBtn.addEventListener('click', (e) => { e.stopPropagation(); closeConfirm(); });
confirmOkBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const idx = pendingDeleteIndex;
  closeConfirm();
  if (idx !== null) { try { await window.api.delete(idx); } catch (err) {} }
});
confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal) closeConfirm();
});
function isModalOpen() { return !confirmModal.classList.contains('hidden'); }

// ---------------- Background click → hide (acts like double-RAlt toggle) ----------------
document.addEventListener('click', (e) => {
  if (isModalOpen() || isFxModalOpen()) return;
  if (editing) return;
  if (e.target.closest('.tile, #close-btn, #confirm-modal, .modal, .tile-delete')) return;
  window.api.hide();
});

// ---------------- Border effect engine ----------------
const fxModal = document.getElementById('fx-modal');
const fxSearch = document.getElementById('fx-search');
const fxListEl = document.getElementById('fx-list');
const fxApplyBtn = document.getElementById('fx-apply');
const fxCancelBtn = document.getElementById('fx-cancel');
const fxClearBtn = document.getElementById('fx-clear');
const fxTargetNameEl = document.getElementById('fx-target-name');
let fxCatalog = [];
let fxFiltered = [];
let fxSelectedIdx = 0;
let fxTargetDesktop = null;
const desktopEffects = (() => { try { return JSON.parse(localStorage.getItem('desktopEffects') || '{}'); } catch (e) { return {}; } })();
const tileFx = new Map();

function buildFxCatalog() {
  const names = window.BORDER_EFFECTS || [];
  const meta = window.FX_META || {};
  let total = names.length;
  for (const k in meta) total = Math.max(total, +k);
  const list = [];
  for (let id = 1; id <= total; id++) {
    const name = (names[id - 1]) || (meta[id] && meta[id].name) || ('Effect #' + id);
    const isCss = (id >= 1 && id <= 50) || (id >= 326 && id <= 425) || !!(meta[id] && meta[id].cfg && meta[id].cfg._css);
    list.push({ id, name, isCss });
  }
  return list;
}

function isFxModalOpen() { return !fxModal.classList.contains('hidden'); }

function openFxModal(desktopIndex, desktopName) {
  if (!fxCatalog.length) fxCatalog = buildFxCatalog();
  fxTargetDesktop = desktopIndex;
  fxTargetNameEl.textContent = desktopName || ('Desktop ' + (desktopIndex + 1));
  fxSearch.value = '';
  const cur = desktopEffects[desktopIndex];
  filterFx('');
  if (cur) {
    const i = fxFiltered.findIndex(e => e.id === cur);
    if (i >= 0) { fxSelectedIdx = i; renderFxList(); }
  }
  fxModal.classList.remove('hidden');
  setTimeout(() => fxSearch.focus(), 0);
}

function closeFxModal() { fxTargetDesktop = null; fxModal.classList.add('hidden'); }

function filterFx(q) {
  q = (q || '').trim().toLowerCase();
  if (!q) { fxFiltered = fxCatalog.slice(); }
  else { fxFiltered = fxCatalog.filter(e => e.name.toLowerCase().includes(q) || String(e.id) === q); }
  fxSelectedIdx = 0;
  renderFxList();
}

function renderFxList() {
  if (!fxFiltered.length) { fxListEl.innerHTML = '<div class="fx-empty">No effects match</div>'; return; }
  const frag = document.createDocumentFragment();
  fxFiltered.slice(0, 400).forEach((e, i) => {
    const el = document.createElement('div');
    el.className = 'fx-item' + (i === fxSelectedIdx ? ' selected' : '');
    el.dataset.idx = i;
    el.innerHTML = `<span class="fx-name">${escapeHtml(e.name)}</span><span class="fx-id">#${e.id}</span>`;
    el.addEventListener('click', () => { fxSelectedIdx = i; renderFxList(); });
    el.addEventListener('dblclick', () => { fxSelectedIdx = i; applyFxFromModal(); });
    frag.appendChild(el);
  });
  fxListEl.innerHTML = '';
  fxListEl.appendChild(frag);
  const sel = fxListEl.querySelector('.fx-item.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

fxSearch.addEventListener('input', () => filterFx(fxSearch.value));
fxSearch.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { fxSelectedIdx = Math.min(fxSelectedIdx + 1, fxFiltered.length - 1); renderFxList(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { fxSelectedIdx = Math.max(fxSelectedIdx - 1, 0); renderFxList(); e.preventDefault(); }
  else if (e.key === 'Enter') { applyFxFromModal(); e.preventDefault(); }
  else if (e.key === 'Escape') { closeFxModal(); e.preventDefault(); }
});
fxApplyBtn.addEventListener('click', (e) => { e.stopPropagation(); applyFxFromModal(); });
fxCancelBtn.addEventListener('click', (e) => { e.stopPropagation(); closeFxModal(); });
fxClearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (fxTargetDesktop === null) return;
  delete desktopEffects[fxTargetDesktop];
  saveDesktopEffects();
  applyEffectToDesktopTile(fxTargetDesktop, null);
  closeFxModal();
});
fxModal.addEventListener('click', (e) => { if (e.target === fxModal) closeFxModal(); });

function applyFxFromModal() {
  const pick = fxFiltered[fxSelectedIdx];
  if (!pick || fxTargetDesktop === null) return;
  desktopEffects[fxTargetDesktop] = pick.id;
  saveDesktopEffects();
  applyEffectToDesktopTile(fxTargetDesktop, pick.id);
  closeFxModal();
}

function saveDesktopEffects() {
  try { localStorage.setItem('desktopEffects', JSON.stringify(desktopEffects)); } catch (e) {}
}

function findTileByDesktopIndex(di) {
  for (const it of items) if (it.kind === 'desktop' && it.index === di) return it.el;
  return null;
}

function clearTileFx(tileEl) {
  const state = tileFx.get(tileEl);
  if (state) {
    if (state.raf) cancelAnimationFrame(state.raf);
    if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
    tileFx.delete(tileEl);
  }
  const thumb = tileEl.querySelector('.thumb');
  if (thumb) {
    // Strip any bNN class
    Array.from(thumb.classList).forEach(c => { if (/^b\d+$/.test(c)) thumb.classList.remove(c); });
  }
}

function applyEffectToDesktopTile(desktopIndex, effectId) {
  const tileEl = findTileByDesktopIndex(desktopIndex);
  if (!tileEl) return;
  const thumb = tileEl.querySelector('.thumb');
  if (!thumb) return;
  clearTileFx(tileEl);
  if (!effectId) return;
  if (!fxCatalog.length) fxCatalog = buildFxCatalog();
  const spec = fxCatalog.find(e => e.id === effectId);
  if (!spec) return;
  if (spec.isCss) {
    const cls = 'b' + String(effectId).padStart(2, '0');
    thumb.classList.add(cls);
  } else {
    const meta = (window.FX_META || {})[effectId];
    if (!meta || !window.FX) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'fx-canvas';
    thumb.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    let inst;
    try { inst = window.FX(meta.cfg)(); } catch (e) { console.warn('FX factory failed', e); canvas.remove(); return; }
    let last = performance.now();
    const state = { canvas, inst, raf: 0 };
    function loop(now) {
      if (!state.canvas.isConnected) return;
      const rect = state.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (state.canvas.width !== w || state.canvas.height !== h) { state.canvas.width = w; state.canvas.height = h; }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, w, h);
      try { state.inst.step(dt, w, h); state.inst.draw(ctx, w, h); } catch (e) {}
      state.raf = requestAnimationFrame(loop);
    }
    state.raf = requestAnimationFrame(loop);
    tileFx.set(tileEl, state);
  }
}

function reapplyAllEffects() {
  Object.keys(desktopEffects).forEach(k => {
    applyEffectToDesktopTile(+k, desktopEffects[k]);
  });
}

let lastCount = -1;
setTimeout(() => {
  if (lastCount === -1) {
    loading.textContent = 'No desktops detected — try Refresh from the tray icon.';
  }
}, 4000);
window.api.onData((data) => {
  if (!data) return;
  if (editing) return;
  if (data.tiles.length !== lastCount) {
    lastCount = data.tiles.length;
    render(data);
    return;
  }
  // incremental update: images + names + current
  data.tiles.forEach((t, i) => {
    const it = items[i];
    if (!it || it.kind !== 'desktop') return;
    const nameEl = it.el.querySelector('.name');
    if (nameEl && nameEl.textContent !== t.name) nameEl.textContent = t.name;
    const thumbEl = it.el.querySelector('.thumb');
    if (t.image) {
      const img = thumbEl.querySelector('img');
      if (img) { if (img.getAttribute('src') !== t.image) img.setAttribute('src', t.image); }
      else { thumbEl.innerHTML = `<img src="${t.image}" alt="" />`; }
    }
    it.el.classList.toggle('current', !!t.current);
  });
});
