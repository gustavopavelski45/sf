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

const OCR_API_KEY   = process.env.OCR_API_KEY   || 'K85989969588957';
const BLAND_API_KEY = process.env.BLAND_API_KEY  || '';
const APP_BASE_URL  = process.env.APP_BASE_URL   || `http://localhost:${process.env.PORT || 3000}`;

['uploads/orders', 'uploads/justifications', 'uploads/calls', 'data'].forEach(dir => {
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

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapPlainText(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (test.length <= maxChars) line = test;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function renderTextBlock(lines, x, y, lineHeight, fill = '#111827', size = 20, weight = '400') {
  return lines.map((line, i) => `<text x="${x}" y="${y + i * lineHeight}" font-size="${size}" font-weight="${weight}" fill="${fill}" font-family="Arial, Helvetica, sans-serif">${escapeXml(line)}</text>`).join('');
}

function generateCallEvidenceImage(report, call) {
  const filename = `call-evidence-report-${report.id}-${Date.now()}.svg`;
  const outPath = path.join('uploads', 'calls', filename);

  const leftItems = [
    ['Report ID', String(report.id || '—')],
    ['Order Number', report.order_number || '—'],
    ['Property Address', report.address || '—'],
    ['Call Type', call.type || '—'],
    ['Call Status', call.status || '—'],
  ];
  const rightItems = [
    ['Call ID', call.call_id || '—'],
    ['Answered By', call.answered_by || '—'],
    ['Ended At', call.ended_at || nowISO()],
    ['Recording URL', call.recording_url || 'Not available'],
  ];

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1000" viewBox="0 0 1400 1000">
  <rect width="1400" height="1000" fill="#f3f4f6"/>
  <rect x="0" y="0" width="1400" height="120" fill="#111827"/>
  <text x="60" y="72" font-size="42" font-weight="700" fill="#ffffff" font-family="Arial, Helvetica, sans-serif">Call Evidence</text>
  <text x="60" y="103" font-size="22" fill="#ffffff" font-family="Arial, Helvetica, sans-serif">Automatically generated from Bland webhook data</text>
  <rect x="50" y="150" width="1300" height="780" rx="10" fill="#ffffff" stroke="#d1d5db" stroke-width="2"/>
`;

  const addColumn = (items, x, startY) => {
    let y = startY;
    for (const [label, value] of items) {
      svg += `<text x="${x}" y="${y}" font-size="18" font-weight="700" fill="#6b7280" font-family="Arial, Helvetica, sans-serif">${escapeXml(label)}</text>`;
      const lines = wrapPlainText(value, 42).slice(0, 4);
      svg += renderTextBlock(lines, x, y + 28, 26, '#111827', 20, '400');
      y += 28 + (Math.max(1, lines.length) * 26) + 18;
    }
  };

  addColumn(leftItems, 90, 210);
  addColumn(rightItems, 760, 210);

  svg += `<text x="90" y="700" font-size="18" font-weight="700" fill="#6b7280" font-family="Arial, Helvetica, sans-serif">Summary</text>`;
  svg += renderTextBlock(wrapPlainText(call.summary || 'No summary returned by Bland.', 105).slice(0, 10), 90, 735, 28, '#111827', 20, '400');
  svg += `<text x="90" y="955" font-size="18" fill="#9ca3af" font-family="Arial, Helvetica, sans-serif">Generated: ${escapeXml(nowISO())}</text>`;
  svg += `</svg>`;

  fs.writeFileSync(outPath, svg, 'utf8');
  return filename;
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));


const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dirs = {
      order_screenshot:    'uploads/orders/',
      justification_photo: 'uploads/justifications/',
      call_screenshot:     'uploads/calls/',
    };
    cb(null, dirs[file.fieldname] || 'uploads/justifications/');
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

function callOcrSpace(base64DataUrl, apiKey) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      apikey: apiKey, base64Image: base64DataUrl,
      language: 'eng', OCREngine: '2',
      scale: 'true', detectOrientation: 'true', isTable: 'false'
    }).toString();

    const options = {
      hostname: 'api.ocr.space', port: 443, path: '/parse/image', method: 'POST',
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

async function ocrImage(buffer, mimetype) {
  const b64    = `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  const result = await callOcrSpace(b64, OCR_API_KEY);
  if (result.IsErroredOnProcessing)
    throw new Error(Array.isArray(result.ErrorMessage) ? result.ErrorMessage.join(' ') : result.ErrorMessage || 'OCR failed');
  return (result.ParsedResults || []).map(r => r.ParsedText || '').join('\n');
}

const ROAD_KW = 'RD|AVE|ST|HWY|BLVD|DR|LN|CT|WAY|PL|TER|PKWY|CIR|LOOP|TRAIL|SWAIM';

function parseOrderDetails(rawText) {
  const f = {};
  const om = rawText.match(/\b(3\d{8})\b/);
  if (om) f.order_number = om[1];
  const dates = [...rawText.matchAll(/\b(\d{2}\/\d{2}\/20\d{2})\b/g)].map(m => m[1]);
  if (dates[0]) f.due_date = dates[0];
  const lbs = [...rawText.matchAll(/(?<!\d)(\d{4,5})(?!\d)/g)]
    .map(m => m[1])
    .filter(n => !dates.some(d => d.replace(/\//g, '').includes(n)))
    .filter(n => !f.order_number || !f.order_number.includes(n));
  if (lbs[0]) f.lockbox_code = lbs[0];
  const addrRe = new RegExp(`(\\d+\\s+[A-Z0-9 ]+(${ROAD_KW})[,\\s\\n]+[A-Z ]+,?\\s+[A-Z]{2}\\s+\\d{5})`, 'im');
  const am = rawText.match(addrRe);
  if (am) f.address = am[1].replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();
  const pairs = [
    [/Work\s*Code[\s\t:]+([A-Z][A-Z0-9]{1,7})/i,       'work_code'   ],
    [/Client[\s\t:]+([A-Z0-9]{2,12})/i,                 'client'      ],
    [/Lockbox\s*Code[\s\t:]+(\d{4,6})/i,               'lockbox_code'],
    [/\bName[\s\t:]+([A-Z][A-Z ]{3,})/i,               'name'        ],
    [/Order\s*Number[\s\t:]+(\d{8,10})/i,             'order_number'],
    [/Due\s*Date[\s\t:]+(\d{2}\/\d{2}\/\d{4})/i,   'due_date'    ],
  ];
  for (const [rx, key] of pairs) {
    const m = rawText.match(rx);
    if (m && !f[key]) f[key] = m[1].trim();
  }
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
  if (!c.policy_holder_phone && allPhones[0]) c.policy_holder_phone = allPhones[0];
  if (!c.agent_phone          && allPhones[1]) c.agent_phone          = allPhones[1];
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
    };

    const defaultScripts = {
      agentScript: 'Our inspector was unable to complete the survey today. Could you please assist by contacting the client so we can arrange to complete the survey?',
      phScript:    'Our inspector was unable to complete the survey today. We would like to schedule a time to return. The survey is exterior only and takes just a few minutes.',
    };

    const s = situationMap[reason] || defaultScripts;

    const task = isAgent ? `
You are Anna, calling on behalf of JBA Property Solutions.

Your opening line when someone answers: "Hello, this is an inspection update regarding the survey requested for the property at ${address}."

Then deliver this message:
"${s.agentScript}"

If they have questions, answer professionally and briefly.
If they confirm they will help, thank them and end the call politely.

If voicemail, leave this message:
"Hello, this is an inspection update regarding the survey requested for the property at ${address}, order number ${orderNum}. ${s.agentScript} Please call us back at your earliest convenience. Thank you and have a great day."

STRICT RULES:
- Always say SURVEY, never say inspection
- Never mention Safeguard Properties
- Be professional, warm and concise

After the call, summarize the outcome clearly.
    `.trim() : `
You are Anna, calling on behalf of JBA Property Solutions.

Your opening line when someone answers: "Hello, this is regarding the survey requested for your property at ${address}."

Then deliver this message:
"${s.phScript}"

YOUR GOALS:
1. Confirm you reached the right person.
2. Resolve the issue — get permission, gate code, confirmed address, or schedule a specific date and time (Mon–Sat, 8 AM–5 PM).
3. Be helpful and answer any questions they have.

If voicemail, leave this message:
"Hello, this is regarding the survey requested for the property at ${address}, order number ${orderNum}. ${s.phScript} Please call us back at your earliest convenience. Thank you."

STRICT RULES:
- Always say SURVEY, never say inspection
- Never mention Safeguard Properties
- Be professional, warm and concise

After the call, summarize the outcome: access granted / appointment scheduled (date+time) / voicemail left / no answer.
    `.trim();

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
          else reject(new Error(`Bland: ${raw}`));
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
  res.json({ ready: true, engine: 'ocr.space', bland: !!BLAND_API_KEY });
});

app.post('/api/ocr', memUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });
    const rawText = await ocrImage(req.file.buffer, req.file.mimetype);
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
    if (!BLAND_API_KEY)
      return res.status(400).json({ error: 'BLAND_API_KEY not configured on server. Set the env variable and restart.' });

    const db  = readDB();
    const rep = db.reports.find(r => r.id === Number(req.body.report_id));
    if (!rep) return res.status(404).json({ error: 'Report not found' });

    rep.call_status = 'calling';
    rep.calls_dispatched_at = nowISO();
    if (!rep.calls) rep.calls = [];

    const targets = [
      rep.policy_holder_phone ? { type: 'policy_holder', phone: rep.policy_holder_phone, name: rep.policy_holder_name } : null,
      rep.agent_phone         ? { type: 'agent',         phone: rep.agent_phone,         name: rep.agent_name } : null,
    ].filter(Boolean);

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
      rep.call_screenshot = generateCallEvidenceImage(rep, entry);
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

app.post('/api/submit',
  upload.fields([
    { name: 'order_screenshot',    maxCount: 1 },
    { name: 'justification_photo', maxCount: 1 },
    { name: 'call_screenshot',     maxCount: 1 },
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
        call_screenshot:     req.files?.call_screenshot?.[0]?.filename     || null,
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

app.post('/api/reports/:id/call-screenshot', upload.single('call_screenshot'), (req, res) => {
  try {
    const db  = readDB();
    const rep = db.reports.find(r => r.id === Number(req.params.id));
    if (!rep) return res.status(404).json({ error: 'Not found' });
    if (req.file) rep.call_screenshot = req.file.filename;
    writeDB(db);
    res.json({ success: true, filename: req.file?.filename });
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
    const fileDirs = { order_screenshot: 'uploads/orders/', justification_photo: 'uploads/justifications/', call_screenshot: 'uploads/calls/' };
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
      callPending: reports.filter(r => !r.call_status || r.call_status === 'pending').length,
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
  console.log(`   Webhook    →  POST ${APP_BASE_URL}/api/bland/webhook\n`);
});
