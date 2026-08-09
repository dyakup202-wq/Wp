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
const AUTH_PATH = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });

const DEFAULT = {
  settings: {
    delay: 2200,
    typingDelay: 800,
    prefix: '',
    usePrefix: false,
    loopEnabled: false,
    targetId: ''
  },
  messages: ['Merhaba', 'Nasılsın?', 'Test mesajı 123'],
  logs: [],
  history: []
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return {
        settings: { ...DEFAULT.settings, ...(d.settings || {}) },
        messages: Array.isArray(d.messages) ? d.messages : DEFAULT.messages.slice(),
        logs: Array.isArray(d.logs) ? d.logs : [],
        history: Array.isArray(d.history) ? d.history : []
      };
    }
  } catch (e) {
    console.error('load:', e);
  }
  return JSON.parse(JSON.stringify(DEFAULT));
}

function saveData() {
  try {
    store.logs = store.logs.slice(0, 300);
    store.history = store.history.slice(0, 200);
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('save:', e);
  }
}

let store = loadData();

function log(msg, type = 'info') {
  const entry = {
    msg: String(msg).slice(0, 500),
    type,
    time: new Date().toLocaleTimeString('tr-TR')
  };
  store.logs.unshift(entry);
  if (store.logs.length > 300) store.logs.length = 300;
  try { saveData(); } catch (_) {}
  io.emit('log', entry);
  console.log(`[${type}] ${msg}`);
}

function errText(e) {
  try {
    if (e == null) return 'bilinmeyen hata';
    if (typeof e === 'string') return e.slice(0, 400);
    if (e instanceof Error) {
      return ((e.name ? e.name + ': ' : '') + (e.message || '')).slice(0, 400) || e.stack?.slice(0, 200) || 'Error';
    }
    if (typeof e === 'object') {
      if (e.message) return String(e.message).slice(0, 400);
      try { return JSON.stringify(e).slice(0, 400); } catch (_) {}
    }
    return String(e).slice(0, 400);
  } catch (_) {
    return 'hata okunamadi';
  }
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPuppeteerOpts() {
  // Railway/Docker icin stabil bayraklar (single-process KALDIRILDI — hatalara yol aciyordu)
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-software-rasterizer',
    '--font-render-hinting=none'
  ];
  const opts = { headless: true, args, timeout: 120000 };

  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '';
  if (envPath && fs.existsSync(envPath)) {
    opts.executablePath = envPath;
    log('Chromium: sistem (' + envPath + ')', 'info');
    return opts;
  }

  try {
    const chromium = require('@sparticuz/chromium');
    opts.args = [...new Set([...(chromium.args || []), ...args])];
    opts.headless = typeof chromium.headless === 'boolean' ? chromium.headless : true;
    opts.executablePath = await chromium.executablePath();
    log('Chromium: @sparticuz', 'info');
    return opts;
  } catch (e) {
    log('sparticuz yok, varsayilan chrome: ' + errText(e), 'warn');
  }
  return opts;
}

let client = null;
let clientReady = false;
let currentQR = null;
let loopTimer = null;
let loopRunning = false;
let loopIndex = 0;
let chatCache = [];
let initLock = false;

