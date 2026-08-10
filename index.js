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
  accounts: {},
  settings: {
    delay: 4500,
    typingDelay: 1200,
    prefix: '',
    usePrefix: false,
    targetId: '',
    accountId: ''
  },
  messages: ['Merhaba'],
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
    store.history = store.history.slice(0, 120);
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) { console.error('save', e.message); }
}

let store = loadData();
if (Number(store.settings.delay) < 2500) store.settings.delay = 2500;

function log(msg, type = 'info', accountId = null) {
  const entry = {
    msg: String(msg).slice(0, 500),
    type,
    accountId,
    time: new Date().toLocaleTimeString('tr-TR')
  };
  store.logs.unshift(entry);
  if (store.logs.length > 250) store.logs.length = 250;
  saveData();
  io.emit('log', entry);
  console.log(`[${type}]${accountId ? '[' + accountId + ']' : ''} ${entry.msg}`);
}

/** WhatsApp/Puppeteer hatalarini tam oku (eski "r" kesmesi olmasin) */
function errText(e) {
  if (e == null) return 'bilinmeyen hata';
  if (typeof e === 'string') return e.slice(0, 500);
  const parts = [];
  if (e.name) parts.push(String(e.name));
  if (e.message) parts.push(String(e.message));
  if (e.code) parts.push('code=' + e.code);
  if (e.status) parts.push('status=' + e.status);
  if (e.response) {
    try {
      const r = e.response;
      if (typeof r === 'string') parts.push(r.slice(0, 200));
      else if (r.statusText) parts.push(String(r.statusText));
      else if (r.message) parts.push(String(r.message));
    } catch (_) {}
  }
  if (!parts.length && e.stack) {
    parts.push(String(e.stack).split('\n').slice(0, 2).join(' | '));
  }
  if (!parts.length) {
    try {
      const j = JSON.stringify(e);
      if (j && j !== '{}') parts.push(j.slice(0, 400));
      else parts.push(String(e));
    } catch (_) {
      parts.push(String(e));
    }
  }
  return parts.join(' — ').slice(0, 500);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeTarget(id) {
  if (!id) return '';
  let s = String(id).trim();
  if (!s) return '';
  if (s.includes('@')) return s;
  s = s.replace(/[\s+]/g, '');
  if (/^\d{10,15}$/.test(s)) return s + '@c.us';
  return s;
}

function isBanLike(msg) {
  const m = String(msg || '').toLowerCase();
  return /ban|restrict|block|limit|rate|403|401|logged out|session closed|execution context|target closed|not registered|evaluation failed/i.test(m);
}

function puppeteerOpts() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-software-rasterizer',
    '--no-first-run',
    '--disable-background-networking'
  ];
  const opts = { headless: true, args, timeout: 120000 };
  for (const p of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean)) {
    if (fs.existsSync(p)) {
      opts.executablePath = p;
      break;
    }
  }
  return opts;
}

// accountId -> { client, ready, qr, info, chats, loadingChats, lastChatLoad }
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
      status: L?.ready ? 'ready' : meta.status || 'off',
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
    logs: store.logs.slice(0, 80)
  };
}

function emitStatus() {
  io.emit('status', snapshot());
}

/**
 * Sohbet yukle — yavas, az deneme, hesap yormasin
 */
