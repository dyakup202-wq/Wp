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
        logs: d.logs || [],
        history: d.history || []
      };
    }
  } catch (e) { console.error('load:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT));
}

function saveData() {
  try {
    store.logs = store.logs.slice(0, 300);
    store.history = store.history.slice(0, 200);
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) { console.error('save:', e.message); }
}

let store = loadData();

function log(msg, type = 'info') {
  const entry = { msg: String(msg), type, time: new Date().toLocaleTimeString('tr-TR') };
  store.logs.unshift(entry);
  if (store.logs.length > 300) store.logs.length = 300;
  saveData();
  io.emit('log', entry);
  console.log(`[${type}] ${msg}`);
}

async function getPuppeteerOpts() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--single-process',
    '--no-zygote'
  ];
  const opts = { headless: true, args };

  // 1) Sistem / env Chromium (Docker)
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '';
  if (envPath && fs.existsSync(envPath)) {
    opts.executablePath = envPath;
    return opts;
  }

  // 2) Railway / serverless: @sparticuz/chromium
  try {
    const chromium = require('@sparticuz/chromium');
    opts.args = [...chromium.args, ...args];
    opts.headless = chromium.headless;
    opts.executablePath = await chromium.executablePath();
    return opts;
  } catch (_) {}

  // 3) Varsayilan (yerel puppeteer chrome)
  return opts;
}

let client = null;
let clientReady = false;
let currentQR = null;
let loopTimer = null;
let loopRunning = false;
let loopIndex = 0;
let chatCache = [];

async function createClient() {
  const puppeteer = await getPuppeteerOpts();
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_PATH, clientId: 'main' }),
    puppeteer,
    webVersionCache: { type: 'local' }
  });

  client.on('qr', async (qr) => {
    currentQR = qr;
    clientReady = false;
    log('QR kod hazir — WhatsApp ile okut', 'qr');
    try {
      const url = await qrcode.toDataURL(qr);
      io.emit('qr', { qr: url });
      io.emit('status', { connected: false, phase: 'qr' });
    } catch (e) {
      log('QR hata: ' + e.message, 'error');
    }
  });

  client.on('authenticated', () => {
    log('Oturum dogrulandi (kalici kayit)', 'auth');
    io.emit('status', { connected: false, phase: 'auth' });
  });

  client.on('ready', async () => {
    clientReady = true;
    currentQR = null;
    const name = client.info?.pushname || 'WhatsApp';
    const phone = client.info?.wid?.user || '';
    log(`Baglandi: ${name} (${phone})`, 'success');
    io.emit('qr', { qr: null, connected: true });
    io.emit('status', { connected: true, phase: 'ready', name, phone });
    await refreshChats();
    if (store.settings.loopEnabled && store.messages.length && store.settings.targetId) {
      startLoop();
    }
  });

  client.on('auth_failure', (m) => {
    clientReady = false;
    log('Auth hatasi: ' + m, 'error');
    io.emit('status', { connected: false, phase: 'auth_fail', error: String(m) });
  });

  client.on('disconnected', (reason) => {
    clientReady = false;
    stopLoop(false);
    log('Baglanti kesildi: ' + reason, 'warn');
    io.emit('status', { connected: false, phase: 'disconnected', reason: String(reason) });
    setTimeout(() => {
      log('Yeniden baglaniyor...', 'info');
      try { client.initialize(); } catch (e) { log(e.message, 'error'); }
    }, 5000);
  });
}