async function createClient() {
  const puppeteer = await getPuppeteerOpts();
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_PATH, clientId: 'main' }),
    puppeteer,
    webVersionCache: { type: 'none' },
    restartOnAuthFail: true
  });

  client.on('qr', async (qr) => {
    currentQR = qr;
    clientReady = false;
    log('QR kod hazir — WhatsApp > Bagli Cihazlar ile okut', 'qr');
    try {
      const url = await qrcode.toDataURL(qr);
      io.emit('qr', { qr: url });
      io.emit('status', { connected: false, phase: 'qr' });
    } catch (e) {
      log('QR dataURL: ' + errText(e), 'error');
    }
  });

  client.on('loading_screen', (percent, message) => {
    log('Yukleniyor: ' + percent + '% ' + (message || ''), 'info');
    io.emit('status', { connected: false, phase: 'loading', percent });
  });

  client.on('authenticated', () => {
    log('Kimlik dogrulandi, sohbetler hazirlaniyor...', 'auth');
    io.emit('status', { connected: false, phase: 'auth' });
  });

  client.on('ready', async () => {
    try {
      // Store'un dolmasi icin kisa bekle
      await sleep(2000);
      clientReady = true;
      currentQR = null;
      const name = client.info?.pushname || 'WhatsApp';
      const phone = client.info?.wid?.user || client.info?.me?.user || '';
      log('Baglandi: ' + name + (phone ? ' (+' + phone + ')' : ''), 'success');
      io.emit('qr', { qr: null, connected: true });
      io.emit('status', { connected: true, phase: 'ready', name, phone });
      await refreshChats();
    } catch (e) {
      log('ready isleme: ' + errText(e), 'error');
    }
  });

  client.on('auth_failure', (m) => {
    clientReady = false;
    log('Auth hatasi: ' + errText(m), 'error');
    io.emit('status', { connected: false, phase: 'auth_fail', error: errText(m) });
  });

  client.on('disconnected', (reason) => {
    clientReady = false;
    stopLoop(false);
    log('Baglanti kesildi: ' + errText(reason), 'warn');
    io.emit('status', { connected: false, phase: 'disconnected', reason: errText(reason) });
    setTimeout(() => {
      if (initLock) return;
      log('Yeniden baglaniyor...', 'info');
      client.initialize().catch((e) => log('Re-init: ' + errText(e), 'error'));
    }, 8000);
  });
}

async function refreshChats() {
  if (!client) {
    log('Sohbet: client yok', 'warn');
    return [];
  }
  if (!clientReady) {
    log('Sohbet: henuz hazir degil (QR / yukleme bekleniyor)', 'warn');
    return [];
  }
  try {
    await sleep(300);
    let chats = null;
    let lastErr = null;
    for (let i = 1; i <= 3; i++) {
      try {
        chats = await client.getChats();
        if (Array.isArray(chats)) break;
      } catch (e) {
        lastErr = e;
        log('getChats deneme ' + i + '/3: ' + errText(e), 'warn');
        await sleep(1000 * i);
      }
    }
    if (!Array.isArray(chats)) {
      throw lastErr || new Error('getChats dizi dondurmedi');
    }

    chatCache = chats.slice(0, 250).map((c) => {
      try {
        const id = (c.id && (c.id._serialized || c.id)) || '';
        return {
          id: String(id),
          name: c.name || c.formattedTitle || (c.id && c.id.user) || String(id),
          isGroup: !!c.isGroup,
          unread: c.unreadCount || 0
        };
      } catch (_) {
        return null;
      }
    }).filter((c) => c && c.id);

    chatCache.sort((a, b) => {
      if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'tr');
    });

    io.emit('chats', chatCache);
    log(chatCache.length + ' sohbet yuklendi', 'success');
    return chatCache;
  } catch (e) {
    log('Sohbet yukleme HATA: ' + errText(e), 'error');
    return [];
  }
}

function buildBody(text) {
  let msg = String(text || '');
  if (store.settings.usePrefix && store.settings.prefix) {
    const parts = String(store.settings.prefix).trim().split(/[\s,;]+/).filter(Boolean);
    const tags = parts.map((p) => {
      const digits = String(p).replace(/\D/g, '');
      if (digits.length >= 10) return '@' + digits;
      return p;
    });
    if (tags.length) msg = tags.join(' ') + ' ' + msg;
  }
  return msg.slice(0, 65000);
}

