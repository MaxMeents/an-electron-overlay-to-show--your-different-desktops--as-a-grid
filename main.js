const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

let uIOhook = null;
let UiohookKey = null;
try {
  const u = require('uiohook-napi');
  uIOhook = u.uIOhook;
  UiohookKey = u.UiohookKey;
} catch (e) {
  console.error('uiohook-napi failed to load:', e.message);
}

const CACHE_DIR = path.join(os.tmpdir(), 'desktop-grid-overlay');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}
const resDir = () => app.isPackaged ? process.resourcesPath : __dirname;
const hostScript = () => path.join(resDir(), 'host.ps1');

// ---------------- PowerShell host process ----------------

class PsHost {
  constructor() {
    this.proc = null;
    this.ready = null;
    this.queue = [];
    this.buf = '';
    this.starting = false;
  }
  async start() {
    if (this.proc) return this.ready;
    if (this.starting) return this.ready;
    this.starting = true;
    this.ready = new Promise((resolve) => {
      this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hostScript()], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc.stdout.setEncoding('utf8');
      let resolvedReady = false;
      this.proc.stdout.on('data', (chunk) => {
        this.buf += chunk;
        let idx;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
          let line = this.buf.slice(0, idx).replace(/\r$/, '');
          this.buf = this.buf.slice(idx + 1);
          if (!resolvedReady) {
            if (line === 'READY') { resolvedReady = true; resolve(); }
            continue;
          }
          const cb = this.queue.shift();
          if (cb) cb(line);
        }
      });
      this.proc.stderr.on('data', (d) => { /* ignore */ });
      this.proc.on('exit', () => {
        this.proc = null;
        this.starting = false;
        this.ready = null;
        this.buf = '';
        while (this.queue.length) { const cb = this.queue.shift(); cb && cb('ERR host exited'); }
      });
    });
    return this.ready;
  }
  send(line, timeoutMs) {
    return new Promise(async (resolve) => {
      await this.start();
      if (!this.proc) return resolve('ERR no host');
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      this.queue.push(done);
      try { this.proc.stdin.write(line + '\n'); } catch (e) { done('ERR write'); }
      if (timeoutMs) {
        setTimeout(() => {
          if (!settled) {
            done('ERR timeout');
            try { this.proc && this.proc.kill(); } catch (e) {}
          }
        }, timeoutMs);
      }
    });
  }
  async list() {
    const r = await this.send('LIST', 4000);
    if (r && r.startsWith('DATA ')) {
      try { return JSON.parse(r.slice(5)); } catch (e) { return null; }
    }
    return null;
  }
  async capture(filePath) { return this.send('CAPTURE ' + filePath, 6000); }
  async captureDesktop(index, filePath) { return this.send('CAPTURE_DESKTOP ' + index + ' ' + filePath, 2000); }
  async captureAllNoSwitch(dir) { return this.send('CAPTURE_ALL ' + dir, 30000); }
  async step(dir) { return this.send('STEP ' + dir, 3000); }
  async newDesktop() { return this.send('NEW', 3000); }
  async rename(index, name) { return this.send('RENAME ' + index + '|' + name, 4000); }
  async goto(index) { return this.send('GOTO ' + index, 3000); }
  async pin(hwnd) { return this.send('PIN ' + hwnd, 3000); }
}

const host = new PsHost();
const captureHost = new PsHost();

// ---------------- Cache ----------------

let cache = {
  info: null,
  pngs: [],
};

function thumbPath(i) { return path.join(CACHE_DIR, 'desktop_' + i + '.png'); }

function buildPayload() {
  if (!cache.info) return null;
  const tiles = [];
  for (let i = 0; i < cache.info.count; i++) {
    const p = thumbPath(i);
    let url = null;
    if (fs.existsSync(p)) {
      try { url = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); } catch (e) {}
    }
    tiles.push({
      index: i,
      name: cache.info.names[i] || ('Desktop ' + (i + 1)),
      image: url,
      current: i === cache.info.current,
    });
  }
  return { tiles, current: cache.info.current };
}