async function loadChats(accountId, opts = {}) {
  const L = live[accountId];
  if (!L?.ready || !L.client) {
    throw new Error('Hesap bagli degil veya hazir degil');
  }
  if (L.loadingChats) {
    throw new Error('Sohbet zaten yukleniyor, bekleyin');
  }
  const now = Date.now();
  if (L.lastChatLoad && now - L.lastChatLoad < 8000 && L.chats?.length && !opts.force) {
    io.emit('chats', { accountId, chats: L.chats });
    return L.chats;
  }

  L.loadingChats = true;
  try {
    // WhatsApp Web stabil olsun
    await sleep(opts.skipWait ? 300 : 1500);

    let chats = null;
    let lastErr = null;
    for (let i = 1; i <= 2; i++) {
      try {
        chats = await Promise.race([
          L.client.getChats(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('getChats timeout 45s')), 45000))
        ]);
        if (Array.isArray(chats)) break;
      } catch (e) {
        lastErr = e;
        const t = errText(e);
        log('getChats deneme ' + i + ': ' + t, 'warn', accountId);
        if (isBanLike(t)) {
          throw new Error('Hesap kisitli veya oturum bozulmus: ' + t);
        }
        await sleep(2000 * i);
      }
    }
    if (!Array.isArray(chats)) {
      throw lastErr || new Error('getChats basarisiz');
    }

    // Max 100 — UI ve bellek icin
    const mapped = chats
      .slice(0, 120)
      .map((c) => {
        try {
          return {
            id: c.id?._serialized || String(c.id),
            name: c.name || c.id?.user || 'Sohbet',
            isGroup: !!c.isGroup,
            unread: c.unreadCount || 0
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    mapped.sort((a, b) => {
      if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'tr');
    });

    L.chats = mapped;
    L.lastChatLoad = Date.now();
    io.emit('chats', { accountId, chats: mapped });
    log(mapped.length + ' sohbet/grup yuklendi (grup: ' + mapped.filter((x) => x.isGroup).length + ')', 'success', accountId);
    emitStatus();
    return mapped;
  } finally {
    L.loadingChats = false;
  }
}

function createClient(accountId) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId, dataPath: AUTH_ROOT }),
    puppeteer: puppeteerOpts(),
    webVersionCache: { type: 'local' },
    takeoverOnConflict: false,
    restartOnAuthFail: false
  });

  live[accountId] = {
    client,
    ready: false,
    qr: null,
    info: null,
    chats: [],
    loadingChats: false,
    lastChatLoad: 0
  };

  client.on('qr', async (qr) => {
    live[accountId].qr = qr;
    live[accountId].ready = false;
    if (store.accounts[accountId]) store.accounts[accountId].status = 'qr';
    saveData();
    try {
      const dataUrl = await qrcode.toDataURL(qr);
      io.emit('qr', { accountId, qr: dataUrl });
      log('QR hazir — telefonla okut', 'qr', accountId);
    } catch (e) {
      log('QR: ' + errText(e), 'error', accountId);
    }
    emitStatus();
  });

  client.on('authenticated', () => {
    if (store.accounts[accountId]) store.accounts[accountId].status = 'auth';
    saveData();
    log('Kimlik dogrulandi', 'auth', accountId);
    emitStatus();
  });

  client.on('ready', async () => {
    live[accountId].ready = true;
    live[accountId].qr = null;
    const info = client.info || {};
    live[accountId].info = {
      pushname: info.pushname || 'WP',
      phone: info.wid?.user || ''
    };
    store.accounts[accountId] = {
      name: live[accountId].info.pushname,
      phone: live[accountId].info.phone,
      status: 'ready'
    };
    saveData();
    log('Baglandi: ' + live[accountId].info.pushname + ' (+' + live[accountId].info.phone + ')', 'success', accountId);
    io.emit('qr', { accountId, qr: null, connected: true });
    emitStatus();

    // Otomatik sohbet — gecikmeli (hesabi yormamak icin)
    setTimeout(() => {
      loadChats(accountId).catch((e) => {
        log('Otomatik sohbet: ' + errText(e), 'warn', accountId);
      });
    }, 3500);
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
    const t = errText(reason);
    log('Koptu: ' + t, 'warn', accountId);
    emitStatus();
    if (loopRunning && store.settings.accountId === accountId) stopLoop(true);

    // Kisitli hesapta surekli re-init ban'i kotulestirir — daha seyrek
    const delay = isBanLike(t) ? 60000 : 15000;
    setTimeout(() => {
      if (!live[accountId]?.client) return;
      log('Yeniden denenecek...', 'info', accountId);
      client.initialize().catch((e) => log('re-init: ' + errText(e), 'error', accountId));
    }, delay);
  });

  return client;
}

