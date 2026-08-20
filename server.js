/**
 * Field Inspector Report App v3
 * JBA Property Solutions — Express + OCR.space + Bland.ai
 */

require('dotenv').config();

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// Chaves de OCR: SEM fallback hardcoded. As antigas ('P8983...'/'K85989...')
// VAZARAM (o server.js estava público) — precisam ser rotacionadas no ocr.space
// e definidas no Railway (OCR_API_KEY / OCR_API_KEY_BACKUP).
const OCR_API_KEY        = process.env.OCR_API_KEY        || '';
const OCR_API_KEY_BACKUP = process.env.OCR_API_KEY_BACKUP || '';
const BLAND_API_KEY = process.env.BLAND_API_KEY  || '';
const APP_BASE_URL  = process.env.APP_BASE_URL   || `http://localhost:${process.env.PORT || 3000}`;
const JBA_PHONE     = process.env.JBA_PHONE || '(614) 304-3490';
const BOT_SUBMIT_KEY = process.env.BOT_SUBMIT_KEY || ''; // chave p/ o WhatsApp da Anna criar reports

// ── Senha do escritório (Basic Auth do dashboard + APIs de dados) ──
// FAIL-CLOSED: sem DASHBOARD_PASSWORD setada no Railway, as rotas protegidas
// respondem 503 (melhor trancado que vazando). O bot da Anna (x-bot-key) e o
// webhook do Bland NÃO passam por aqui.
const DASHBOARD_USER     = process.env.DASHBOARD_USER || 'jba';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

// ── CALLS DISABLED — CALL CENTER MODE ──────────────────────────────────────
// Safeguard has prohibited automated outbound calls via Bland.ai.
// The system now operates as a call-queue controller: reports are logged and
// marked as "pending_call_center" so the human call center can follow up.
// All routes, evidence generation, and call_status logic remain intact.
const CALLS_ENABLED = false;
// ────────────────────────────────────────────────────────────────────────────