let capturing = false;

async function captureAll() {
  if (capturing) return;
  capturing = true;
  try {
    const info = await host.list();
    if (!info) return;
    cache.info = info;
    if (win) win.webContents.send('data', buildPayload());
    // Progressive: capture current desktop first (fastest, fresh), then others one at a time.
    // Each tile updates in the UI as soon as its PNG lands.
    const order = [info.current];
    for (let i = 0; i < info.count; i++) if (i !== info.current) order.push(i);
    for (const i of order) {
      await captureHost.captureDesktop(i, thumbPath(i));
      if (win) win.webContents.send('data', buildPayload());
    }
  } finally {
    capturing = false;
  }
}

async function refreshListOnly() {
  const info = await host.list();
  if (info) {
    cache.info = info;
    if (win) win.webContents.send('data', buildPayload());
  }
}

async function refreshCurrentThumb() {
  const info = await host.list();
  if (!info) return;
  cache.info = info;
  await captureHost.capture(thumbPath(info.current));
  if (win) win.webContents.send('data', buildPayload());
}

// ---------------- Window ----------------

let win = null;
let tray = null;
let winPinned = false;
let suppressBlurHide = false;
let overlayVisible = false;

async function createWindow() {
  const disp = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: -32000,
    y: -32000,
    width: disp.bounds.width,
    height: disp.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: true,
    focusable: true,
    opacity: 0,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.loadFile('index.html');
  win.on('closed', () => { win = null; winPinned = false; });
  win.on('blur', () => {
    if (suppressBlurHide) return;
    if (win && isOverlayShown()) hideOverlay();
  });
  win.webContents.on('did-finish-load', () => {
    const payload = buildPayload();
    if (payload) win.webContents.send('data', payload);
  });
  await new Promise(r => win.webContents.once('did-finish-load', r));
  // Pin the window to all virtual desktops so hide/show doesn't bounce through desktops
  try {
    const hwndBuf = win.getNativeWindowHandle();
    const hwnd = hwndBuf.length >= 8 ? hwndBuf.readBigUInt64LE(0).toString() : String(hwndBuf.readUInt32LE(0));
    await host.pin(hwnd);
    winPinned = true;
  } catch (e) { /* fallback: non-pinned */ }
}

function isOverlayShown() { return overlayVisible; }

async function showOverlay() {
  if (!win) { await createWindow(); }
  if (!win) return;
  if (isOverlayShown()) { forceFocus(); return; }
  overlayVisible = true;
  const disp = screen.getPrimaryDisplay();
  const p = buildPayload();
  if (p) win.webContents.send('data', p);
  try { win.webContents.send('visibility', true); } catch (e) {}
  suppressBlurHide = true;
  try { win.setBounds({ x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height }); } catch (e) {}
  win.setIgnoreMouseEvents(false);
  win.setOpacity(1);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  forceFocus();
  setTimeout(() => { suppressBlurHide = false; }, 200);
  captureAll().catch(() => {});
}

function forceFocus() {
  if (!win) return;
  try { app.focus({ steal: true }); } catch (e) {}
  try { win.focus(); } catch (e) {}
}

function hideOverlay() {
  if (!win) return;
  overlayVisible = false;
  try { win.webContents.send('visibility', false); } catch (e) {}
  try { win.setOpacity(0); } catch (e) {}
  try { win.setIgnoreMouseEvents(true); } catch (e) {}
  try { win.setBounds({ x: -32000, y: -32000, width: 1, height: 1 }); } catch (e) {}
  try { win.blur(); } catch (e) {}
}

function toggleOverlay() {
  if (isOverlayShown()) hideOverlay();
  else showOverlay();
}