async function refreshChats() {
  if (!clientReady) return [];
  try {
    const chats = await client.getChats();
    chatCache = chats.slice(0, 150).map((c) => ({
      id: c.id._serialized,
      name: c.name || c.id.user || c.id._serialized,
      isGroup: !!c.isGroup,
      unread: c.unreadCount || 0
    }));
    chatCache.sort((a, b) => {
      if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
      return a.name.localeCompare(b.name, 'tr');
    });
    io.emit('chats', chatCache);
    log(`${chatCache.length} sohbet yuklendi`, 'info');
    return chatCache;
  } catch (e) {
    log('Sohbet yukleme: ' + e.message, 'error');
    return [];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildBody(text) {
  let msg = String(text || '');
  if (store.settings.usePrefix && store.settings.prefix) {
    const parts = String(store.settings.prefix).trim().split(/[\s,;]+/).filter(Boolean);
    const tags = parts.map((p) => {
      const digits = p.replace(/\D/g, '');
      if (digits.length >= 10) return '@' + digits;
      return p;
    });
    if (tags.length) msg = tags.join(' ') + ' ' + msg;
  }
  return msg.slice(0, 65000);
}

async function sendOne(targetId, text) {
  if (!clientReady) throw new Error('WhatsApp bagli degil');
  if (!targetId) throw new Error('Hedef yok');
  const chat = await client.getChatById(targetId);
  const body = buildBody(text);
  const typingMs = Math.max(0, Number(store.settings.typingDelay) || 0);
  if (typingMs > 0) {
    try {
      await chat.sendStateTyping();
      await sleep(typingMs);
    } catch (_) {}
  }
  await client.sendMessage(targetId, body);
  try { await chat.clearState(); } catch (_) {}
  const hist = {
    time: new Date().toLocaleTimeString('tr-TR'),
    target: targetId,
    body: body.slice(0, 120)
  };
  store.history.unshift(hist);
  if (store.history.length > 200) store.history.length = 200;
  saveData();
  io.emit('history', hist);
  log('Gonderildi → ' + (chat.name || targetId).slice(0, 30) + ': ' + body.slice(0, 40), 'send');
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
  if (loopRunning) return;
  if (!clientReady) return log('Dongu icin once baglan', 'error');
  if (!store.settings.targetId) return log('Hedef secilmedi', 'error');
  if (!store.messages.length) return log('Mesaj listesi bos', 'error');

  loopRunning = true;
  store.settings.loopEnabled = true;
  saveData();
  io.emit('loop', { running: true });
  log('Dongu basladi', 'success');

  const tick = async () => {
    if (!loopRunning) return;
    try {
      const msgs = store.messages;
      if (!msgs.length) return stopLoop();
      const text = msgs[loopIndex % msgs.length];
      loopIndex++;
      await sendOne(store.settings.targetId, text);
      const delay = Math.max(500, Number(store.settings.delay) || 2200);
      if (loopRunning) loopTimer = setTimeout(tick, delay);
    } catch (e) {
      log('Gonderme hatasi: ' + e.message, 'error');
      const delay = Math.max(2000, Number(store.settings.delay) || 2200);
      if (loopRunning) loopTimer = setTimeout(tick, delay);
    }
  };
  tick();
}

app.use(express.json({ limit: '2mb' }));
app.get('/api/ping', (_req, res) => res.json({ ok: true }));

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
  const b = req.body || {};
  if (b.delay !== undefined) store.settings.delay = Math.max(500, Number(b.delay) || 2200);
  if (b.typingDelay !== undefined) store.settings.typingDelay = Math.max(0, Number(b.typingDelay) || 0);
  if (b.prefix !== undefined) store.settings.prefix = String(b.prefix || '');
  if (typeof b.usePrefix === 'boolean') store.settings.usePrefix = b.usePrefix;
  if (b.targetId !== undefined) store.settings.targetId = String(b.targetId || '');
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
  log(`${store.messages.length} mesaj kaydedildi`, 'success');
  res.json({ ok: true, count: store.messages.length, messages: store.messages });
});

app.post('/api/loop/start', (req, res) => {
  if (req.body?.targetId) store.settings.targetId = String(req.body.targetId);
  if (req.body?.delay) store.settings.delay = Math.max(500, Number(req.body.delay) || 2200);
  saveData();
  startLoop();
  res.json({ ok: true, running: loopRunning });
});

app.post('/api/loop/stop', (_req, res) => {
  stopLoop(true);
  res.json({ ok: true, running: false });
});

app.post('/api/chats/refresh', async (_req, res) => {
  const chats = await refreshChats();
  res.json({ ok: true, chats });
});