async function sendOne(targetId, text) {
  if (!client || !clientReady) {
    throw new Error('WhatsApp bagli degil — QR okut / baglanti bekle');
  }
  targetId = normalizeTarget(targetId);
  if (!targetId) throw new Error('Hedef bos');
  if (!targetId.includes('@')) {
    throw new Error('Hedef formati yanlis. Ornek: 905xxxxxxxxx@c.us veya xxxxx@g.us');
  }

  const body = buildBody(text);
  if (!body.trim()) throw new Error('Mesaj bos');

  // Once chat nesnesini dene; olmazsa dogrudan sendMessage
  let chatName = targetId;
  try {
    const chat = await client.getChatById(targetId);
    if (chat) {
      chatName = chat.name || targetId;
      const typingMs = Math.max(0, Number(store.settings.typingDelay) || 0);
      if (typingMs > 0) {
        try {
          await chat.sendStateTyping();
          await sleep(typingMs);
        } catch (_) {}
      }
    }
  } catch (e) {
    log('getChatById uyari: ' + errText(e) + ' — dogrudan gonderilecek', 'warn');
  }

  try {
    await client.sendMessage(targetId, body);
  } catch (e) {
    throw new Error('Gonderilemedi [' + targetId + ']: ' + errText(e));
  }

  const hist = {
    time: new Date().toLocaleTimeString('tr-TR'),
    target: targetId,
    body: body.slice(0, 120)
  };
  store.history.unshift(hist);
  if (store.history.length > 200) store.history.length = 200;
  saveData();
  io.emit('history', hist);
  log('Gonderildi → ' + String(chatName).slice(0, 28) + ': ' + body.slice(0, 40), 'send');
  return hist;
}

function stopLoop(save = true) {
  loopRunning = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  store.settings.loopEnabled = false;
  if (save) saveData();
  io.emit('loop', { running: false });
  log('Dongu durduruldu', 'warn');
}

function startLoop() {
  if (loopRunning) {
    log('Dongu zaten calisiyor', 'warn');
    return;
  }
  if (!clientReady) {
    log('Dongu icin once WhatsApp baglansin', 'error');
    return;
  }
  if (!store.settings.targetId) {
    log('Hedef secilmedi', 'error');
    return;
  }
  if (!store.messages.length) {
    log('Mesaj listesi bos', 'error');
    return;
  }

  loopRunning = true;
  store.settings.loopEnabled = true;
  saveData();
  io.emit('loop', { running: true });
  log('Dongu basladi → ' + store.settings.targetId, 'success');

  const tick = async () => {
    if (!loopRunning) return;
    try {
      if (!clientReady) {
        log('Baglanti koptu, dongu duruyor', 'error');
        stopLoop(true);
        return;
      }
      const msgs = store.messages;
      if (!msgs.length) {
        stopLoop(true);
        return;
      }
      const text = msgs[loopIndex % msgs.length];
      loopIndex++;
      await sendOne(store.settings.targetId, text);
      const delay = Math.max(800, Number(store.settings.delay) || 2200);
      if (loopRunning) loopTimer = setTimeout(tick, delay);
    } catch (e) {
      log('Gonderme hatasi: ' + errText(e), 'error');
      const delay = Math.max(3000, Number(store.settings.delay) || 2200);
      if (loopRunning) loopTimer = setTimeout(tick, delay);
    }
  };
  tick();
}

// ─── API ──────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

app.get('/api/ping', (_req, res) => res.json({ ok: true, ready: clientReady }));

app.get('/api/status', (_req, res) => {
  res.json({
    connected: clientReady,
    phase: clientReady ? 'ready' : (currentQR ? 'qr' : 'init'),
    name: client?.info?.pushname || null,
    phone: client?.info?.wid?.user || null,
    settings: store.settings,
    messages: store.messages,
    messageCount: store.messages.length,
    loopRunning,
    chats: chatCache,
    history: store.history.slice(0, 50),
    logs: store.logs.slice(0, 80)
  });
});