async function startAccount(name) {
  const id = 'acc_' + Date.now();
  store.accounts[id] = { name: name || id, phone: null, status: 'starting' };
  saveData();
  const client = createClient(id);
  try {
    await client.initialize();
    return { ok: true, accountId: id };
  } catch (e) {
    log('Baslatma: ' + errText(e), 'error', id);
    return { ok: false, error: errText(e) };
  }
}

async function removeAccount(accountId) {
  const L = live[accountId];
  if (L?.client) {
    try {
      await L.client.destroy();
    } catch (_) {}
  }
  delete live[accountId];
  delete store.accounts[accountId];
  if (store.settings.accountId === accountId) store.settings.accountId = '';
  saveData();
  try {
    const dir = path.join(AUTH_ROOT, 'session-' + accountId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
  emitStatus();
  log('Hesap silindi', 'warn', accountId);
}

function buildBody(text) {
  let msg = String(text || '');
  if (store.settings.usePrefix && store.settings.prefix) {
    const parts = String(store.settings.prefix).trim().split(/[\s,;]+/).filter(Boolean);
    const tags = parts.map((p) => {
      const d = p.replace(/\D/g, '');
      return d.length >= 10 ? '@' + d : p;
    });
    if (tags.length) msg = tags.join(' ') + ' ' + msg;
  }
  return msg.slice(0, 60000);
}

async function sendOne(accountId, targetId, text) {
  const L = live[accountId];
  if (!L?.ready || !L.client) throw new Error('Hesap hazir degil');
  targetId = normalizeTarget(targetId);
  if (!targetId) throw new Error('Hedef bos');

  const body = buildBody(text);
  let chatName = targetId;

  try {
    const chat = await L.client.getChatById(targetId);
    chatName = chat?.name || targetId;
    const typingMs = Math.max(0, Math.min(8000, Number(store.settings.typingDelay) || 0));
    if (typingMs > 0 && chat?.sendStateTyping) {
      try {
        await chat.sendStateTyping();
        await sleep(typingMs);
      } catch (e) {
        log('Typing: ' + errText(e), 'warn', accountId);
      }
    }
  } catch (e) {
    const t = errText(e);
    if (isBanLike(t)) throw new Error('Kisit/oturum: ' + t);
    log('getChat: ' + t, 'warn', accountId);
  }

  await L.client.sendMessage(targetId, body);

  try {
    const chat = await L.client.getChatById(targetId).catch(() => null);
    if (chat?.clearState) await chat.clearState();
  } catch (_) {}

  const hist = {
    time: new Date().toLocaleTimeString('tr-TR'),
    accountId,
    target: targetId,
    body: body.slice(0, 100)
  };
  store.history.unshift(hist);
  if (store.history.length > 120) store.history.length = 120;
  saveData();
  io.emit('history', hist);
  log('Gonderildi → ' + String(chatName).slice(0, 28) + ': ' + body.slice(0, 40), 'send', accountId);
  return hist;
}

function stopLoop(save = true) {
  loopRunning = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
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

  // Minimum guvenli hiz
  const delay = Math.max(3000, Number(store.settings.delay) || 4500);
  store.settings.delay = delay;
  saveData();

  loopRunning = true;
  io.emit('loop', { running: true });
  log('Dongu basladi (min ' + delay + 'ms) — hizli spam hesap kisitlar', 'success', accId);

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
      if (loopRunning) loopTimer = setTimeout(tick, delay);
    } catch (e) {
      const t = errText(e);
      log('Gonderme: ' + t, 'error', accId);
      if (isBanLike(t)) {
        log('Kisit/ban benzeri hata — dongu DURDURULDU. Hesabi dinlendir.', 'error', accId);
        return stopLoop(true);
      }
      if (loopRunning) loopTimer = setTimeout(tick, Math.max(5000, delay));
    }
  };
  tick();
}

async function restoreAccounts() {
  for (const id of Object.keys(store.accounts)) {
    if (store.accounts[id].status === 'removed') continue;
    log('Kayitli hesap yukleniyor...', 'info', id);
    try {
      const client = createClient(id);
      await client.initialize();
      await sleep(2000);
    } catch (e) {
      log('Restore: ' + errText(e), 'error', id);
    }
  }
}

