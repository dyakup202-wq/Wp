const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const AUTH_ROOT = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

const DEFAULT = {
  accounts: {}, // id -> { id, name, phone, status }
  settings: {
    delay: 2200,
    typingDelay: 1200,
    prefix: '',
    usePrefix: false,
    targetId: '',
    accountId: null
  },
  messages: ['Merhaba', 'Nasılsın?'],
  logs: [],
  history: []
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return {
        accounts: d.accounts || {},
        settings: { ...DEFAULT.settings, ...(d.settings || {}) },
        messages: Array.isArray(d.messages) ? d.messages : DEFAULT.messages.slice(),
        logs: d.logs || [],
        history: d.history || []
      };
    }
  } catch (e) { console.error('load', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT));
}
function saveData() {
  try {
    store.logs = store.logs.slice(0, 250);
    store.history = store.history.slice(0, 150);
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  } catch (e) { console.error('save', e.message); }
}
let store = loadData();

function log(msg, type = 'info', accountId = null) {
  const entry = { msg: String(msg).slice(0, 400), type, accountId, time: new Date().toLocaleTimeString('tr-TR') };
  store.logs.unshift(entry);
  if (store.logs.length > 250) store.logs.length = 250;
  saveData();
  io.emit('log', entry);
  console.log(`[${type}]${accountId ? '[' + accountId + ']' : ''} ${msg}`);
}
function errText(e) {
  if (e == null) return 'bilinmeyen';
  if (typeof e === 'string') return e.slice(0, 300);
  if (e instanceof Error) return ((e.name ? e.name + ': ' : '') + (e.message || '')).slice(0, 300);
  if (e.message) return String(e.message).slice(0, 300);
  try { return JSON.stringify(e).slice(0, 300); } catch (_) { return String(e).slice(0, 300); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalizeTarget(id) {
  if (!id) return '';
  let s = String(id).trim();
  if (!s) return '';
  if (s.includes('@')) return s;
  s = s.replace(/[\s+]/g, '');
  if (/^\d{10,15}$/.test(s)) return s + '@c.us';
  return s;
}

function puppeteerOpts() {
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--disable-extensions', '--disable-software-rasterizer'
  ];
  const opts = { headless: true, args, timeout: 120000 };
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean)) {
    if (fs.existsSync(p)) { opts.executablePath = p; break; }
  }
  return opts;
}

// accountId -> { client, ready, qr, info, chats }
const live = {};
let loopTimer = null;
let loopRunning = false;
let loopIndex = 0;

function snapshot() {
  const accounts = Object.keys(store.accounts).map((id) => {
    const meta = store.accounts[id] || {};
    const L = live[id];
    return {
      id,
      name: L?.info?.pushname || meta.name || id,
      phone: L?.info?.phone || meta.phone || null,
      status: L?.ready ? 'ready' : (meta.status || 'off'),
      ready: !!L?.ready,
      hasQr: !!L?.qr,
      chats: L?.chats?.length || 0
    };
  });
  return {
    accounts,
    settings: store.settings,
    messages: store.messages,
    messageCount: store.messages.length,
    loopRunning,
    history: store.history.slice(0, 40),
    logs: store.logs.slice(0, 60)
  };
}

function emitStatus() { io.emit('status', snapshot()); }

async function loadChats(accountId) {
  const L = live[accountId];
  if (!L?.ready || !L.client) return [];
  try {
    await sleep(400);
    let chats = null;
    let last = null;
    for (let i = 1; i <= 3; i++) {
      try {
        chats = await L.client.getChats();
        if (Array.isArray(chats)) break;
      } catch (e) {
        last = e;
        await sleep(800 * i);
      }
    }
    if (!Array.isArray(chats)) throw last || new Error('getChats failed');
    L.chats = chats.slice(0, 300).map((c) => {
      const id = c.id?._serialized || '';
      return {
        id,
        name: c.name || c.formattedTitle || c.id?.user || id,
        isGroup: !!c.isGroup,
        unread: c.unreadCount || 0
      };
    }).filter((c) => c.id);
    L.chats.sort((a, b) => {
      if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'tr');
    });
    io.emit('chats', { accountId, chats: L.chats });
    log(L.chats.length + ' sohbet/grup yuklendi', 'success', accountId);
    emitStatus();
    return L.chats;
  } catch (e) {
    log('Sohbet yukleme: ' + errText(e), 'error', accountId);
    return [];
  }
}