// ---------------- Tray icon ----------------

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeIconPng() {
  const w = 16, h = 16;
  const colors = [[90, 170, 255], [140, 120, 240], [80, 220, 180], [255, 170, 110]];
  const raw = Buffer.alloc(h * (1 + w * 4));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const qx = x < 8 ? 0 : 1, qy = y < 8 ? 0 : 1;
      const [r, g, b] = colors[qy * 2 + qx];
      const lx = x % 8, ly = y % 8;
      const on = lx >= 1 && lx <= 6 && ly >= 1 && ly <= 6;
      raw[o++] = on ? r : 0;
      raw[o++] = on ? g : 0;
      raw[o++] = on ? b : 0;
      raw[o++] = on ? 255 : 0;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function createTray() {
  let img;
  try { img = nativeImage.createFromBuffer(makeIconPng()); }
  catch (e) { img = nativeImage.createEmpty(); }
  try { tray = new Tray(img); } catch (e) { return; }
  tray.setToolTip('Desktop Grid — double-tap Right Alt');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show overlay', click: () => showOverlay() },
    { label: 'Refresh thumbnails', click: () => captureAll().catch(() => {}) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => toggleOverlay());
}

// ---------------- Keyboard hook ----------------

let lastRightAltUp = 0;

function startKeyHook() {
  if (!uIOhook) return;
  uIOhook.on('keyup', (e) => {
    const isRightAlt = UiohookKey && (e.keycode === UiohookKey.AltRight || e.keycode === 3640);
    if (!isRightAlt) return;
    if (e.ctrlKey || e.metaKey) { lastRightAltUp = 0; return; }
    const now = Date.now();
    const delta = now - lastRightAltUp;
    if (lastRightAltUp && delta > 40 && delta < 400) {
      lastRightAltUp = 0;
      setImmediate(toggleOverlay);
    } else {
      lastRightAltUp = now;
    }
  });
  uIOhook.on('keydown', (e) => {
    if (!overlayVisible) return;
    const isEsc = UiohookKey && (e.keycode === UiohookKey.Escape || e.keycode === 1);
    if (isEsc) setImmediate(hideOverlay);
  });
  try { uIOhook.start(); } catch (e) { console.error('hook start failed', e.message); }
}

function stopKeyHook() { try { uIOhook && uIOhook.stop(); } catch (e) {} }

// ---------------- IPC ----------------

ipcMain.handle('goto', async (_e, index) => {
  hideOverlay();
  await new Promise(r => setTimeout(r, 40));
  try { await host.goto(index); } catch (e) {}
  setTimeout(() => { refreshCurrentThumb().catch(() => {}); }, 350);
});

ipcMain.handle('create', async () => {
  try { await host.newDesktop(); } catch (e) {}
  await refreshListOnly();
  // capture new desktop (it's now current)
  refreshCurrentThumb().catch(() => {});
  return buildPayload();
});

ipcMain.handle('rename', async (_e, index, newName) => {
  try {
    await host.rename(index, newName);
    if (cache.info && cache.info.names) cache.info.names[index] = newName;
    if (win) win.webContents.send('data', buildPayload());
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('hide', () => hideOverlay());
ipcMain.handle('refresh', () => { captureAll().catch(() => {}); });
ipcMain.handle('quit', () => { app.isQuitting = true; app.quit(); });

// ---------------- Lifecycle ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => showOverlay());
  app.whenReady().then(async () => {
    createTray();
    startKeyHook();
    try {
      await host.start();
      // Start the capture host in parallel — slow setup doesn't block main host
      captureHost.start().catch(() => {});
      await refreshListOnly();
      // capture only the current desktop at startup (fast, no window enumeration)
      refreshCurrentThumb().catch(() => {});
      // Pre-create the hidden pinned window so first toggle is instant
      createWindow().catch(() => {});
    } catch (e) { console.error(e); }
  });
}

app.on('window-all-closed', (e) => { if (e && e.preventDefault) e.preventDefault(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  stopKeyHook();
  for (const h of [host, captureHost]) {
    if (h && h.proc) { try { h.proc.stdin.write('EXIT\n'); } catch (e) {} try { h.proc.kill(); } catch (e) {} }
  }
});