app.post('/api/send', async (req, res) => {
  try {
    const { targetId, text } = req.body || {};
    const hist = await sendOne(targetId || store.settings.targetId, text);
    res.json({ ok: true, hist });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
input,textarea,select{width:100%;background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:11px 12px;color:#eee;font-size:14px;outline:none}
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
.chat-list{max-height:160px;overflow-y:auto;background:#0d0d0d;border:1px solid #2a2a2a;border-radius:10px}
.chat-item{padding:10px 12px;border-bottom:1px solid #1f1f1f;cursor:pointer;font-size:13px;display:flex;justify-content:space-between}
.chat-item:hover,.chat-item.on{background:#1a2a1a}
.chat-item .tag{font-size:10px;color:#25d366}
.hist{width:100%;border-collapse:collapse;font-size:12px}
.hist th{text-align:left;color:#666;padding:6px 8px;border-bottom:1px solid #2a2a2a}
.hist td{padding:6px 8px;border-bottom:1px solid #1a1a1a;color:#ccc;vertical-align:top}
.logs{max-height:140px;overflow-y:auto;font-family:ui-monospace,monospace;font-size:11px;background:#0d0d0d;border-radius:8px;padding:8px;margin-top:8px}
.log{color:#888;padding:2px 0}.log.success{color:#25d366}.log.error{color:#e74c3c}.log.warn{color:#e3b341}.log.send{color:#53bdeb}.log.qr{color:#e3b341}
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
  <input id="delay" type="number" min="500" step="100" value="2200">
  <label>Typing (ms)</label>
  <input id="typing" type="number" min="0" step="100" value="800">
  <label>Prefix / etiket (numara — boslukla coklu)</label>
  <input id="prefix" placeholder="905551112233 905559998877">
  <label class="toggle"><input type="checkbox" id="usePrefix"> Prefix aktif</label>
  <label>Mesajlar (her satir = 1 mesaj — sonsuz dongu)</label>
  <textarea id="msgs" placeholder="Merhaba&#10;Nasilsin?"></textarea>
  <div class="file-row">
    <label class="file-btn">📄 TXT Yukle<input type="file" id="txtFile" accept=".txt,text/plain" hidden></label>
    <span class="count" id="msgCount">0 mesaj</span>
  </div>
  <p class="hint">TXT: her satir 1 mesaj. Sayac guncellenir ve kaydedilir.</p>
  <div class="row">
    <button class="btn btn-g" id="btnStart" onclick="startLoop()">▶ Baslat</button>
    <button class="btn btn-r" id="btnStop" onclick="stopLoop()">■ Durdur</button>
  </div>
  <button class="btn btn-s" onclick="refreshChats()">↻ Sohbetleri Yukle</button>
  <button class="btn btn-s" onclick="saveAll()">💾 Ayar & Mesajlari Kaydet</button>
  <div class="section">
    <h3>Sohbet Listesi</h3>
    <div class="chat-list" id="chatList"><div class="ph" style="padding:16px;text-align:center">Yukle veya baglan</div></div>
  </div>
  <div class="section">
    <h3>Mesaj Gecmisi</h3>
    <table class="hist"><thead><tr><th>Saat</th><th>Mesaj</th></tr></thead><tbody id="histBody"></tbody></table>
  </div>
  <div class="section"><h3>Log</h3><div class="logs" id="logs"></div></div>
</div>
<script>
const socket=io();
let chats=[],connected=false;
socket.on('qr',d=>{const box=document.getElementById('qrBox');if(d.connected||!d.qr)box.innerHTML='<div class="ph" style="color:#25d366;font-size:22px">Baglandi</div>';else box.innerHTML='<img src="'+d.qr+'" alt="QR">';});
socket.on('status',d=>{connected=!!d.connected;const dot=document.getElementById('dot'),st=document.getElementById('statusText');if(d.connected){dot.className='dot on';st.textContent=(d.name||'Bagli')+(d.phone?' · +'+d.phone:'');}else if(d.phase==='qr'){dot.className='dot wait';st.textContent='QR bekleniyor...';}else{dot.className='dot';st.textContent=d.phase==='auth'?'Dogrulaniyor...':'Baglaniyor...';}});
socket.on('chats',list=>{chats=list||[];renderChats();document.getElementById('chatCount').textContent=chats.length+' sohbet';});
socket.on('log',e=>addLog(e));
socket.on('history',h=>prependHist(h));
socket.on('loop',d=>{document.getElementById('btnStart').disabled=!!d.running;});
async function api(url,method,body){try{const o={method:method||'GET',headers:{'Content-Type':'application/json'}};if(body)o.body=JSON.stringify(body);const r=await fetch(url,o);const t=await r.text();try{return JSON.parse(t);}catch(_){return{ok:false,error:t.slice(0,80)};}}catch(e){return{ok:false,error:e.message};}}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function updateCount(){const n=document.getElementById('msgs').value.split('\\n').filter(l=>l.trim()).length;document.getElementById('msgCount').textContent=n+' mesaj';}
document.getElementById('msgs').addEventListener('input',updateCount);
document.getElementById('txtFile').addEventListener('change',function(){const f=this.files&&this.files[0];if(!f)return;const reader=new FileReader();reader.onload=async function(){const lines=String(reader.result||'').split(/\\r?\\n/).map(l=>l.trim()).filter(Boolean);document.getElementById('msgs').value=lines.join('\\n');updateCount();const res=await api('/api/messages','POST',{messages:lines});alert((res.count||lines.length)+' mesaj TXT\\'den yuklendi');};reader.readAsText(f,'UTF-8');this.value='';});
function renderChats(){const el=document.getElementById('chatList');if(!chats.length){el.innerHTML='<div class="ph" style="padding:16px;text-align:center">Sohbet yok</div>';return;}const cur=document.getElementById('target').value;el.innerHTML=chats.map(c=>'<div class="chat-item'+(c.id===cur?' on':'')+'" onclick="pickChat(\\''+c.id.replace(/'/g,"\\\\'")+'\\')"><span>'+esc(c.name)+'</span>'+(c.isGroup?'<span class="tag">GRUP</span>':'')+'</div>').join('');}
function pickChat(id){document.getElementById('target').value=id;renderChats();}
function prependHist(h){const tb=document.getElementById('histBody');const tr=document.createElement('tr');tr.innerHTML='<td>'+esc(h.time)+'</td><td>'+esc(h.body)+'</td>';tb.insertBefore(tr,tb.firstChild);}
function addLog(e){const el=document.getElementById('logs');const div=document.createElement('div');div.className='log '+(e.type||'');div.textContent='['+(e.time||'')+'] '+(e.msg||'');el.insertBefore(div,el.firstChild);}
async function saveAll(){const messages=document.getElementById('msgs').value.split('\\n').filter(l=>l.trim());await api('/api/messages','POST',{messages});await api('/api/settings','POST',{delay:parseInt(document.getElementById('delay').value)||2200,typingDelay:parseInt(document.getElementById('typing').value)||0,prefix:document.getElementById('prefix').value.trim(),usePrefix:document.getElementById('usePrefix').checked,targetId:document.getElementById('target').value.trim()});updateCount();alert('Kaydedildi');}
async function startLoop(){await saveAll();const targetId=document.getElementById('target').value.trim();if(!targetId)return alert('Hedef secin');const res=await api('/api/loop/start','POST',{targetId,delay:parseInt(document.getElementById('delay').value)||2200});if(!res.ok)alert(res.error||'Baslatilamadi');}
async function stopLoop(){await api('/api/loop/stop','POST',{});}
async function refreshChats(){const res=await api('/api/chats/refresh','POST',{});if(res.chats){chats=res.chats;renderChats();document.getElementById('chatCount').textContent=chats.length+' sohbet';}}
async function load(){const s=await api('/api/status');if(!s||s.error)return;if(s.settings){document.getElementById('delay').value=s.settings.delay||2200;document.getElementById('typing').value=s.settings.typingDelay||800;document.getElementById('prefix').value=s.settings.prefix||'';document.getElementById('usePrefix').checked=!!s.settings.usePrefix;document.getElementById('target').value=s.settings.targetId||'';}if(Array.isArray(s.messages))document.getElementById('msgs').value=s.messages.join('\\n');updateCount();if(s.chats){chats=s.chats;renderChats();document.getElementById('chatCount').textContent=chats.length+' sohbet';}if(s.history)document.getElementById('histBody').innerHTML=s.history.map(h=>'<tr><td>'+esc(h.time)+'</td><td>'+esc(h.body)+'</td></tr>').join('');if(s.logs)s.logs.slice().reverse().forEach(addLog);const dot=document.getElementById('dot'),st=document.getElementById('statusText');if(s.connected){dot.className='dot on';st.textContent=(s.name||'Bagli')+(s.phone?' · +'+s.phone:'');document.getElementById('qrBox').innerHTML='<div class="ph" style="color:#25d366;font-size:22px">Baglandi</div>';}else if(s.phase==='qr'){dot.className='dot wait';st.textContent='QR bekleniyor...';}document.getElementById('btnStart').disabled=!!s.loopRunning;}
load();
</script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

io.on('connection', async (socket) => {
  if (currentQR) {
    try {
      const url = await qrcode.toDataURL(currentQR);
      socket.emit('qr', { qr: url });
    } catch (_) {}
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
});

(async () => {
  try {
    await createClient();
    await client.initialize();
  } catch (e) {
    log('Init: ' + e.message, 'error');
  }
})();

server.listen(PORT, () => {
  console.log('WP Panel -> http://localhost:' + PORT);
  log('Sunucu ayakta', 'success');
});