function createClient(accountId) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId, dataPath: AUTH_ROOT }),
    puppeteer: puppeteerOpts(),
    webVersionCache: { type: 'none' },
    restartOnAuthFail: true
  });

  live[accountId] = { client, ready: false, qr: null, info: null, chats: [] };

  client.on('qr', async (qr) => {
    live[accountId].qr = qr;
    live[accountId].ready = false;
    if (store.accounts[accountId]) store.accounts[accountId].status = 'qr';
    saveData();
    try {
      const dataUrl = await qrcode.toDataURL(qr);
      io.emit('qr', { accountId, qr: dataUrl });
      log('QR hazir — okut', 'qr', accountId);
    } catch (e) {
      log('QR hata: ' + errText(e), 'error', accountId);
    }
    emitStatus();
  });

  client.on('loading_screen', (p, m) => {
    log('Yukleniyor ' + p + '% ' + (m || ''), 'info', accountId);
  });

  client.on('authenticated', () => {
    if (store.accounts[accountId]) store.accounts[accountId].status = 'auth';
    saveData();
    log('Kimlik dogrulandi', 'auth', accountId);
    emitStatus();
  });

  client.on('ready', async () => {
    await sleep(2000);
    live[accountId].ready = true;
    live[accountId].qr = null;
    const phone = client.info?.wid?.user || '';
    const name = client.info?.pushname || 'WhatsApp';
    live[accountId].info = { pushname: name, phone };
    store.accounts[accountId] = {
      id: accountId,
      name,
      phone,
      status: 'ready'
    };
    saveData();
    log('Baglandi: ' + name + (phone ? ' +' + phone : ''), 'success', accountId);
    io.emit('qr', { accountId, qr: null, connected: true });
    emitStatus();
    await loadChats(accountId);
  });

  client.on('auth_failure', (m) => {
    live[accountId].ready = false;
    if (store.accounts[accountId]) store.accounts[accountId].status = 'auth_fail';
    saveData();
    log('Auth fail: ' + errText(m), 'error', accountId);
    emitStatus();
  });

  client.on('disconnected', (reason) => {
    live[accountId].ready = false;
    if (store.accounts[accountId]) store.accounts[accountId].status = 'disconnected';
    saveData();
    log('Koptu: ' + errText(reason), 'warn', accountId);
    emitStatus();
    setTimeout(() => {
      log('Yeniden baglaniyor...', 'info', accountId);
      client.initialize().catch((e) => log('re-init: ' + errText(e), 'error', accountId));
    }, 8000);
  });

  return client;
}

async function addAccount(name) {
  const id = 'acc_' + Date.now();
  store.accounts[id] = { id, name: name || id, phone: null, status: 'starting' };
  saveData();
  const client = createClient(id);
  try {
    await client.initialize();
  } catch (e) {
    log('Baslatma: ' + errText(e), 'error', id);
    return { ok: false, error: errText(e) };
  }
  emitStatus();
  return { ok: true, accountId: id };
}