app.post('/api/settings', (req, res) => {
  try {
    const b = req.body || {};
    if (b.delay !== undefined) store.settings.delay = Math.max(800, Number(b.delay) || 2200);
    if (b.typingDelay !== undefined) store.settings.typingDelay = Math.max(0, Number(b.typingDelay) || 0);
    if (b.prefix !== undefined) store.settings.prefix = String(b.prefix || '');
    if (typeof b.usePrefix === 'boolean') store.settings.usePrefix = b.usePrefix;
    if (b.targetId !== undefined) store.settings.targetId = normalizeTarget(b.targetId);
    saveData();
    log('Ayarlar kaydedildi', 'info');
    res.json({ ok: true, settings: store.settings });
  } catch (e) {
    res.status(500).json({ ok: false, error: errText(e) });
  }
});

app.post('/api/messages', (req, res) => {
  try {
    let msgs = req.body?.messages;
    if (typeof msgs === 'string') {
      msgs = msgs.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    if (!Array.isArray(msgs)) msgs = [];
    store.messages = msgs.map((m) => String(m).trim()).filter(Boolean);
    saveData();
    log(store.messages.length + ' mesaj kaydedildi', 'success');
    res.json({ ok: true, count: store.messages.length, messages: store.messages });
  } catch (e) {
    res.status(500).json({ ok: false, error: errText(e) });
  }
});

app.post('/api/loop/start', (req, res) => {
  try {
    if (req.body?.targetId) store.settings.targetId = normalizeTarget(req.body.targetId);
    if (req.body?.delay) store.settings.delay = Math.max(800, Number(req.body.delay) || 2200);
    saveData();
    startLoop();
    res.json({ ok: true, running: loopRunning, targetId: store.settings.targetId });
  } catch (e) {
    res.status(500).json({ ok: false, error: errText(e) });
  }
});

app.post('/api/loop/stop', (_req, res) => {
  stopLoop(true);
  res.json({ ok: true, running: false });
});

app.post('/api/chats/refresh', async (_req, res) => {
  try {
    const chats = await refreshChats();
    res.json({ ok: true, chats, count: chats.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: errText(e) });
  }
});

app.post('/api/send', async (req, res) => {
  try {
    const targetId = normalizeTarget(req.body?.targetId || store.settings.targetId);
    const text = req.body?.text;
    const hist = await sendOne(targetId, text);
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
<title>WhatsApp Panel</title>
<script src="/socket.io/socket.io.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e8e8e8;min-height:100vh;padding:12px}
.panel{max-width:480px;margin:0 auto;background:#121212;border:1px solid #222;border-radius:16px;padding:18px 16px 24px}
.logo{text-align:center;margin-bottom:14px}
.logo h1{font-size:26px;font-weight:800;color:#25d366}
.status-bar{display:flex;justify-content:space-between;align-items:center;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:10px 14px;margin-bottom:12px;font-size:13px}
.status-bar .left{display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:#666}
.dot.on{background:#25d366;box-shadow:0 0 8px #25d366}
.dot.wait{background:#e3b341}
.qr-wrap{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:12px;min-height:240px;display:flex;align-items:center;justify-content:center;margin-bottom:14px;padding:12px}
.qr-wrap img{width:220px;height:220px;border-radius:8px;border:3px solid #25d366}
.qr-wrap .ph{color:#666;font-size:14px;text-align:center}
label{display:block;font-size:12px;color:#aaa;margin:10px 0 5px;font-weight:600}
input,textarea{width:100%;background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:11px 12px;color:#eee;font-size:14px;outline:none}
input:focus,textarea:focus{border-color:#25d366}
textarea{min-height:100px;resize:vertical;font-family:inherit;line-height:1.45}
.row{display:flex;gap:8px;margin-top:12px}
.btn{flex:1;border:none;border-radius:10px;padding:12px;font-weight:700;font-size:14px;cursor:pointer}
.btn-g{background:#25d366;color:#000}.btn-r{background:#e74c3c;color:#fff}
.btn-s{background:#2a2a2a;color:#ccc;width:100%;margin-top:8px}
.btn:disabled{opacity:.5}
.file-row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.file-btn{background:#1f3d2a;color:#25d366;border:1px solid #2a5a3a;border-radius:8px;padding:8px 12px;font-size:12px;font-weight:600;cursor:pointer}
.count{font-size:12px;color:#25d366;font-weight:700}
.hint{font-size:11px;color:#666;margin-top:4px}
.toggle{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:#bbb}
.section{margin-top:16px}
.section h3{font-size:13px;color:#888;margin-bottom:8px}
.chat-list{max-height:180px;overflow-y:auto;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:10px}
.chat-item{padding:10px 12px;border-bottom:1px solid #1f1f1f;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;gap:8px}
.chat-item:hover,.chat-item.on{background:#1a2a1a}
.chat-item .tag{font-size:10px;color:#25d366;flex-shrink:0}
.hist{width:100%;border-collapse:collapse;font-size:12px}
.hist th{text-align:left;color:#666;padding:6px 8px;border-bottom:1px solid #2a2a2a}
.hist td{padding:6px 8px;border-bottom:1px solid #1a1a1a;color:#ccc;vertical-align:top;word-break:break-word}
.logs{max-height:160px;overflow-y:auto;font-family:ui-monospace,monospace;font-size:11px;background:#0d0d0d;border-radius:8px;padding:8px;margin-top:8px}
.log{color:#888;padding:3px 0;word-break:break-word;white-space:pre-wrap}
.log.success{color:#25d366}.log.error{color:#e74c3c}.log.warn{color:#e3b341}
.log.send{color:#53bdeb}.log.qr{color:#e3b341}.log.auth{color:#53bdeb}
</style>
</head>
<body>
<div class="panel">
  <div class="logo"><h1>💬 WhatsApp Panel</h1></div>
  <div class="status-bar">
    <div class="left"><span class="dot" id="dot"></span><span id="statusText">Baglaniyor...</span></div>
    <div id="chatCount">0 sohbet</div>
  </div>
  <div class="qr-wrap" id="qrBox"><div class="ph">QR Kod Yukleniyor...</div></div>
  <label>Hedef ID (numara@c.us veya grup ID)</label>
  <input id="target" placeholder="905551112233@c.us">
  <label>Hiz (ms)</label>
  <input id="delay" type="number" min="800" step="100" value="2200">
  <label>Typing (ms)</label>
  <input id="typing" type="number" min="0" step="100" value="800">
  <label>Prefix / etiket (numara — boslukla coklu)</label>
  <input id="prefix" placeholder="905551112233">
  <label class="toggle"><input type="checkbox" id="usePrefix"> Prefix aktif</label>
  <label>Mesajlar (her satir = 1 mesaj — sonsuz dongu)</label>
  <textarea id="msgs" placeholder="Merhaba&#10;Nasilsin?"></textarea>
  <div class="file-row">
    <label class="file-btn">📄 TXT Yukle<input type="file" id="txtFile" accept=".txt,text/plain" hidden></label>
    <span class="count" id="msgCount">0 mesaj</span>
  </div>
  <p class="hint">TXT: her satir 1 mesaj. Once bagli ol, sohbetleri yukle, hedef sec, baslat.</p>
  <div class="row">
    <button class="btn btn-g" id="btnStart" onclick="startLoop()">▶ Baslat</button>
    <button class="btn btn-r" id="btnStop" onclick="stopLoop()">■ Durdur</button>
  </div>
  <button class="btn btn-s" onclick="refreshChats()">↻ Sohbetleri Yukle</button>
  <button class="btn btn-s" onclick="saveAll()">💾 Ayar & Mesajlari Kaydet</button>
  <div class="section">
    <h3>Sohbet Listesi</h3>
    <div class="chat-list" id="chatList"><div class="ph" style="padding:16px;text-align:center">Bagli olunca yukle</div></div>
  </div>
  <div class="section">
    <h3>Mesaj Gecmisi</h3>
    <table class="hist"><thead><tr><th>Saat</th><th>Mesaj</th></tr></thead><tbody id="histBody"></tbody></table>
  </div>
  <div class="section"><h3>Log</h3><div class="logs" id="logs"></div></div>
</div>
<script>
const socket = io({ transports: ['websocket', 'polling'] });
let chats = [];

socket.on('qr', (d) => {
  const box = document.getElementById('qrBox');
  if (d.connected || !d.qr) box.innerHTML = '<div class="ph" style="color:#25d366;font-size:22px">Baglandi</div>';
  else box.innerHTML = '<img src="'+d.qr+'" alt="QR">';
});
socket.on('status', (d) => {
  const dot = document.getElementById('dot');
  const st = document.getElementById('statusText');
  if (d.connected) {
    dot.className = 'dot on';
    st.textContent = (d.name || 'Bagli') + (d.phone ? ' · +'+d.phone : '');
  } else if (d.phase === 'qr') {
    dot.className = 'dot wait';
    st.textContent = 'QR bekleniyor...';
  } else if (d.phase === 'loading') {
    dot.className = 'dot wait';
    st.textContent = 'Yukleniyor ' + (d.percent || '') + '%';
  } else if (d.phase === 'auth') {
    dot.className = 'dot wait';
    st.textContent = 'Dogrulaniyor...';
  } else {
    dot.className = 'dot';
    st.textContent = 'Baglaniyor...';
  }
});
socket.on('chats', (list) => {
  chats = list || [];
  renderChats();
  document.getElementById('chatCount').textContent = chats.length + ' sohbet';
});
socket.on('log', (e) => addLog(e));
socket.on('history', (h) => prependHist(h));
socket.on('loop', (d) => { document.getElementById('btnStart').disabled = !!d.running; });

async function api(url, method, body) {
  try {
    const o = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (body) o.body = JSON.stringify(body);
    const r = await fetch(url, o);
    const t = await r.text();
    try { return JSON.parse(t); } catch (_) { return { ok: false, error: t.slice(0, 120) }; }
  } catch (e) { return { ok: false, error: e.message }; }
}
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function updateCount(){
  const n = document.getElementById('msgs').value.split('\\n').filter(l => l.trim()).length;
  document.getElementById('msgCount').textContent = n + ' mesaj';
}
document.getElementById('msgs').addEventListener('input', updateCount);
document.getElementById('txtFile').addEventListener('change', function() {
  const f = this.files && this.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = async function() {
    const lines = String(reader.result || '').split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
    document.getElementById('msgs').value = lines.join('\\n');
    updateCount();
    const res = await api('/api/messages', 'POST', { messages: lines });
    alert((res.count || lines.length) + ' mesaj yuklendi');
  };
  reader.readAsText(f, 'UTF-8');
  this.value = '';
});
function renderChats() {
  const el = document.getElementById('chatList');
  if (!chats.length) {
    el.innerHTML = '<div class="ph" style="padding:16px;text-align:center">Sohbet yok — Yukle butonuna bas</div>';
    return;
  }
  const cur = document.getElementById('target').value;
  el.innerHTML = chats.map(c =>
    '<div class="chat-item'+(c.id===cur?' on':'')+'" onclick="pickChat(\\''+String(c.id).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'")+'\\')">'+
    '<span>'+esc(c.name)+'</span>'+(c.isGroup?'<span class="tag">GRUP</span>':'')+'</div>'
  ).join('');
}
function pickChat(id) {
  document.getElementById('target').value = id;
  renderChats();
}
function prependHist(h) {
  const tb = document.getElementById('histBody');
  const tr = document.createElement('tr');
  tr.innerHTML = '<td>'+esc(h.time)+'</td><td>'+esc(h.body)+'</td>';
  tb.insertBefore(tr, tb.firstChild);
}
function addLog(e) {
  const el = document.getElementById('logs');
  const div = document.createElement('div');
  div.className = 'log ' + (e.type || '');
  div.textContent = '[' + (e.time || '') + '] ' + (e.msg || '');
  el.insertBefore(div, el.firstChild);
}
async function saveAll() {
  const messages = document.getElementById('msgs').value.split('\\n').filter(l => l.trim());
  await api('/api/messages', 'POST', { messages });
  await api('/api/settings', 'POST', {
    delay: parseInt(document.getElementById('delay').value) || 2200,
    typingDelay: parseInt(document.getElementById('typing').value) || 0,
    prefix: document.getElementById('prefix').value.trim(),
    usePrefix: document.getElementById('usePrefix').checked,
    targetId: document.getElementById('target').value.trim()
  });
  updateCount();
  alert('Kaydedildi');
}
async function startLoop() {
  await saveAll();
  const targetId = document.getElementById('target').value.trim();
  if (!targetId) return alert('Hedef secin veya yazin (905...@c.us)');
  const res = await api('/api/loop/start', 'POST', {
    targetId,
    delay: parseInt(document.getElementById('delay').value) || 2200
  });
  if (!res.ok) alert(res.error || 'Baslatilamadi');
}
async function stopLoop() { await api('/api/loop/stop', 'POST', {}); }
async function refreshChats() {
  const res = await api('/api/chats/refresh', 'POST', {});
  if (res.error) alert('Sohbet: ' + res.error);
  if (res.chats) {
    chats = res.chats;
    renderChats();
    document.getElementById('chatCount').textContent = chats.length + ' sohbet';
  }
}
async function load() {
  const s = await api('/api/status');
  if (!s || s.error) return;
  if (s.settings) {
    document.getElementById('delay').value = s.settings.delay || 2200;
    document.getElementById('typing').value = s.settings.typingDelay || 800;
    document.getElementById('prefix').value = s.settings.prefix || '';
    document.getElementById('usePrefix').checked = !!s.settings.usePrefix;
    document.getElementById('target').value = s.settings.targetId || '';
  }
  if (Array.isArray(s.messages)) document.getElementById('msgs').value = s.messages.join('\\n');
  updateCount();
  if (s.chats) {
    chats = s.chats;
    renderChats();
    document.getElementById('chatCount').textContent = chats.length + ' sohbet';
  }
  if (s.history) {
    document.getElementById('histBody').innerHTML = s.history.map(h =>
      '<tr><td>'+esc(h.time)+'</td><td>'+esc(h.body)+'</td></tr>'
    ).join('');
  }
  if (s.logs) s.logs.slice().reverse().forEach(addLog);
  const dot = document.getElementById('dot');
  const st = document.getElementById('statusText');
  if (s.connected) {
    dot.className = 'dot on';
    st.textContent = (s.name || 'Bagli') + (s.phone ? ' · +'+s.phone : '');
    document.getElementById('qrBox').innerHTML = '<div class="ph" style="color:#25d366;font-size:22px">Baglandi</div>';
  } else if (s.phase === 'qr') {
    dot.className = 'dot wait';
    st.textContent = 'QR bekleniyor...';
  }
  document.getElementById('btnStart').disabled = !!s.loopRunning;
}
load();
setInterval(async () => {
  const s = await api('/api/status');
  if (s && s.connected) {
    document.getElementById('dot').className = 'dot on';
    if (s.name) document.getElementById('statusText').textContent = s.name + (s.phone ? ' · +'+s.phone : '');
  }
}, 10000);
</script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

io.on('connection', async (socket) => {
  try {
    if (currentQR) {
      const url = await qrcode.toDataURL(currentQR);
      socket.emit('qr', { qr: url });
    }
    if (clientReady) {
      socket.emit('status', {
        connected: true,
        phase: 'ready',
        name: client?.info?.pushname,
        phone: client?.info?.wid?.user
      });
      socket.emit('chats', chatCache);
    }
  } catch (_) {}
});

(async () => {
  initLock = true;
  try {
    await createClient();
    await client.initialize();
  } catch (e) {
    log('Init: ' + errText(e), 'error');
  } finally {
    initLock = false;
  }
})();

server.listen(PORT, () => {
  console.log('WP Panel -> http://localhost:' + PORT);
  log('Sunucu ayakta :' + PORT, 'success');
});