['data/uploads/orders', 'data/uploads/justifications', 'data'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const DB_FILE = './data/reports.json';
function readDB()    { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { nextId: 1, reports: [] }; } }
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function nowISO()    { return new Date().toISOString(); }
function nowLocal()  {
  return new Date().toLocaleString('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
}
function addHours(isoDate, hours) {
  return new Date(new Date(isoDate).getTime() + hours * 60 * 60 * 1000).toISOString();
}
function getOfficeAlertText(report) {
  return `Office action required: remove this job from inspector ${report.inspector_name || 'Unassigned'}, attach the evidence screenshots, and close the work order within 48 hours in Safeguard.`;
}
function getFortyEightHourState(report) {
  const startAt = report.office_timer_started_at || report.created_at || nowISO();
  const dueAt = report.office_due_at || addHours(startAt, 48);
  const now = Date.now();
  const remainingMs = new Date(dueAt).getTime() - now;
  const done = !!report.office_closed_at;
  const expired = !done && remainingMs <= 0;
  return {
    start_at: startAt,
    due_at: dueAt,
    done,
    expired,
    remaining_ms: done ? 0 : Math.max(0, remainingMs),
    status: done ? 'closed' : (expired ? 'overdue' : 'active')
  };
}

function esc(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
app.use(cors());
app.use(express.json({ limit: '25mb' })); // 25mb p/ aceitar imagens base64 do bot da Anna
app.use(express.urlencoded({ extended: true }));

// ── SEGURANÇA ───────────────────────────────────────────────────────────────
// 1) NUNCA servir código-fonte, o banco cru ou config como arquivo estático.
//    (o express.static(__dirname) abaixo servia /server.js, /package.json e o
//    banco inteiro em /data/reports.json — vazamento total de PII e chaves.)
function blockSensitive(req, res, next) {
  const p = (req.path || '').toLowerCase();
  if (
    p === '/server.js' || p === '/package.json' || p === '/package-lock.json' ||
    p === '/gitignore' || p.startsWith('/.git') || p.startsWith('/data') ||
    p.startsWith('/node_modules') || p.endsWith('.env') ||
    p.endsWith('.json')
  ) {
    return res.status(404).send('Not found');
  }
  next();
}

// 2) Login por SENHA (sem usuário) para o dashboard, as fotos e as APIs de dados.
//    Página /login + cookie de sessão. Aberto de propósito: /login, bot da Anna
//    (x-bot-key), webhook do Bland, health e o site público (/, css, imagens).
function needsAuth(p) {
  // Express roteia SEM diferenciar maiúscula/minúscula, então /API/reports cai
  // no mesmo handler de /api/reports. Normaliza pra minúsculo ANTES de decidir,
  // senão dá bypass do login por caixa alta (achado no pentest 2026-08-20).
  p = (p || '').toLowerCase();
  if (p === '/login' || p === '/api/login' || p === '/logout') return false;
  if (p === '/api/health') return false;
  if (p.startsWith('/api/bot/')) return false;       // Anna (x-bot-key)
  if (p === '/api/bland/webhook') return false;       // Bland posta aqui
  if (p === '/dashboard' || p === '/dashboard.html') return true;
  if (p.startsWith('/uploads')) return true;          // fotos = PII
  if (p.startsWith('/api/')) return true;             // todo o resto da API
  return false;                                       // site público
}
function safeEqual(a, b) {
  const crypto = require('crypto');
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
// Token de sessão derivado da senha: quem sabe a senha recebe este token no
// cookie. Trocar DASHBOARD_PASSWORD invalida todos os logins automaticamente.
function sessionToken() {
  return require('crypto').createHmac('sha256', DASHBOARD_PASSWORD || 'x').update('jba-office-v1').digest('hex');
}
function isAuthed(req) {
  if (!DASHBOARD_PASSWORD) return false;
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)jba_auth=([^;]+)/);
  return !!(m && safeEqual(m[1], sessionToken()));
}
function requireAuth(req, res, next) {
  const p = req.path || '';
  if (!needsAuth(p)) return next();
  if (!DASHBOARD_PASSWORD) return res.status(503).send('Dashboard bloqueado: defina DASHBOARD_PASSWORD no Railway.');
  if (isAuthed(req)) return next();
  if (p.toLowerCase().startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');            // página → manda pro login
}
app.use(blockSensitive);
app.use(requireAuth);

// ── Página de login (só senha) + set/clear do cookie ─────────────────────────
const LOGIN_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>JBA — Acesso</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#f4f5f2;color:#1c2620;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
  .box{background:#fff;border:1px solid rgba(20,32,26,.1);border-radius:16px;padding:32px 28px;width:320px;max-width:100%;text-align:center;box-shadow:0 10px 30px rgba(20,32,26,.08)}
  h1{font-size:17px;margin:0 0 4px} p{color:#68746b;font-size:13px;margin:0 0 20px}
  input{width:100%;padding:11px 12px;border:1px solid rgba(20,32,26,.15);border-radius:9px;font-size:15px;margin-bottom:10px;box-sizing:border-box}
  input:focus{outline:0;border-color:#e8932e}
  button{width:100%;padding:11px;border:0;border-radius:9px;background:#e8932e;color:#fff;font-weight:600;font-size:15px;cursor:pointer}
  .err{color:#a8362f;font-size:13px;height:18px;margin-top:8px}
</style></head><body>
<form class="box" onsubmit="return go(event)">
  <h1>JBA Property Solutions</h1><p>Escritório — acesso restrito</p>
  <input id="pw" type="password" placeholder="Senha" autocomplete="current-password" autofocus>
  <button type="submit">Entrar</button><div class="err" id="err"></div>
</form>
<script>
async function go(e){e.preventDefault();
  const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
  if(r.ok){location.href='/dashboard'} else {document.getElementById('err').textContent='Senha incorreta'} return false;}
</script></body></html>`;

app.get('/login', (_req, res) => res.type('html').send(LOGIN_HTML));
app.post('/api/login', (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.status(503).json({ error: 'not configured' });
  const pass = (req.body && req.body.password) || '';
  if (safeEqual(pass, DASHBOARD_PASSWORD)) {
    res.set('Set-Cookie', `jba_auth=${sessionToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false });
});
app.get('/logout', (_req, res) => {
  res.set('Set-Cookie', 'jba_auth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  res.redirect('/login');
});
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.static(__dirname));
app.use(express.static('public'));
app.use('/uploads', express.static('data/uploads')); // fotos no volume persistente
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));


const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dirs = {
      order_screenshot:    'data/uploads/orders/',
      justification_photo: 'data/uploads/justifications/',
    };
    cb(null, dirs[file.fieldname] || 'data/uploads/justifications/');
  },
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});
const upload = multer({
  storage: diskStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_, f, cb) => /\.(jpe?g|png|gif|webp|heic|svg)$/i.test(f.originalname) ? cb(null, true) : cb(new Error('Images only'))
});

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function callOcrSpace(base64DataUrl, apiKey, hostname, engine = '2') {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      apikey: apiKey, base64Image: base64DataUrl,
      language: 'eng', OCREngine: engine,
      scale: 'true', detectOrientation: 'true', isTable: 'false'
    }).toString();

    const options = {
      hostname, port: 443, path: '/parse/image', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid OCR response')); } });
    });
    req.setTimeout(40_000, () => { req.destroy(); reject(new Error('OCR timed out')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// PRO key uses apipro1/apipro2 endpoints; backup (free) key uses api.ocr.space
// Attempt order: PRO dc1 eng2 → PRO dc2 eng2 → PRO dc1 eng5 → backup free eng2
async function ocrImage(buffer, mimetype) {
  const b64 = `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  const attempts = [
    { key: OCR_API_KEY,        host: 'apipro1.ocr.space', engine: '2' },
    { key: OCR_API_KEY,        host: 'apipro2.ocr.space', engine: '2' },
    { key: OCR_API_KEY,        host: 'apipro1.ocr.space', engine: '5' },
    { key: OCR_API_KEY_BACKUP, host: 'api.ocr.space',     engine: '2' },
    { key: OCR_API_KEY_BACKUP, host: 'api.ocr.space',     engine: '5' },
  ];
  let lastError = null;
  for (const { key, host, engine } of attempts) {
    try {
      const result = await callOcrSpace(b64, key, host, engine);
      if (result.IsErroredOnProcessing) {
        lastError = Array.isArray(result.ErrorMessage) ? result.ErrorMessage.join(' ') : result.ErrorMessage || 'OCR failed';
        console.warn(`OCR attempt host=${host} engine=${engine} failed: ${lastError}`);
        continue;
      }
      const text = (result.ParsedResults || []).map(r => r.ParsedText || '').join('\n');
      if (text.trim().length > 20) {
        console.log(`OCR success host=${host} engine=${engine} chars=${text.length}`);
        return text;
      }
      lastError = 'Empty OCR result';
      console.warn(`OCR attempt host=${host} engine=${engine}: empty result`);
    } catch(e) {
      lastError = e.message;
      console.warn(`OCR attempt host=${host} engine=${engine} error: ${e.message}`);
    }
  }
  throw new Error(lastError || 'All OCR attempts failed');
}

function parseOrderDetails(rawText) {
  const f = {};
  const lines = rawText.replace(/\r\n/g,'\n').replace(/\r/g,'\n')
    .split('\n').map(l=>l.trim()).filter(Boolean);
  const text = lines.join('\n');

  // Lines to skip when collecting values (UI chrome + non-data labels)
  const SKIP = new Set(['order details','queue','details','instructions','instructions !',
    'scheduling','notes','order date','last occupancy status','appointment set',
    'camera','gallery','label','badge','start','check in to property']);
  const FIELD_LBLS = ['address','work code','client','due date','lockbox code','name','order number'];

  function isFieldLbl(l) { return FIELD_LBLS.includes(l.toLowerCase().trim()); }
  function isSkip(l)     { return SKIP.has(l.toLowerCase().trim()) || /^safeguard properties/i.test(l); }
  function toField(lbl) {
    return lbl==='address'?'address':lbl==='work code'?'work_code':lbl==='lockbox code'?'lockbox_code'
          :lbl==='order number'?'order_number':lbl==='due date'?'due_date':lbl;
  }
  const cityRe = /[A-Z]{2}\s+\d{5}|,\s*[A-Z]{2}/;

  // ── Strategy 1: interleaved — label on line N, value on N+1 (value is NOT another label) ──
  for (let i = 0; i < lines.length; i++) {
    const lo = lines[i].toLowerCase();
    if (!isFieldLbl(lo)) continue;
    const val1 = lines[i+1]||'', val2 = lines[i+2]||'';
    if (!val1 || isFieldLbl(val1) || isSkip(val1)) continue; // next line is another label → Scenario A
    const field = toField(lo);
    if (f[field]) continue;
    if (field==='address') {
      f.address = cityRe.test(val2) ? `${val1}, ${val2}`.trim() : val1.trim();
    } else {
      f[field] = val1.trim();
    }
  }

  // ── Strategy 2: all labels together, then all values (OCR reads columns separately) ──
  if (Object.keys(f).length < 3) {
    const labelIdxs = lines.reduce((a,l,i)=>{ if(isFieldLbl(l)) a.push(i); return a; }, []);
    if (labelIdxs.length >= 3) {
      const orderedLabels = labelIdxs.map(i => lines[i].toLowerCase());
      const lastIdx = labelIdxs[labelIdxs.length-1];
      const values = [];
      for (let i = lastIdx+1; i < lines.length; i++) {
        if (isSkip(lines[i]) || isFieldLbl(lines[i])) continue;
        values.push(lines[i]);
      }
      let vi = 0;
      for (const lbl of orderedLabels) {
        if (vi >= values.length) break;
        const field = toField(lbl);
        if (f[field]) continue;
        if (field==='address') {
          const next = values[vi+1]||'';
          if (cityRe.test(next)) { f.address=`${values[vi]}, ${next}`.trim(); vi+=2; }
          else { f.address=values[vi]; vi++; }
        } else {
          f[field]=values[vi]; vi++;
        }
      }
    }
  }

  // ── Fallback regex ──
  if (!f.order_number) { const m=text.match(/\b(3\d{8})\b/); if(m) f.order_number=m[1]; }
  if (!f.due_date)     { const m=text.match(/\b(\d{2}\/\d{2}\/20\d{2})\b/); if(m) f.due_date=m[1]; }
  if (!f.lockbox_code) { const m=text.match(/Lockbox\s*(?:Code)?[\s\t:]*(\d{3,6})/i); if(m) f.lockbox_code=m[1]; }
  if (!f.work_code)    { const m=text.match(/Work\s*Code[\s\t:]*([A-Z][A-Z0-9]{1,9})/i); if(m) f.work_code=m[1]; }
  if (!f.client)       { const m=text.match(/Client[\s\t:]*([A-Z][A-Z0-9]{1,12})/i); if(m) f.client=m[1]; }

  return f;
}

function parseContacts(rawText) {
  const c = { policy_holder_name: '', policy_holder_phone: '', agent_name: '', agent_phone: '', insurance_carrier: '' };
  const phN = rawText.match(/(?<!2\s)Contact\s*Name\s*[:\-]\s*([A-Z][A-Z ]{2,})/i);
  if (phN) c.policy_holder_name = phN[1].trim();
  const phP = rawText.match(/Contact\s*(?:Number|Phone)\s*[:\-]\s*([\d()\-.\s]{7,16})/i);
  if (phP) c.policy_holder_phone = formatPhone(phP[1]);
  const agN = rawText.match(/Contact\s*2\s*Name\s*[:\-]\s*(?:Agent\s*[-–]?\s*)?([A-Z][A-Za-z ]{3,})/i);
  if (agN) c.agent_name = agN[1].trim();
  const agP = rawText.match(/Contact\s*2\s*(?:Phone|Number)\s*[:\-]\s*([\d()\-.\s]{7,16})/i);
  if (agP) c.agent_phone = formatPhone(agP[1]);
  const ins = rawText.match(/Insurance\s*Carrier\s*[:\-]\s*([A-Za-z ]{3,30})/i);
  if (ins) c.insurance_carrier = ins[1].trim();
  const allPhones = [...rawText.matchAll(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g)].map(m => formatPhone(m[0]));
  const uniquePhones = [...new Set(allPhones)];
  if (!c.policy_holder_phone && uniquePhones[0]) c.policy_holder_phone = uniquePhones[0];
  if (!c.agent_phone && uniquePhones[1] && uniquePhones[1] !== c.policy_holder_phone)
    c.agent_phone = uniquePhones[1];
  return c;
}

function formatPhone(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  return raw.trim();
}

function blandCall({ phone, contactType, contactName, report }) {
  return new Promise((resolve, reject) => {
    const address   = report.address       || 'the property';
    const orderNum  = report.order_number  || 'N/A';
    const carrier   = report.insurance_carrier || 'the insurance company';
    const reasonMap = {
      bad_address:    'the address could not be located',
      asked_to_leave: 'the occupant asked the inspector to leave',
      gated:          'the property is behind a locked gate with no access code',
    };
    const reasonText = reasonMap[report.reason] || 'access was not possible during the visit';
    const roleLabel  = contactType === 'policy_holder' ? 'property owner / policyholder' : 'listing agent';
    const name       = contactName || `the ${roleLabel}`;

    const isAgent = contactType === 'agent';
    const reason  = report.reason || '';

    const situationMap = {
      asked_to_leave: {
        agentScript: 'Our inspector arrived on site but was asked to leave and could not complete the visit. Could you please assist by contacting the client and advising that we need permission to return and complete the survey?',
        phScript:    'Our inspector was on site today but was unable to complete the visit because access permission was not granted. We would like to request permission to return and complete the survey. The visit is exterior only and usually takes just a few minutes.',
      },
      gated: {
        agentScript: 'Our inspector arrived on site but could not access the property because it is gated. Could you please assist by contacting the client to provide the gate code or arrange access so the survey can be completed?',
        phScript:    'Our inspector was on site today but could not access the property because the entrance is gated. Could you please provide the gate code or let us know a good date and time when access can be arranged? The survey is exterior only and takes just a few minutes.',
      },
      dog: {
        agentScript: 'Our inspector arrived on site but could not safely complete the survey because there was a dog loose in the yard. Could you please assist by contacting the client so the dog can be secured and the survey can be completed?',
        phScript:    'Our inspector was on site today but could not safely complete the survey because there was a dog in the yard. Could you please secure the dog and let us know a good time for us to return? The survey is exterior only and takes only a few minutes.',
      },
      bad_address: {
        agentScript: 'Our inspector attempted to locate the property today, but the address provided appears to be incorrect or could not be confirmed on site. Could you please help verify the correct address so we can complete the survey?',
        phScript:    'Our inspector attempted to visit today, but we were unable to confirm the correct address. Could you please verify the full property address or provide any helpful location details so we can complete the survey?',
      },
      child: {
        agentScript: 'Our inspector arrived on site, but only a child was present at the property. For safety and compliance reasons, we were unable to proceed. Could you please assist in coordinating a better time when an adult will be present?',
        phScript:    'Our inspector visited today, but only a child was present at the property. For safety reasons, we need to return when an adult is available. Please let us know a convenient date and time. The survey is exterior only and takes just a few minutes.',
      },
      no_trespassing: {
        agentScript: 'Our inspector arrived on site but could not enter because there is a "No Trespassing" sign posted on the property. Could you please confirm whether access is permitted and help coordinate with the client so the survey can be completed?',
        phScript:    'Our inspector was on site today but could not enter because a "No Trespassing" sign is posted at the property. Could you please confirm whether we have permission to access the property for a brief exterior survey? It only takes a few minutes.',
      },
    };

    const defaultScripts = {
      agentScript: 'Our inspector was unable to complete the survey today. Could you please assist by contacting the client so we can arrange to complete the survey?',
      phScript:    'Our inspector was unable to complete the survey today. We would like to schedule a time to return. The survey is exterior only and takes just a few minutes.',
    };

    const s = situationMap[reason] || defaultScripts;

    // Build full context block Anna can reference when answering questions
    const propertyHolder = report.policy_holder_name || 'the policyholder';
    const agentFullName  = report.agent_name          || 'the insurance agent';
    const clientCode     = report.client              || carrier;
    const workCode       = report.work_code           || 'N/A';
    const dueDate        = report.due_date            || 'N/A';
    const lockbox        = report.lockbox_code        || 'N/A';

    const contextBlock = `
CONTEXT — use this to answer any questions asked during the call:
- Company calling: JBA Property Solutions
- Calling on behalf of: ${carrier}
- Property address: ${address}
- Order number: ${orderNum}
- Work code: ${workCode}
- Client code: ${clientCode}
- Due date: ${dueDate}
- Lockbox code: ${lockbox}
- Policy holder name: ${propertyHolder}
- Insurance agent: ${agentFullName}
- JBA office phone: ${JBA_PHONE}
- Available schedule: Monday through Saturday, 8 AM to 5 PM
- Always say "survey" — never say "inspection"
- You do NOT know internal insurance policy details, claim numbers, or coverage amounts — redirect those questions to ${carrier} directly`.trim();

    const agentTask = `You are Anna, a professional call agent for JBA Property Solutions.

${contextBlock}

GOAL OF THIS CALL: You are calling ${name}, an insurance agent at ${carrier}, to report that our inspector could not complete a property survey and to request their assistance.

OPENING — introduce yourself immediately and state the reason for the call:
"Hi, may I speak with ${name}? ... Hi ${name}, this is Anna calling from JBA Property Solutions. We're a field inspection company working on behalf of ${carrier}. I'm calling about a property survey at ${address}, order number ${orderNum}. ${s.agentScript} Our office number is ${JBA_PHONE} if you need to reach us."

IF THEY ASK QUESTIONS: Answer using the context above. If asked something you don't know (like claim details or policy numbers), say: "I don't have that information on my end — you would need to check directly with ${carrier} for those details."

VOICEMAIL SCRIPT: "Hi ${name}, this is Anna from JBA Property Solutions calling on behalf of ${carrier}. I'm reaching out about a property survey at ${address}, order number ${orderNum}. ${s.agentScript} Please call us back at ${JBA_PHONE}. Thank you."

At the end, provide a brief summary of the call outcome.`.trim();

    const phTask = `You are Anna, a professional call agent for JBA Property Solutions.

${contextBlock}

GOAL OF THIS CALL: You are calling ${name}, the property owner or policyholder, to let them know about a survey issue and to request access or cooperation.

OPENING — introduce yourself immediately and state the reason for the call:
"Hi, may I speak with ${name}? ... Hi ${name}, this is Anna calling from JBA Property Solutions. We are a field survey company working on behalf of your insurance carrier, ${carrier}. I'm calling about a property survey scheduled at ${address}, order number ${orderNum}. ${s.phScript} If you have any questions, please call our office at ${JBA_PHONE}."

IF THEY ASK QUESTIONS: Answer using the context above. If asked about insurance coverage, claims, or policy details, say: "Those questions would be best directed to ${carrier} — I only handle the field survey scheduling on our end."

GOAL OUTCOMES (try to get one of these):
1. Permission to access the property
2. Gate code or access instructions
3. Confirmed address (if bad address)
4. A scheduled date/time (Monday–Saturday, 8 AM–5 PM)

VOICEMAIL SCRIPT: "Hi ${name}, this is Anna from JBA Property Solutions calling on behalf of ${carrier}. I'm reaching out about a property survey at ${address}, order number ${orderNum}. ${s.phScript} Please call us back at ${JBA_PHONE}. Thank you."

At the end, provide a brief summary of the call outcome including what was resolved.`.trim();

    const task = isAgent ? agentTask : phTask;

    const body = JSON.stringify({
      phone_number:        phone,
      task,
      model:               'enhanced',
      language:            'en-US',
      voice:               'nat',
      max_duration:        5,
      wait_for_greeting:   true,
      record:              true,
      answered_by_enabled: true,
      voicemail_action:    'leave_message',
      metadata: { report_id: String(report.id), contact_type: contactType, order_number: orderNum },
      webhook: `${APP_BASE_URL}/api/bland/webhook`,
    });
    const options = {
      hostname: 'api.bland.ai', port: 443, path: '/v1/calls', method: 'POST',
      headers: { 'authorization': BLAND_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const p  = JSON.parse(raw);
          const id = p.call_id || p.id;
          if (res.statusCode >= 200 && res.statusCode < 300 && id) resolve(id);
          else { console.error(`Bland reject status=${res.statusCode}:`, raw); reject(new Error(`Bland: ${raw}`)); }
        } catch {
          reject(new Error(`Bland: ${raw}`));
        }
      });
    });
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Bland timeout')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

app.get('/api/health', (_, res) => {
  res.json({ ready: true, engine: 'ocr.space', bland: !!BLAND_API_KEY, calls_enabled: CALLS_ENABLED, mode: CALLS_ENABLED ? 'automated' : 'call_center' });
});

app.post('/api/ocr', memUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });
    const rawText = await ocrImage(req.file.buffer, req.file.mimetype);

    // Detect if inspector sent a screenshot of the JBA app itself instead of Safeguard
    const isJbaAppScreenshot =
      /ORDER SCREENSHOT.*DETAILS TAB/i.test(rawText) ||
      /OCR Auto.Fill/i.test(rawText) ||
      /Non.Completion Report/i.test(rawText) ||
      (/jba\.solutions/i.test(rawText) && /IMG_\d+/i.test(rawText));

    if (isJbaAppScreenshot) {
      return res.json({
        success: false,
        raw_text: rawText,
        fields: {},
        jba_app_screenshot: true,
        error: 'Screenshot is of the JBA app. Open Safeguard > Order Details > Details tab and screenshot that screen directly.'
      });
    }

    const fields = parseOrderDetails(rawText);
    res.json({ success: true, raw_text: rawText, fields });
  } catch (err) {
    console.error('OCR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ocr/contacts', memUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });
    const rawText = await ocrImage(req.file.buffer, req.file.mimetype);
    const contacts = parseContacts(rawText);
    res.json({ success: true, raw_text: rawText, contacts });
  } catch (err) {
    console.error('Contacts OCR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bland/dispatch', async (req, res) => {
  try {
    const db  = readDB();
    const rep = db.reports.find(r => r.id === Number(req.body.report_id));
    if (!rep) return res.status(404).json({ error: 'Report not found' });

    rep.call_status = 'calling';
    rep.calls_dispatched_at = nowISO();
    if (!rep.calls) rep.calls = [];

    const targets = [
      rep.policy_holder_phone ? { type: 'policy_holder', phone: rep.policy_holder_phone, name: rep.policy_holder_name } : null,
      rep.agent_phone && rep.agent_phone !== rep.policy_holder_phone
        ? { type: 'agent', phone: rep.agent_phone, name: rep.agent_name } : null,
    ].filter(Boolean);

    // ── CALL CENTER MODE ────────────────────────────────────────────────────
    // Automated calls are disabled per Safeguard policy.
    // This endpoint now registers the contacts as a call-center queue entry.
    // The report status is set to 'pending_call_center' so the dashboard
    // shows it as awaiting human follow-up.
    if (!CALLS_ENABLED) {
      console.log(`📋  CALL CENTER MODE — queuing contacts for report #${rep.id}`);
      const queued = targets.map(t => ({
        call_id:       `cc-${Date.now()}-${t.type}`,
        type:          t.type,
        phone:         t.phone,
        status:        'pending_call_center',
        dispatched_at: nowISO(),
        ended_at:      null,
        answered_by:   null,
        recording_url: null,
        summary:       '[Awaiting call center — no automated call placed]',
        call_center:   true,
      }));

      rep.calls.push(...queued);
      rep.call_status          = 'pending_call_center';
      rep.office_alert_text    = getOfficeAlertText(rep);
      rep.office_alert_sent_at = nowISO();
      if (!rep.office_timer_started_at) rep.office_timer_started_at = rep.created_at || nowISO();
      if (!rep.office_due_at) rep.office_due_at = addHours(rep.office_timer_started_at, 48);
      writeDB(db);
      return res.json({
        success:       true,
        dispatched:    queued.length,
        calls:         queued,
        errors:        [],
        calls_enabled: false,
        call_center:   true,
        message:       'Report queued for call center follow-up. No automated call placed.',
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    if (!BLAND_API_KEY)
      return res.status(400).json({ error: 'BLAND_API_KEY not configured on server. Set the env variable and restart.' });

    const dispatched = [];
    const errors = [];
    await Promise.all(targets.map(t =>
      blandCall({ phone: t.phone, contactType: t.type, contactName: t.name, report: rep })
        .then(id => dispatched.push({ call_id: id, type: t.type, phone: t.phone, status: 'calling', dispatched_at: nowISO() }))
        .catch(err => errors.push(`${t.type}: ${err.message}`))
    ));

    rep.calls.push(...dispatched);
    if (!dispatched.length) rep.call_status = 'error';
    writeDB(db);
    res.json({ success: !!dispatched.length, dispatched: dispatched.length, calls: dispatched, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CALL CENTER: resolve a queued call ───────────────────────────────────
// Called by dashboard when call center agent logs the outcome of their call.
// Body: { call_index, status, answered_by, summary, notes }
// status values: 'answered' | 'voicemail' | 'no_answer'
app.post('/api/reports/:id/call-center/resolve', (req, res) => {
  try {
    const db  = readDB();
    const rep = db.reports.find(r => r.id === Number(req.params.id));
    if (!rep) return res.status(404).json({ error: 'Not found' });

    const { call_index, status, answered_by, summary, notes } = req.body;
    const validStatuses = ['answered', 'voicemail', 'no_answer'];
    const mapped = validStatuses.includes(status) ? status : 'no_answer';

    if (!rep.calls) rep.calls = [];

    // Update specific call entry if index provided, otherwise update all pending
    const idx = Number(call_index);
    const toUpdate = (!isNaN(idx) && rep.calls[idx])
      ? [rep.calls[idx]]
      : rep.calls.filter(c => c.status === 'pending_call_center');

    toUpdate.forEach(c => {
      c.status       = mapped;
      c.answered_by  = answered_by || 'call_center_agent';
      c.summary      = summary || '';
      c.ended_at     = nowISO();
      c.call_center  = true;
    });

    if (notes !== undefined) rep.call_notes = notes;

    // Derive top-level call_status from all calls
    const ss = rep.calls.map(c => c.status);
    if      (ss.some(s => s === 'answered'))             rep.call_status = 'answered';
    else if (ss.some(s => s === 'voicemail'))            rep.call_status = 'voicemail';
    else if (ss.every(s => s === 'no_answer'))           rep.call_status = 'no_answer';
    else if (ss.some(s => s === 'pending_call_center'))  rep.call_status = 'pending_call_center';
    else                                                  rep.call_status = 'no_answer';

    rep.office_alert_text    = getOfficeAlertText(rep);
    rep.office_alert_sent_at = nowISO();
    if (!rep.office_timer_started_at) rep.office_timer_started_at = rep.created_at || nowISO();
    if (!rep.office_due_at) rep.office_due_at = addHours(rep.office_timer_started_at, 48);

    writeDB(db);
    res.json({ success: true, call_status: rep.call_status, calls: rep.calls });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bland/webhook', (req, res) => {
  try {
    const { call_id, status, answered_by, recording_url, summary, metadata } = req.body;
    const report_id = Number(metadata?.report_id);
    if (!report_id || !call_id) return res.sendStatus(200);

    const db  = readDB();
    const rep = db.reports.find(r => r.id === report_id);
    if (!rep) return res.sendStatus(200);

    if (!rep.calls) rep.calls = [];
    const entry = rep.calls.find(c => c.call_id === call_id);
    const mapped = { completed: 'answered', 'no-answer': 'no_answer', busy: 'no_answer', failed: 'error', voicemail: 'voicemail' }[status] || status;

    if (entry) {
      Object.assign(entry, { status: mapped, answered_by, recording_url, summary: summary || '', ended_at: nowISO() });
      rep.office_alert_text = getOfficeAlertText(rep);
      rep.office_alert_sent_at = nowISO();
      if (!rep.office_timer_started_at) rep.office_timer_started_at = rep.created_at || nowISO();
      if (!rep.office_due_at) rep.office_due_at = addHours(rep.office_timer_started_at, 48);
    }

    const ss = rep.calls.map(c => c.status);
    if      (ss.some(s => s === 'answered'))   rep.call_status = 'answered';
    else if (ss.some(s => s === 'voicemail'))  rep.call_status = 'voicemail';
    else if (ss.every(s => s === 'no_answer')) rep.call_status = 'no_answer';
    else if (ss.every(s => s === 'error'))     rep.call_status = 'error';
    else rep.call_status = 'calling';

    writeDB(db);
    console.log(`Webhook: report ${report_id} call ${call_id} → ${mapped}`);
  } catch (e) { console.error('Webhook:', e.message); }
  res.sendStatus(200);
});

app.patch('/api/reports/:id/callstatus', (req, res) => {
  try {
    const db  = readDB();
    const rep = db.reports.find(r => r.id === Number(req.params.id));
    if (!rep) return res.status(404).json({ error: 'Not found' });
    if (req.body.status) rep.call_status = req.body.status;
    if (req.body.notes)  rep.call_notes  = req.body.notes;
    writeDB(db);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/reports/:id/ph-outcome', (req, res) => {
  try {
    const db  = readDB();
    const rep = db.reports.find(r => r.id === Number(req.params.id));
    if (!rep) return res.status(404).json({ error: 'Not found' });
    if (!rep.ph_outcome) rep.ph_outcome = {};
    const { field, toggle, outcome_notes } = req.body;
    if (toggle && field) {
      rep.ph_outcome[field] = !rep.ph_outcome[field];
      rep.ph_outcome[field + '_at'] = rep.ph_outcome[field] ? nowISO() : null;
    }
    if (outcome_notes !== undefined) rep.ph_outcome.outcome_notes = outcome_notes;
    writeDB(db);
    res.json({ success: true, ph_outcome: rep.ph_outcome });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/submit',
  upload.fields([
    { name: 'order_screenshot',    maxCount: 1 },
    { name: 'justification_photo', maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const db     = readDB();
      const createdAt = nowISO();
      const report = {
        id:                  db.nextId++,
        inspector_name:      req.body.inspector_name      || '',
        address:             req.body.address             || '',
        work_code:           req.body.work_code           || '',
        client:              req.body.client              || '',
        due_date:            req.body.due_date            || '',
        lockbox_code:        req.body.lockbox_code        || '',
        property_name:       req.body.property_name       || '',
        order_number:        req.body.order_number        || '',
        reason:              req.body.reason              || '',
        notes:               req.body.notes               || '',
        policy_holder_name:  req.body.policy_holder_name  || '',
        policy_holder_phone: req.body.policy_holder_phone || '',
        agent_name:          req.body.agent_name          || '',
        agent_phone:         req.body.agent_phone         || '',
        insurance_carrier:   req.body.insurance_carrier   || '',
        call_status:         'pending',
        calls:               [],
        call_notes:          '',
        order_screenshot:    req.files?.order_screenshot?.[0]?.filename    || null,
        justification_photo: req.files?.justification_photo?.[0]?.filename || null,

        office_alert_text:   '',
        office_alert_sent_at: null,
        office_timer_started_at: createdAt,
        office_due_at:       addHours(createdAt, 48),
        office_closed_at:    null,
        created_at:          createdAt,
        created_at_local:    nowLocal(),
      };
      db.reports.push(report);
      writeDB(db);
      res.json({ success: true, id: report.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);


// ── POST /api/bot/submit — cria report a partir do WhatsApp da Anna (chave) ──
// JSON: campos da ordem + reason + notes + imagens em base64 (data URL).
// NÃO dispara ligação — só cria o report (escritório/call center segue pelo dashboard).
app.post('/api/bot/submit', express.json({ limit: '25mb' }), (req, res) => {
  try {
    const key = req.get('x-bot-key') || (req.body && req.body.key) || '';
    if (!BOT_SUBMIT_KEY || key !== BOT_SUBMIT_KEY) return res.status(401).json({ error: 'unauthorized' });
    const b = req.body || {};
    const saveB64 = (dataUrl, dir) => {
      if (!dataUrl) return null;
      const m = String(dataUrl).match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);
      const mime = m ? m[1] : 'image/jpeg';
      const ext = '.' + (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^\w]/g, '');
      const data = m ? m[2] : dataUrl;
      const fname = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fname), Buffer.from(data, 'base64'));
      return fname;
    };
    const db = readDB();
    const createdAt = nowISO();
    const report = {
      id:                  db.nextId++,
      inspector_name:      b.inspector_name || '',
      address:             b.address || '',
      work_code:           b.work_code || '',
      client:              b.client || '',
      due_date:            b.due_date || '',
      lockbox_code:        b.lockbox_code || '',
      property_name:       b.property_name || '',
      order_number:        b.order_number || '',
      reason:              b.reason || '',
      notes:               b.notes || '',
      policy_holder_name:  '', policy_holder_phone: '',
      agent_name:          '', agent_phone: '', insurance_carrier: '',
      call_status:         'pending', calls: [], call_notes: '',
      order_screenshot:    saveB64(b.order_image_b64, 'data/uploads/orders/'),
      justification_photo: saveB64(b.justification_image_b64, 'data/uploads/justifications/'),
      source:              'whatsapp_anna',
      office_alert_text:   '', office_alert_sent_at: null,
      office_timer_started_at: createdAt,
      office_due_at:       addHours(createdAt, 48),
      office_closed_at:    null,
      created_at:          createdAt,
      created_at_local:    nowLocal(),
    };
    db.reports.push(report);
    writeDB(db);
    res.json({ success: true, id: report.id, url: `${APP_BASE_URL}/dashboard` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/bot/import — restaura reports em lote a partir do backup CSV ──
// Preserva id + created_at + contatos + call_status. Fotos não vêm (perdidas).
// Idempotente: pula ids que já existem.
app.post('/api/bot/import', express.json({ limit: '50mb' }), (req, res) => {
  try {
    const key = req.get('x-bot-key') || (req.body && req.body.key) || '';
    if (!BOT_SUBMIT_KEY || key !== BOT_SUBMIT_KEY) return res.status(401).json({ error: 'unauthorized' });
    const items = Array.isArray(req.body && req.body.reports) ? req.body.reports : [];
    const db = readDB();
    const existing = new Set(db.reports.map(r => Number(r.id)));
    let added = 0;
    for (const b of items) {
      const id = Number(b.id);
      if (!id || existing.has(id)) continue;
      const createdAt = b.created_at || nowISO();
      db.reports.push({
        id,
        inspector_name:      b.inspector_name || '',
        address:             b.address || '',
        work_code:           b.work_code || '',
        client:              b.client || '',
        due_date:            b.due_date || '',
        lockbox_code:        b.lockbox_code || '',
        property_name:       b.property_name || '',
        order_number:        b.order_number || '',
        reason:              b.reason || '',
        notes:               b.notes || '',
        policy_holder_name:  b.policy_holder_name || '',
        policy_holder_phone: b.policy_holder_phone || '',
        agent_name:          b.agent_name || '',
        agent_phone:         b.agent_phone || '',
        insurance_carrier:   b.insurance_carrier || '',
        call_status:         b.call_status || 'pending',
        calls: [], call_notes: '',
        order_screenshot: null, justification_photo: null, call_screenshot: null,
        source: 'csv_restore',
        office_alert_text: '', office_alert_sent_at: null,
        office_timer_started_at: createdAt,
        office_due_at:       addHours(createdAt, 48),
        office_closed_at:    null,
        created_at:          createdAt,
        created_at_local:    b.created_at_local || nowLocal(),
      });
      existing.add(id);
      added++;
    }
    db.nextId = Math.max(db.nextId || 1, ...db.reports.map(r => Number(r.id) + 1));
    writeDB(db);
    res.json({ success: true, added, total: db.reports.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reports/:id/office-timer/start', (req, res) => {
  try {
    const db  = readDB();
    const rep = db.reports.find(r => r.id === Number(req.params.id));
    if (!rep) return res.status(404).json({ error: 'Not found' });
    const startAt = nowISO();
    rep.office_timer_started_at = startAt;
    rep.office_due_at = addHours(startAt, 48);
    if (!rep.office_alert_text) rep.office_alert_text = getOfficeAlertText(rep);
    rep.office_alert_sent_at = nowISO();
    writeDB(db);
    res.json({ success: true, office_timer: getFortyEightHourState(rep), office_alert_text: rep.office_alert_text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reports/:id/office-close', (req, res) => {
  try {
    const db  = readDB();
    const rep = db.reports.find(r => r.id === Number(req.params.id));
    if (!rep) return res.status(404).json({ error: 'Not found' });
    rep.office_closed_at = nowISO();
    if (!rep.office_alert_text) rep.office_alert_text = getOfficeAlertText(rep);
    writeDB(db);
    res.json({ success: true, office_timer: getFortyEightHourState(rep) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/inspectors', (_req, res) => {
  try {
    const names = [...new Set(readDB().reports.map(r => (r.inspector_name || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    res.json(names);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports', (req, res) => {
  try {
    let rows = [...readDB().reports].sort((a,b) => b.id - a.id).map(r => ({
      ...r,
      office_timer: getFortyEightHourState(r),
      office_alert_text: r.office_alert_text || ''
    }));
    const { search, start_date, end_date, reason, inspector, call_status } = req.query;
    if (search) {
      const s = String(search).toLowerCase();
      rows = rows.filter(r => [r.id, r.address, r.order_number, r.inspector_name, r.policy_holder_name, r.agent_name].join(' ').toLowerCase().includes(s));
    }
    if (start_date) rows = rows.filter(r => String(r.created_at || '').slice(0,10) >= start_date);
    if (end_date) rows = rows.filter(r => String(r.created_at || '').slice(0,10) <= end_date);
    if (reason) rows = rows.filter(r => r.reason === reason);
    if (inspector) rows = rows.filter(r => r.inspector_name === inspector);
    if (call_status) rows = rows.filter(r => r.call_status === call_status);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/:id', (req, res) => {
  try {
    const rep = readDB().reports.find(r => r.id === Number(req.params.id));
    if (!rep) return res.status(404).json({ error: 'Not found' });
    res.json({ ...rep, office_timer: getFortyEightHourState(rep), office_alert_text: rep.office_alert_text || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/reports/:id', (req, res) => {
  try {
    const db = readDB();
    const idx = db.reports.findIndex(r => r.id === Number(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const r = db.reports[idx];
    const fileDirs = { order_screenshot: 'data/uploads/orders/', justification_photo: 'data/uploads/justifications/' };
    Object.entries(fileDirs).forEach(([field, dir]) => {
      if (r[field]) {
        const p = path.join(dir, r[field]);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    });
    db.reports.splice(idx, 1);
    writeDB(db);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', (_req, res) => {
  try {
    const reports = readDB().reports;
    res.json({
      totalReports: reports.length,
      badAddress:    reports.filter(r => r.reason === 'bad_address').length,
      askedLeave:    reports.filter(r => r.reason === 'asked_to_leave').length,
      gated:         reports.filter(r => r.reason === 'gated').length,
      dog:           reports.filter(r => r.reason === 'dog').length,
      child:         reports.filter(r => r.reason === 'child').length,
      noTrespassing: reports.filter(r => r.reason === 'no_trespassing').length,
      callPending: reports.filter(r => !r.call_status || r.call_status === 'pending').length,
      callCenterQueue: reports.filter(r => r.call_status === 'pending_call_center').length,
      callActive:  reports.filter(r => r.call_status === 'calling').length,
      callDone:    reports.filter(r => ['answered','voicemail','no_answer'].includes(r.call_status)).length,
      officeDueSoon: reports.filter(r => {
        const t = getFortyEightHourState(r);
        return !t.done && !t.expired && t.remaining_ms <= 12 * 60 * 60 * 1000;
      }).length,
      officeOverdue: reports.filter(r => {
        const t = getFortyEightHourState(r);
        return !t.done && t.expired;
      }).length,
      officeClosed: reports.filter(r => !!r.office_closed_at).length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/export.csv', (_req, res) => {
  try {
    const reports = readDB().reports;
    const cols = ['id','created_at','created_at_local','inspector_name','address','order_number','client','due_date','lockbox_code','policy_holder_name','policy_holder_phone','agent_name','agent_phone','insurance_carrier','call_status'];
    const csv = [cols.join(',')].concat(
      reports.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g,'""')}"`).join(','))
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="reports.csv"');
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log('✅  JBA Field Inspector App v3');
  console.log(`   Inspector  →  http://localhost:${PORT}/`);
  console.log(`   Dashboard  →  http://localhost:${PORT}/dashboard.html`);
  console.log(`   OCR        →  OCR.space ✅ configured (${OCR_API_KEY.slice(0,6)}...)`);
  console.log(`   Bland.ai   →  ${BLAND_API_KEY ? '✅ configured' : '⚠️  BLAND_API_KEY not set — add to env'}`);
  console.log(`   Mode       →  📋  CALL CENTER QUEUE (automated calls disabled per Safeguard policy)`);
  console.log(`   Webhook    →  POST ${APP_BASE_URL}/api/bland/webhook\n`);
});