async function removeAccount(id) {
  stopLoopIfAccount(id);
  const L = live[id];
  if (L?.client) {
    try { await L.client.destroy(); } catch (_) {}
  }
  delete live[id];
  delete store.accounts[id];
  if (store.settings.accountId === id) store.settings.accountId = null;
  saveData();
  try {
    const dir = path.join(AUTH_ROOT, 'session-' + id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
  log('Hesap silindi', 'warn', id);
  emitStatus();
}

function stopLoopIfAccount(id) {
  if (loopRunning && store.settings.accountId === id) stopLoop(true);
}

function buildBody(text) {
  let msg = String(text || '');
  if (store.settings.usePrefix && store.settings.prefix) {
    const parts = String(store.settings.prefix).trim().split(/[\s,;]+/).filter(Boolean);
    const tags = parts.map((p) => {
      const d = String(p).replace(/\D/g, '');
      return d.length >= 10 ? '@' + d : p;
    });
    if (tags.length) msg = tags.join(' ') + ' ' + msg;
  }
  return msg.slice(0, 65000);
}

async function sendOne(accountId, targetId, text) {
  const L = live[accountId];
  if (!L?.ready || !L.client) throw new Error('Hesap bagli degil');
  targetId = normalizeTarget(targetId);
  if (!targetId || !targetId.includes('@')) throw new Error('Hedef formati: 905...@c.us veya grup@g.us');
  const body = buildBody(text);
  if (!body.trim()) throw new Error('Mesaj bos');

  let chatName = targetId;
  try {
    const chat = await L.client.getChatById(targetId);
    if (chat) {
      chatName = chat.name || targetId;
      const typingMs = Math.max(0, Number(store.settings.typingDelay) || 0);
      if (typingMs > 0) {
        try {
          await chat.sendStateTyping();
          await sleep(typingMs);
        } catch (e) {
          log('Typing uyari: ' + errText(e), 'warn', accountId);
        }
      }
    }
  } catch (e) {
    log('getChat uyari: ' + errText(e), 'warn', accountId);
  }

  await L.client.sendMessage(targetId, body);
  try {
    const chat = await L.client.getChatById(targetId).catch(() => null);
    if (chat?.clearState) await chat.clearState();
  } catch (_) {}

  const hist = { time: new Date().toLocaleTimeString('tr-TR'), accountId, target: targetId, body: body.slice(0, 100) };
  store.history.unshift(hist);
  if (store.history.length > 150) store.history.length = 150;
  saveData();
  io.emit('history', hist);
  log('Gonderildi → ' + String(chatName).slice(0, 24) + ': ' + body.slice(0, 36), 'send', accountId);
  return hist;
}

function stopLoop(save = true) {
  loopRunning = false;
  if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
  if (save) saveData();
  io.emit('loop', { running: false });
  log('Dongu durdu', 'warn');
}

function startLoop() {
  if (loopRunning) return log('Dongu zaten acik', 'warn');
  const accId = store.settings.accountId;
  if (!accId || !live[accId]?.ready) return log('Once bagli hesap sec', 'error');
  if (!store.settings.targetId) return log('Hedef yok', 'error');
  if (!store.messages.length) return log('Mesaj yok', 'error');

  loopRunning = true;
  io.emit('loop', { running: true });
  log('Dongu basladi', 'success', accId);

  const tick = async () => {
    if (!loopRunning) return;
    try {
      if (!live[accId]?.ready) {
        log('Hesap dustu, dongu duruyor', 'error', accId);
        return stopLoop(true);
      }
      const msgs = store.messages;
      if (!msgs.length) return stopLoop(true);
      const text = msgs[loopIndex % msgs.length];
      loopIndex++;
      await sendOne(accId, store.settings.targetId, text);
      const delay = Math.max(800, Number(store.settings.delay) || 2200);
      if (loopRunning) loopTimer = setTimeout(tick, delay);
    } catch (e) {
      log('Gonderme: ' + errText(e), 'error', accId);
      if (loopRunning) loopTimer = setTimeout(tick, Math.max(3000, Number(store.settings.delay) || 2200));
    }
  };
  tick();
}

async function restoreAccounts() {
  const ids = Object.keys(store.accounts);
  for (const id of ids) {
    if (store.accounts[id].status === 'removed') continue;
    log('Kayitli hesap yukleniyor...', 'info', id);
    try {
      const c = createClient(id);
      await c.initialize();
    } catch (e) {
      log('Restore: ' + errText(e), 'error', id);
    }
    await sleep(1500);
  }
}

// API
app.use(express.json({ limit: '2mb' }));
app.get('/api/ping', (_req, res) => res.json({ ok: true }));
app.get('/api/status', (_req, res) => {
  const s = snapshot();
  const accId = store.settings.accountId;
  s.chats = (accId && live[accId]?.chats) || [];
  res.json(s);
});

app.post('/api/account/add', async (req, res) => {
  try {
    const r = await addAccount((req.body?.name || '').trim());
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: errText(e) }); }
});