app.use(express.json({ limit: '2mb' }));

app.get('/api/ping', (_req, res) => res.json({ ok: true }));

app.get('/api/status', (req, res) => {
  const snap = snapshot();
  const acc = req.query.accountId || store.settings.accountId;
  snap.chats = (acc && live[acc]?.chats) || [];
  res.json(snap);
});

app.post('/api/account/add', async (req, res) => {
  try {
    const r = await startAccount((req.body?.name || '').trim());
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: errText(e) });
  }
});

app.post('/api/account/remove', async (req, res) => {
  try {
    const id = req.body?.accountId;
    if (!id) return res.json({ ok: false, error: 'id yok' });
    await removeAccount(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: errText(e) });
  }
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.delay !== undefined) store.settings.delay = Math.max(3000, Number(b.delay) || 4500);
  if (b.typingDelay !== undefined) store.settings.typingDelay = Math.max(0, Number(b.typingDelay) || 0);
  if (b.prefix !== undefined) store.settings.prefix = String(b.prefix || '');
  if (typeof b.usePrefix === 'boolean') store.settings.usePrefix = b.usePrefix;
  if (b.targetId !== undefined) store.settings.targetId = normalizeTarget(b.targetId);
  if (b.accountId !== undefined) store.settings.accountId = String(b.accountId || '');
  saveData();
  log('Ayarlar kaydedildi', 'info');
  res.json({ ok: true, settings: store.settings });
});

app.post('/api/messages', (req, res) => {
  let msgs = req.body?.messages;
  if (typeof msgs === 'string') msgs = msgs.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!Array.isArray(msgs)) msgs = [];
  store.messages = msgs.map((m) => String(m).trim()).filter(Boolean);
  saveData();
  log(store.messages.length + ' mesaj kaydedildi', 'success');
  res.json({ ok: true, count: store.messages.length });
});

app.post('/api/chats', async (req, res) => {
  try {
    const id = req.body?.accountId || store.settings.accountId;
    if (!id) return res.json({ ok: false, error: 'Hesap secilmedi' });
    const chats = await loadChats(id, { force: !!req.body?.force });
    res.json({ ok: true, chats });
  } catch (e) {
    const t = errText(e);
    log('Sohbet yukleme: ' + t, 'error', req.body?.accountId);
    res.status(500).json({ ok: false, error: t });
  }
});

app.post('/api/loop/start', (req, res) => {
  if (req.body?.accountId) store.settings.accountId = String(req.body.accountId);
  if (req.body?.targetId) store.settings.targetId = normalizeTarget(req.body.targetId);
  if (req.body?.delay) store.settings.delay = Math.max(3000, Number(req.body.delay) || 4500);
  saveData();
  startLoop();
  res.json({ ok: true, running: loopRunning, delay: store.settings.delay });
});

app.post('/api/loop/stop', (_req, res) => {
  stopLoop(true);
  res.json({ ok: true });
});