app.post('/api/account/remove', async (req, res) => {
  try {
    const id = req.body?.accountId;
    if (!id || !store.accounts[id]) return res.json({ ok: false, error: 'Hesap yok' });
    await removeAccount(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: errText(e) }); }
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.delay !== undefined) store.settings.delay = Math.max(800, Number(b.delay) || 2200);
  if (b.typingDelay !== undefined) store.settings.typingDelay = Math.max(0, Number(b.typingDelay) || 0);
  if (b.prefix !== undefined) store.settings.prefix = String(b.prefix || '');
  if (typeof b.usePrefix === 'boolean') store.settings.usePrefix = b.usePrefix;
  if (b.targetId !== undefined) store.settings.targetId = normalizeTarget(b.targetId);
  if (b.accountId !== undefined) store.settings.accountId = b.accountId || null;
  saveData();
  log('Ayarlar kaydedildi', 'info');
  emitStatus();
  res.json({ ok: true, settings: store.settings });
});

app.post('/api/messages', (req, res) => {
  let msgs = req.body?.messages;
  if (typeof msgs === 'string') msgs = msgs.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!Array.isArray(msgs)) msgs = [];
  store.messages = msgs.map(m => String(m).trim()).filter(Boolean);
  saveData();
  log(store.messages.length + ' mesaj kaydedildi', 'success');
  res.json({ ok: true, count: store.messages.length });
});

app.post('/api/loop/start', (req, res) => {
  if (req.body?.accountId) store.settings.accountId = req.body.accountId;
  if (req.body?.targetId) store.settings.targetId = normalizeTarget(req.body.targetId);
  if (req.body?.delay) store.settings.delay = Math.max(800, Number(req.body.delay) || 2200);
  saveData();
  startLoop();
  res.json({ ok: true, running: loopRunning });
});

app.post('/api/loop/stop', (_req, res) => { stopLoop(true); res.json({ ok: true }); });

app.post('/api/chats/refresh', async (req, res) => {
  const id = req.body?.accountId || store.settings.accountId;
  if (!id) return res.json({ ok: false, error: 'Hesap sec' });
  const chats = await loadChats(id);
  res.json({ ok: true, chats, count: chats.length });
});

app.post('/api/send', async (req, res) => {
  try {
    const accountId = req.body?.accountId || store.settings.accountId;
    const hist = await sendOne(accountId, req.body?.targetId || store.settings.targetId, req.body?.text);
    res.json({ ok: true, hist });
  } catch (e) { res.status(500).json({ ok: false, error: errText(e) }); }
});

const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>WP Multi Panel</title>
<script src="/socket.io/socket.io.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#e8e8e8;min-height:100vh;padding:12px}
.panel{max-width:520px;margin:0 auto;background:#121212;border:1px solid #222;border-radius:16px;padding:16px}
h1{text-align:center;color:#25d366;font-size:22px;margin-bottom:12px}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:12px;margin-bottom:12px}
.card h3{font-size:11px;color:#888;text-transform:uppercase;margin-bottom:8px;letter-spacing:.4px}
label{display:block;font-size:12px;color:#aaa;margin:8px 0 4px;font-weight:600}
input,textarea,select{width:100%;background:#0d0d0d;border:1px solid #333;border-radius:8px;padding:10px;color:#eee;font-size:13px}
textarea{min-height:90px;resize:vertical;line-height:1.4}
.btn{border:none;border-radius:8px;padding:11px;font-weight:700;font-size:13px;cursor:pointer}
.btn-g{background:#25d366;color:#000}.btn-r{background:#e74c3c;color:#fff}.btn-s{background:#2a2a2a;color:#ccc}
.btn-full{width:100%;margin-top:8px}
.row{display:flex;gap:8px;margin-top:8px}
.row .btn{flex:1}
.item{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:8px;padding:10px;margin-bottom:6px}
.item-h{display:flex;justify-content:space-between;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;background:#666}
.dot.on{background:#25d366;box-shadow:0 0 6px #25d366}.dot.qr{background:#e3b341}
.qr-box{text-align:center;min-height:200px;display:flex;align-items:center;justify-content:center;background:#0d0d0d;border-radius:10px;border:1px solid #2a2a2a}
.qr-box img{width:200px;height:200px;border:3px solid #25d366;border-radius:8px}
.chat-list{max-height:180px;overflow-y:auto}
.chat-item{padding:8px 10px;border-bottom:1px solid #1f1f1f;cursor:pointer;font-size:12px;display:flex;justify-content:space-between}
.chat-item:hover,.chat-item.on{background:#1a2a1a}
.tag{font-size:10px;color:#25d366}
.count{color:#25d366;font-size:12px;font-weight:700}
.file-btn{display:inline-block;background:#1f3d2a;color:#25d366;border:1px solid #2a5a3a;border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer}
.logs{max-height:140px;overflow-y:auto;font-family:monospace;font-size:11px;background:#0d0d0d;border-radius:8px;padding:8px}
.log{padding:2px 0;word-break:break-word}.log.error{color:#e74c3c}.log.success{color:#25d366}.log.warn{color:#e3b341}.log.send{color:#53bdeb}.log.qr{color:#e3b341}
.hint{font-size:11px;color:#666;margin-top:4px}
.toggle{display:flex;align-items:center;gap:8px;font-size:13px;color:#bbb;margin-top:6px}
.hist{width:100%;font-size:11px;border-collapse:collapse}
.hist td,.hist th{padding:4px 6px;border-bottom:1px solid #222;text-align:left;color:#ccc}
.badge{font-size:10px;padding:2px 6px;border-radius:10px}
.badge.on{background:#1a3a2a;color:#25d366}.badge.off{background:#3a1a1a;color:#e74c3c}
</style>
</head>
<body>
<div class="panel">
  <h1>💬 WP Multi Panel</h1>

  <div class="card">
    <h3>Hesap Ekle (istedigin kadar)</h3>
    <label>Isim</label>
    <input id="acc-name" placeholder="Is hatti / Kisisel">
    <button class="btn btn-g btn-full" onclick="addAccount()">+ Hesap Ekle / QR</button>
    <div class="qr-box" id="qrBox" style="margin-top:10px"><div style="color:#666">QR bekleniyor</div></div>
    <div class="hint" id="qrHint"></div>
  </div>

  <div class="card">
    <h3>Bagli Hesaplar</h3>
    <div id="accList"><div style="color:#666;text-align:center;padding:12px">Hesap yok</div></div>
  </div>

  <div class="card">
    <h3>Gonderim</h3>
    <label>Hesap</label>
    <select id="account" onchange="onAccountChange()"></select>
    <label>Hedef (veya asagidan sec)</label>
    <input id="target" placeholder="905...@c.us veya grup@g.us">
    <label>Hiz (ms)</label>
    <input id="delay" type="number" min="800" value="2200">
    <label>Typing suresi (ms)</label>
    <input id="typing" type="number" min="0" value="1200">
    <label>Prefix / numara etiketi</label>
    <input id="prefix" placeholder="905551112233">
    <label class="toggle"><input type="checkbox" id="usePrefix"> Prefix aktif</label>
    <label>Mesajlar (her satir 1)</label>
    <textarea id="msgs"></textarea>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
      <label class="file-btn">TXT Yukle<input type="file" id="txt" accept=".txt,text/plain" hidden></label>
      <span class="count" id="msgCount">0 mesaj</span>
    </div>
    <div class="row">
      <button class="btn btn-g" id="btnStart" onclick="startLoop()">Baslat</button>
      <button class="btn btn-r" onclick="stopLoop()">Durdur</button>
    </div>
    <button class="btn btn-s btn-full" onclick="refreshChats()">Sohbet / Grup Yukle</button>
    <button class="btn btn-s btn-full" onclick="saveAll()">Kaydet</button>
  </div>

  <div class="card">
    <h3>Gruplar & Sohbetler</h3>
    <div class="chat-list" id="chats"><div style="color:#666;padding:12px;text-align:center">Hesap secip yukle</div></div>
  </div>

  <div class="card">
    <h3>Gecmis</h3>
    <table class="hist"><thead><tr><th>Saat</th><th>Mesaj</th></tr></thead><tbody id="hist"></tbody></table>
  </div>

  <div class="card">
    <h3>Log</h3>
    <div class="logs" id="logs"></div>
  </div>
</div>
<script>
const socket = io({ transports: ['websocket', 'polling'] });
let state = { accounts: [], settings: {}, messages: [], chats: [] };
let activeQrAcc = null;

socket.on('qr', d => {
  activeQrAcc = d.accountId;
  const box = document.getElementById('qrBox');
  const hint = document.getElementById('qrHint');
  if (d.connected || !d.qr) {
    box.innerHTML = '<div style="color:#25d366;font-size:18px">Baglandi</div>';
    hint.textContent = d.accountId || '';
  } else {
    box.innerHTML = '<img src="'+d.qr+'">';
    hint.textContent = 'Oturum: ' + d.accountId + ' — WhatsApp ile okut';
  }
});
socket.on('status', d => { state.accounts = d.accounts || []; state.settings = d.settings || state.settings; renderAcc(); fillSelect(); });
socket.on('chats', d => { if (!d.accountId || d.accountId === document.getElementById('account').value) { state.chats = d.chats || []; renderChats(); } });
socket.on('log', e => addLog(e));
socket.on('history', h => {
  const tb = document.getElementById('hist');
  const tr = document.createElement('tr');
  tr.innerHTML = '<td>'+esc(h.time)+'</td><td>'+esc(h.body)+'</td>';
  tb.insertBefore(tr, tb.firstChild);
});
socket.on('loop', d => { document.getElementById('btnStart').disabled = !!d.running; });

async function api(url, method, body) {
  try {
    const o = { method: method||'GET', headers: {'Content-Type':'application/json'} };
    if (body) o.body = JSON.stringify(body);
    const r = await fetch(url, o);
    return await r.json();
  } catch (e) { return { ok:false, error:e.message }; }
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function updateCount(){ const n=document.getElementById('msgs').value.split('\\n').filter(l=>l.trim()).length; document.getElementById('msgCount').textContent=n+' mesaj'; }
document.getElementById('msgs').addEventListener('input', updateCount);
document.getElementById('txt').addEventListener('change', function(){
  const f=this.files&&this.files[0]; if(!f)return;
  const rd=new FileReader();
  rd.onload=async()=>{ const lines=String(rd.result||'').split(/\\r?\\n/).map(l=>l.trim()).filter(Boolean);
    document.getElementById('msgs').value=lines.join('\\n'); updateCount();
    await api('/api/messages','POST',{messages:lines}); alert(lines.length+' mesaj yuklendi'); };
  rd.readAsText(f,'UTF-8'); this.value='';
});

function renderAcc(){
  const el=document.getElementById('accList');
  const list=state.accounts||[];
  if(!list.length){el.innerHTML='<div style="color:#666;text-align:center;padding:12px">Hesap yok</div>';return;}
  el.innerHTML=list.map(a=>{
    const dot=a.ready?'on':(a.hasQr||a.status==='qr'?'qr':'');
    const badge=a.ready?'<span class="badge on">Bagli</span>':'<span class="badge off">'+(a.status||'off')+'</span>';
    return '<div class="item"><div class="item-h"><span><span class="dot '+dot+'"></span>'+esc(a.name)+'</span>'+
      '<button class="btn btn-r" style="padding:4px 8px;font-size:11px" onclick="removeAcc(\\''+a.id+'\\')">Sil</button></div>'+
      '<div style="font-size:11px;color:#888;margin-top:4px">'+badge+(a.phone?' · +'+esc(a.phone):'')+(a.chats?' · '+a.chats+' sohbet':'')+'</div></div>';
  }).join('');
}
function fillSelect(){
  const sel=document.getElementById('account');
  const cur=sel.value || state.settings.accountId || '';
  sel.innerHTML='<option value="">Hesap sec</option>'+(state.accounts||[]).map(a=>
    '<option value="'+a.id+'"'+(a.id===cur?' selected':'')+'>'+esc(a.name)+(a.ready?' ✓':'')+'</option>'
  ).join('');
  if(cur) sel.value=cur;
}
async function onAccountChange(){
  const id=document.getElementById('account').value;
  await api('/api/settings','POST',{accountId:id||null});
  if(id) refreshChats();
}
function renderChats(){
  const el=document.getElementById('chats');
  const list=state.chats||[];
  const cur=document.getElementById('target').value;
  if(!list.length){el.innerHTML='<div style="color:#666;padding:12px;text-align:center">Sohbet yok</div>';return;}
  el.innerHTML=list.map(c=>'<div class="chat-item'+(c.id===cur?' on':'')+'" onclick="pick(\\''+String(c.id).replace(/'/g,"\\\\'")+'\\')">'+
    '<span>'+esc(c.name)+'</span>'+(c.isGroup?'<span class="tag">GRUP</span>':'')+'</div>').join('');
}
function pick(id){ document.getElementById('target').value=id; renderChats(); }

async function addAccount(){
  const name=document.getElementById('acc-name').value.trim();
  document.getElementById('qrBox').innerHTML='<div style="color:#888">QR hazirlaniyor...</div>';
  const res=await api('/api/account/add','POST',{name});
  if(!res.ok) return alert(res.error||'Hata');
  document.getElementById('acc-name').value='';
  load();
}
async function removeAcc(id){
  if(!confirm('Hesap silinsin mi?'))return;
  await api('/api/account/remove','POST',{accountId:id}); load();
}
async function saveAll(){
  const messages=document.getElementById('msgs').value.split('\\n').filter(l=>l.trim());
  await api('/api/messages','POST',{messages});
  await api('/api/settings','POST',{
    accountId:document.getElementById('account').value||null,
    targetId:document.getElementById('target').value.trim(),
    delay:parseInt(document.getElementById('delay').value)||2200,
    typingDelay:parseInt(document.getElementById('typing').value)||0,
    prefix:document.getElementById('prefix').value.trim(),
    usePrefix:document.getElementById('usePrefix').checked
  });
  updateCount(); alert('Kaydedildi');
}
async function startLoop(){
  await saveAll();
  const accountId=document.getElementById('account').value;
  const targetId=document.getElementById('target').value.trim();
  if(!accountId)return alert('Hesap sec');
  if(!targetId)return alert('Hedef sec');
  const res=await api('/api/loop/start','POST',{accountId,targetId,delay:parseInt(document.getElementById('delay').value)||2200});
  if(!res.ok)alert(res.error||'Baslatilamadi');
}
async function stopLoop(){ await api('/api/loop/stop','POST',{}); }
async function refreshChats(){
  const accountId=document.getElementById('account').value;
  if(!accountId)return alert('Hesap sec');
  const res=await api('/api/chats/refresh','POST',{accountId});
  if(res.chats){ state.chats=res.chats; renderChats(); }
  if(res.error)alert(res.error);
}
function addLog(e){
  const el=document.getElementById('logs');
  const d=document.createElement('div');
  d.className='log '+(e.type||'');
  d.textContent='['+(e.time||'')+'] '+(e.msg||'');
  el.insertBefore(d, el.firstChild);
}
async function load(){
  const s=await api('/api/status');
  if(!s)return;
  state.accounts=s.accounts||[];
  state.settings=s.settings||{};
  state.chats=s.chats||[];
  renderAcc(); fillSelect(); renderChats();
  if(s.settings){
    if(s.settings.accountId) document.getElementById('account').value=s.settings.accountId;
    document.getElementById('target').value=s.settings.targetId||'';
    document.getElementById('delay').value=s.settings.delay||2200;
    document.getElementById('typing').value=s.settings.typingDelay||1200;
    document.getElementById('prefix').value=s.settings.prefix||'';
    document.getElementById('usePrefix').checked=!!s.settings.usePrefix;
  }
  if(Array.isArray(s.messages)) document.getElementById('msgs').value=s.messages.join('\\n');
  updateCount();
  if(s.history) document.getElementById('hist').innerHTML=s.history.map(h=>'<tr><td>'+esc(h.time)+'</td><td>'+esc(h.body)+'</td></tr>').join('');
  if(s.logs) s.logs.slice().reverse().forEach(addLog);
  document.getElementById('btnStart').disabled=!!s.loopRunning;
}
load();
</script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

io.on('connection', (socket) => {
  socket.emit('status', snapshot());
  const accId = store.settings.accountId;
  if (accId && live[accId]?.chats) socket.emit('chats', { accountId: accId, chats: live[accId].chats });
});

server.listen(PORT, () => {
  console.log('WP Multi -> http://localhost:' + PORT);
  log('Sunucu ayakta', 'success');
  restoreAccounts().catch((e) => log('restore: ' + errText(e), 'error'));
});