app.post('/api/send', async (req, res) => {
  try {
    const accountId = req.body?.accountId || store.settings.accountId;
    const targetId = req.body?.targetId || store.settings.targetId;
    const hist = await sendOne(accountId, targetId, req.body?.text || '');
    res.json({ ok: true, hist });
  } catch (e) {
    res.status(500).json({ ok: false, error: errText(e) });
  }
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
h1{text-align:center;color:#25d366;font-size:22px;margin-bottom:4px}
.sub{text-align:center;color:#666;font-size:11px;margin-bottom:12px}
.warn{background:#2a1a0a;border:1px solid #5a3a1a;color:#e3b341;border-radius:10px;padding:10px;font-size:12px;margin-bottom:12px;line-height:1.4}
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:12px;margin-bottom:10px}
.card h3{font-size:11px;color:#888;text-transform:uppercase;margin-bottom:8px}
label{display:block;font-size:12px;color:#aaa;margin:8px 0 4px}
input,textarea,select{width:100%;background:#0d0d0d;border:1px solid #333;border-radius:8px;padding:10px;color:#eee;font-size:13px}
textarea{min-height:90px;resize:vertical;font-family:inherit}
.btn{border:none;border-radius:8px;padding:11px;font-weight:700;font-size:13px;cursor:pointer}
.btn-g{background:#25d366;color:#000}.btn-r{background:#e74c3c;color:#fff}.btn-s{background:#2a2a2a;color:#ccc}
.btn-full{width:100%;margin-top:8px}
.row{display:flex;gap:8px;margin-top:8px}
.row .btn{flex:1}
.acc{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:8px;padding:10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.acc.on{border-color:#25d366}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;background:#666}
.dot.on{background:#25d366}.dot.qr{background:#e3b341}
.qrbox{text-align:center;min-height:100px;padding:8px}
.qrbox img{width:200px;border:3px solid #25d366;border-radius:8px}
.chats{max-height:180px;overflow-y:auto;background:#0d0d0d;border-radius:8px}
.ci{padding:9px 10px;border-bottom:1px solid #1a1a1a;cursor:pointer;font-size:13px;display:flex;justify-content:space-between}
.ci:hover,.ci.sel{background:#1a2a1a}
.tag{font-size:10px;color:#25d366}
.logs{max-height:160px;overflow-y:auto;font-family:ui-monospace,monospace;font-size:11px;background:#0d0d0d;border-radius:8px;padding:8px}
.log{padding:2px 0;color:#888;word-break:break-word}.log.error{color:#e74c3c}.log.success{color:#25d366}.log.warn{color:#e3b341}.log.send{color:#53bdeb}.log.qr{color:#e3b341}
.count{font-size:12px;color:#25d366;font-weight:700}
.file-btn{display:inline-block;background:#1f3d2a;color:#25d366;border:1px solid #2a5a3a;border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer}
.hint{font-size:11px;color:#666;margin-top:4px}
</style>
</head>
<body>
<div class="panel">
  <h1>WhatsApp Multi</h1>
  <p class="sub">Coklu hesap · Grup · Typing · Kalici oturum</p>
  <div class="warn">⚠️ Hizli dongu / cok hesap = WhatsApp kisitlar. Min hiz 3sn. Kisit yersen 24–48s hesabi dinlendir, QR yeniden okut.</div>

  <div class="card">
    <h3>Hesaplar</h3>
    <div class="row">
      <input id="accName" placeholder="Isim (ops)" style="flex:1">
      <button class="btn btn-g" onclick="addAcc()">+ QR</button>
    </div>
    <div id="accList" style="margin-top:8px"></div>
    <div class="qrbox" id="qrBox"><div style="color:#666">QR icin hesap ekle</div></div>
  </div>

  <div class="card">
    <h3>Gonderim</h3>
    <label>Aktif hesap</label>
    <select id="accSel" onchange="onAcc()"></select>
    <label>Hedef (@c.us / @g.us)</label>
    <input id="target" placeholder="905xxxxxxxxx@c.us">
    <label>Hiz ms (min 3000 — kisit riski)</label>
    <input id="delay" type="number" min="3000" step="500" value="4500">
    <label>Typing ms</label>
    <input id="typing" type="number" min="0" step="100" value="1200">
    <label>Prefix numaralar</label>
    <input id="prefix" placeholder="90555... 90555...">
    <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="usePrefix"> Prefix aktif</label>
    <label>Mesajlar (satir = 1)</label>
    <textarea id="msgs"></textarea>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
      <label class="file-btn">TXT<input type="file" id="txt" accept=".txt,text/plain" hidden></label>
      <span class="count" id="mc">0 mesaj</span>
    </div>
    <div class="row">
      <button class="btn btn-g" onclick="startL()">Baslat</button>
      <button class="btn btn-r" onclick="stopL()">Durdur</button>
    </div>
    <button class="btn btn-s btn-full" onclick="loadChats(true)">Sohbet / Grup Yukle</button>
    <button class="btn btn-s btn-full" onclick="saveAll()">Kaydet</button>
    <p class="hint">Sohbet yuklenmezse: hesap kisitli veya QR yeniden gerekir. 10sn ara ile tekrar dene.</p>
  </div>

  <div class="card">
    <h3>Gruplar & Sohbetler</h3>
    <div class="chats" id="chats"><div style="padding:12px;color:#666;text-align:center">Hesap sec / yukle</div></div>
  </div>

  <div class="card">
    <h3>Log</h3>
    <div class="logs" id="logs"></div>
  </div>
</div>
<script>
const socket=io();
let state={accounts:[],settings:{},messages:[],logs:[]};
let chats=[];
socket.on('qr',d=>{
  const box=document.getElementById('qrBox');
  if(d.connected||!d.qr) box.innerHTML='<div style="color:#25d366">Baglandi</div>';
  else box.innerHTML='<img src="'+d.qr+'"><div style="font-size:11px;color:#888;margin-top:4px">'+esc(d.accountId)+'</div>';
});
socket.on('status',s=>{state.accounts=s.accounts||[];state.settings=s.settings||state.settings;renderAcc();fillForm();});
socket.on('chats',d=>{if(d.accountId===document.getElementById('accSel').value||!d.accountId){chats=d.chats||[];renderChats();}});
socket.on('log',e=>addLog(e));
socket.on('loop',d=>{});

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
async function api(u,m,b){
  try{
    const o={method:m||'GET',headers:{'Content-Type':'application/json'}};
    if(b)o.body=JSON.stringify(b);
    const r=await fetch(u,o);
    const t=await r.text();
    try{return JSON.parse(t);}catch(_){return{ok:false,error:t.slice(0,200)};}
  }catch(e){return{ok:false,error:e.message};}
}
function addLog(e){
  const el=document.getElementById('logs');
  const d=document.createElement('div');
  d.className='log '+(e.type||'');
  d.textContent='['+(e.time||'')+'] '+(e.msg||'');
  el.insertBefore(d,el.firstChild);
}
function renderAcc(){
  const list=document.getElementById('accList');
  const sel=document.getElementById('accSel');
  const accs=state.accounts||[];
  if(!accs.length){list.innerHTML='<div style="color:#666;font-size:12px">Hesap yok</div>';sel.innerHTML='<option value="">—</option>';return;}
  list.innerHTML=accs.map(a=>{
    const d=a.ready?'on':(a.status==='qr'?'qr':'');
    const on=a.id===document.getElementById('accSel').value?' on':'';
    return '<div class="acc'+on+'"><span><span class="dot '+d+'"></span>'+esc(a.name)+(a.phone?' · +'+esc(a.phone):'')+' · '+esc(a.status)+'</span><button class="btn btn-r" style="padding:4px 8px;font-size:11px" onclick="rmAcc(\\''+a.id+'\\')">Sil</button></div>';
  }).join('');
  const cur=sel.value||state.settings.accountId||'';
  sel.innerHTML=accs.map(a=>'<option value="'+a.id+'"'+(a.id===cur?' selected':'')+'>'+esc(a.name)+(a.ready?' ✓':'')+'</option>').join('');
}
function renderChats(){
  const el=document.getElementById('chats');
  if(!chats.length){el.innerHTML='<div style="padding:12px;color:#666;text-align:center">Sohbet yok / yuklenemedi</div>';return;}
  const cur=document.getElementById('target').value;
  el.innerHTML=chats.map(c=>'<div class="ci'+(c.id===cur?' sel':'')+'" onclick="document.getElementById(\\'target\\').value=\\''+String(c.id).replace(/'/g,"\\\\'")+'\\';renderChats()"><span>'+esc(c.name)+'</span>'+(c.isGroup?'<span class="tag">GRUP</span>':'')+'</div>').join('');
}
function fillForm(){
  const s=state.settings||{};
  if(s.delay)document.getElementById('delay').value=Math.max(3000,s.delay);
  if(s.typingDelay!=null)document.getElementById('typing').value=s.typingDelay;
  if(s.prefix!=null)document.getElementById('prefix').value=s.prefix;
  document.getElementById('usePrefix').checked=!!s.usePrefix;
  if(s.targetId)document.getElementById('target').value=s.targetId;
  if(Array.isArray(state.messages)){document.getElementById('msgs').value=state.messages.join('\\n');updC();}
}
function updC(){document.getElementById('mc').textContent=document.getElementById('msgs').value.split('\\n').filter(l=>l.trim()).length+' mesaj';}
document.getElementById('msgs').oninput=updC;
document.getElementById('txt').onchange=function(){
  const f=this.files&&this.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=async()=>{
    const lines=String(r.result||'').split(/\\r?\\n/).map(l=>l.trim()).filter(Boolean);
    document.getElementById('msgs').value=lines.join('\\n');updC();
    await api('/api/messages','POST',{messages:lines});
    alert(lines.length+' mesaj yuklendi');
  };
  r.readAsText(f,'UTF-8');this.value='';
};
async function addAcc(){
  const res=await api('/api/account/add','POST',{name:document.getElementById('accName').value.trim()});
  if(!res.ok)return alert(res.error||'Hata');
  document.getElementById('accName').value='';
  document.getElementById('qrBox').innerHTML='<div style="color:#e3b341">QR hazirlaniyor...</div>';
  load();
}
async function rmAcc(id){if(!confirm('Silinsin mi?'))return;await api('/api/account/remove','POST',{accountId:id});load();}
function onAcc(){const id=document.getElementById('accSel').value;api('/api/settings','POST',{accountId:id});loadChats(false);}
async function loadChats(force){
  const id=document.getElementById('accSel').value;
  if(!id)return alert('Hesap sec');
  const res=await api('/api/chats','POST',{accountId:id,force:!!force});
  if(!res.ok)alert('Sohbet: '+(res.error||'hata'));
  else{chats=res.chats||[];renderChats();}
}
async function saveAll(){
  const messages=document.getElementById('msgs').value.split('\\n').filter(l=>l.trim());
  await api('/api/messages','POST',{messages});
  await api('/api/settings','POST',{
    accountId:document.getElementById('accSel').value,
    targetId:document.getElementById('target').value.trim(),
    delay:Math.max(3000,parseInt(document.getElementById('delay').value)||4500),
    typingDelay:parseInt(document.getElementById('typing').value)||0,
    prefix:document.getElementById('prefix').value.trim(),
    usePrefix:document.getElementById('usePrefix').checked
  });
  updC();alert('Kaydedildi');
}
async function startL(){
  await saveAll();
  const res=await api('/api/loop/start','POST',{
    accountId:document.getElementById('accSel').value,
    targetId:document.getElementById('target').value.trim(),
    delay:Math.max(3000,parseInt(document.getElementById('delay').value)||4500)
  });
  if(!res.ok)alert(res.error||'Baslamadi');
}
async function stopL(){await api('/api/loop/stop','POST',{});}
async function load(){
  const s=await api('/api/status');
  if(!s||s.error)return;
  state.accounts=s.accounts||[];
  state.settings=s.settings||{};
  state.messages=s.messages||[];
  state.logs=s.logs||[];
  chats=s.chats||[];
  renderAcc();fillForm();renderChats();
  document.getElementById('logs').innerHTML='';
  (state.logs||[]).slice().reverse().forEach(addLog);
}
load();
setInterval(load,12000);
</script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

io.on('connection', async (socket) => {
  socket.emit('status', snapshot());
  for (const [id, L] of Object.entries(live)) {
    if (L.qr) {
      try {
        const url = await qrcode.toDataURL(L.qr);
        socket.emit('qr', { accountId: id, qr: url });
      } catch (_) {}
    }
    if (L.ready && L.chats?.length) socket.emit('chats', { accountId: id, chats: L.chats });
  }
});

server.listen(PORT, () => {
  console.log('WP Multi -> http://localhost:' + PORT);
  log('Sunucu ayakta', 'success');
  restoreAccounts().catch((e) => log('restore: ' + errText(e), 'error'));
});
