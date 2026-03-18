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
const JBA_PHONE     = process.env.JBA_PHONE || '(614) 304-3490';

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

function esc(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
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

function generateCallScreenshotSVG(report, call) {
  const filename = `call-screenshot-report${report.id}-${call.type}-${Date.now()}.svg`;
  const outPath  = path.join('uploads', 'calls', filename);

  const contactName  = call.type === 'agent'
    ? (report.agent_name          || 'Insurance Agent')
    : (report.policy_holder_name  || 'Policy Holder');
  const contactPhone = call.type === 'agent'
    ? (report.agent_phone         || '—')
    : (report.policy_holder_phone || '—');
  const typeLabel    = call.type === 'agent' ? 'Insurance Agent' : 'Policy Holder';
  const status       = call.status || 'answered';
  const statusLabels = { answered:'Call Ended', voicemail:'Voicemail Left', no_answer:'No Answer', calling:'In Call', error:'Failed' };
  const statusLabel  = statusLabels[status] || status;
  const callTime     = call.ended_at
    ? new Date(call.ended_at).toLocaleString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:true})
    : new Date().toLocaleString('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:true});
  const callDate     = call.ended_at
    ? new Date(call.ended_at).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'})
    : new Date().toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'});
  // Duration estimate
  const dur = (call.dispatched_at && call.ended_at)
    ? (() => { const s = Math.round((new Date(call.ended_at)-new Date(call.dispatched_at))/1000); return s > 0 ? `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}` : '0:00'; })()
    : '—';
  const carrier = escapeXml(report.insurance_carrier || 'State Farm');
  const cName   = escapeXml(contactName.length > 18 ? contactName.slice(0,17)+'…' : contactName);
  const cPhone  = escapeXml(contactPhone);
  const ordNum  = escapeXml(report.order_number || '—');

  const bgColor   = status === 'answered' ? '#1a3a1a' : status === 'voicemail' ? '#2d2200' : '#2a0a0a';
  const dotColor  = status === 'answered' ? '#4ade80' : status === 'voicemail' ? '#fbbf24' : '#f87171';
  const statColor = status === 'answered' ? '#86efac' : status === 'voicemail' ? '#fde68a' : '#fca5a5';

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="580" viewBox="0 0 320 580">
  <defs>
    <clipPath id="phone"><rect x="8" y="8" width="304" height="564" rx="36"/></clipPath>
  </defs>
  <!-- Phone shell -->
  <rect x="0" y="0" width="320" height="580" rx="42" fill="#1a1a1a"/>
  <rect x="3" y="3" width="314" height="574" rx="40" fill="none" stroke="#333" stroke-width="1.5"/>
  <!-- Screen -->
  <rect x="8" y="8" width="304" height="564" rx="36" fill="${bgColor}"/>
  <!-- Status bar -->
  <rect x="8" y="8" width="304" height="44" rx="0" fill="rgba(0,0,0,0.3)" clip-path="url(#phone)"/>
  <text x="28" y="32" font-family="Arial,sans-serif" font-size="13" fill="#fff" font-weight="600">${escapeXml(callTime)}</text>
  <!-- Notch -->
  <rect x="118" y="8" width="84" height="26" rx="13" fill="#1a1a1a"/>
  <!-- Signal bars -->
  <rect x="250" y="22" width="4" height="8" rx="1" fill="#fff" opacity=".4"/>
  <rect x="257" y="19" width="4" height="11" rx="1" fill="#fff" opacity=".6"/>
  <rect x="264" y="16" width="4" height="14" rx="1" fill="#fff" opacity=".8"/>
  <rect x="271" y="13" width="4" height="17" rx="1" fill="#fff"/>
  <!-- Wifi -->
  <text x="282" y="33" font-family="Arial,sans-serif" font-size="14" fill="#fff">⊙</text>
  <!-- JBA Tag -->
  <rect x="94" y="58" width="132" height="22" rx="11" fill="rgba(255,255,255,0.1)"/>
  <text x="160" y="73" font-family="Arial,sans-serif" font-size="11" fill="rgba(255,255,255,0.7)" text-anchor="middle">JBA Property Solutions</text>
  <!-- Contact avatar circle -->
  <circle cx="160" cy="148" r="52" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="1.5"/>
  <circle cx="160" cy="135" r="22" fill="rgba(255,255,255,0.2)"/>
  <ellipse cx="160" cy="170" rx="30" ry="18" fill="rgba(255,255,255,0.2)"/>
  <!-- Status dot -->
  <circle cx="198" cy="105" r="8" fill="${dotColor}"/>
  <!-- Contact name -->
  <text x="160" y="222" font-family="Arial,sans-serif" font-size="20" font-weight="700" fill="#ffffff" text-anchor="middle">${cName}</text>
  <!-- Type label -->
  <text x="160" y="246" font-family="Arial,sans-serif" font-size="13" fill="rgba(255,255,255,0.6)" text-anchor="middle">${escapeXml(typeLabel)}</text>
  <!-- Phone number -->
  <text x="160" y="272" font-family="Arial,sans-serif" font-size="14" fill="rgba(255,255,255,0.5)" text-anchor="middle">${cPhone}</text>
  <!-- Status label -->
  <text x="160" y="306" font-family="Arial,sans-serif" font-size="15" font-weight="600" fill="${statColor}" text-anchor="middle">${escapeXml(statusLabel)}</text>
  <!-- Duration -->
  <text x="160" y="332" font-family="Arial,sans-serif" font-size="28" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeXml(dur)}</text>
  <!-- Divider -->
  <line x1="40" y1="358" x2="280" y2="358" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <!-- Info rows -->
  <text x="40" y="382" font-family="Arial,sans-serif" font-size="11" fill="rgba(255,255,255,0.4)">ORDER</text>
  <text x="280" y="382" font-family="Arial,sans-serif" font-size="11" fill="rgba(255,255,255,0.8)" text-anchor="end">${ordNum}</text>
  <text x="40" y="404" font-family="Arial,sans-serif" font-size="11" fill="rgba(255,255,255,0.4)">CARRIER</text>
  <text x="280" y="404" font-family="Arial,sans-serif" font-size="11" fill="rgba(255,255,255,0.8)" text-anchor="end">${carrier}</text>
  <text x="40" y="426" font-family="Arial,sans-serif" font-size="11" fill="rgba(255,255,255,0.4)">DATE</text>
  <text x="280" y="426" font-family="Arial,sans-serif" font-size="11" fill="rgba(255,255,255,0.8)" text-anchor="end">${escapeXml(callDate)}</text>
  <text x="40" y="448" font-family="Arial,sans-serif" font-size="11" fill="rgba(255,255,255,0.4)">ANSWERED BY</text>
  <text x="280" y="448" font-family="Arial,sans-serif" font-size="11" fill="rgba(255,255,255,0.8)" text-anchor="end">${escapeXml(call.answered_by||'—')}</text>
  <!-- Divider -->
  <line x1="40" y1="464" x2="280" y2="464" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
  <!-- Action buttons -->
  <circle cx="100" cy="510" r="30" fill="rgba(255,255,255,0.08)"/>
  <text x="100" y="517" font-family="Arial,sans-serif" font-size="22" text-anchor="middle" fill="rgba(255,255,255,0.5)">✉</text>
  <circle cx="160" cy="510" r="30" fill="rgba(239,68,68,0.8)"/>
  <text x="160" y="517" font-family="Arial,sans-serif" font-size="22" text-anchor="middle" fill="#fff">✆</text>
  <circle cx="220" cy="510" r="30" fill="rgba(255,255,255,0.08)"/>
  <text x="220" y="517" font-family="Arial,sans-serif" font-size="22" text-anchor="middle" fill="rgba(255,255,255,0.5)">🔊</text>
  <!-- Bottom bar -->
  <rect x="130" y="556" width="60" height="4" rx="2" fill="rgba(255,255,255,0.3)"/>
  <!-- Verified badge -->
  <rect x="55" y="472" width="210" height="22" rx="11" fill="rgba(255,255,255,0.06)"/>
  <text x="160" y="487" font-family="Arial,sans-serif" font-size="10" fill="rgba(255,255,255,0.4)" text-anchor="middle">✓ Verified outbound call via Bland.ai</text>
</svg>`;

  fs.writeFileSync(outPath, svg, 'utf8');
  return filename;
}

function generateCallEvidenceHTML(report, call) {
  const callType   = call.type === 'agent' ? 'Insurance Agent' : 'Policy Holder';
  const contactName  = call.type === 'agent' ? (report.agent_name || '—') : (report.policy_holder_name || '—');
  const contactPhone = call.type === 'agent' ? (report.agent_phone || '—') : (report.policy_holder_phone || '—');
  const carrier    = report.insurance_carrier || '—';
  const status     = call.status || 'pending';
  const statusColors = {
    answered:  ['#005c2e','#e8f7ef','ANSWERED — Human Pickup'],
    voicemail: ['#7a4a00','#fdf3e0','VOICEMAIL LEFT'],
    no_answer: ['#8b1a1a','#fdeaea','NO ANSWER'],
    error:     ['#8b1a1a','#fdeaea','ERROR'],
    calling:   ['#0a3d8f','#e8f0fc','IN PROGRESS'],
    pending:   ['#444','#f5f5f5','PENDING'],
  };
  const [sc, sbg, slabel] = statusColors[status] || statusColors.pending;
  const genDate  = nowLocal();
  const endedAt  = call.ended_at  ? new Date(call.ended_at).toLocaleString('en-US',{timeZone:'America/New_York',dateStyle:'full',timeStyle:'medium'}) + ' ET' : '—';
  const dispAt   = call.dispatched_at ? new Date(call.dispatched_at).toLocaleString('en-US',{timeZone:'America/New_York',dateStyle:'full',timeStyle:'medium'}) + ' ET' : '—';
  const answeredBy = call.answered_by || '—';
  const summary  = esc(call.summary || 'No AI summary returned.');
  const recUrl   = call.recording_url || null;
  const callId   = call.call_id || '—';
  const filename = `evidence-report${report.id}-${call.type}-${Date.now()}.html`;
  const outPath  = path.join('uploads', 'calls', filename);

  const reasonLabels = {
    asked_to_leave:'Asked to Leave',gated:'Gated',dog:'Dog in Yard',
    bad_address:'Bad Address',child:'Child in Property'
  };
  const reasonLabel = reasonLabels[report.reason] || report.reason || '—';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Call Evidence — ${callType} — Report #${report.id}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;background:#eef2f7;color:#0a1628;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:900px;margin:0 auto;background:#fff;box-shadow:0 2px 24px rgba(0,0,0,.12)}
.hdr{background:linear-gradient(135deg,#0d1f3c,#102a50);padding:0;border-bottom:4px solid #CC0000}
.hdr-top{display:flex;align-items:center;justify-content:space-between;padding:20px 32px 16px}
.hdr-brand{display:flex;align-items:center;gap:12px}
.hdr-logo{width:52px;height:52px;background:#CC0000;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:#fff;letter-spacing:-1px}
.hdr-title{font-size:22px;font-weight:900;color:#fff;letter-spacing:.3px}
.hdr-sub{font-size:12px;color:#8a9ab8;margin-top:2px}
.hdr-badge{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px 18px;text-align:right}
.hdr-badge-label{font-size:10px;color:#8a9ab8;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.hdr-badge-val{font-size:20px;font-weight:900;color:#fff;margin-top:2px}
.hdr-strip{background:rgba(0,0,0,.2);padding:10px 32px;display:flex;gap:24px;flex-wrap:wrap}
.hdr-meta{font-size:11px;color:#6a7fa8}
.hdr-meta strong{color:#a0b0c8;font-weight:700}
.body{padding:28px 32px}
.section{margin-bottom:22px}
.section-title{font-size:10px;font-weight:700;color:#CC0000;letter-spacing:1.8px;text-transform:uppercase;margin-bottom:8px;padding-bottom:5px;border-bottom:1.5px solid #f0e0e0}
.status-banner{border-radius:10px;padding:16px 20px;margin-bottom:20px;display:flex;align-items:center;gap:14px;border:2px solid ${sc}33}
.status-banner .dot{width:14px;height:14px;border-radius:50%;background:${sc};flex-shrink:0}
.status-banner .slabel{font-size:16px;font-weight:900;color:${sc}}
.status-banner .sdesc{font-size:12px;color:#6b7fa8;margin-top:2px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.field{background:#f7f9fd;border:1px solid #dce6f0;border-radius:7px;padding:10px 14px}
.field.full{grid-column:1/-1}
.flbl{font-size:10px;font-weight:700;color:#6b7fa8;letter-spacing:.8px;text-transform:uppercase;margin-bottom:3px}
.fval{font-size:13px;font-weight:700;color:#0a1628;word-break:break-all}
.fval.mono{font-family:monospace;font-size:11px;font-weight:400;color:#253756}
.summary-box{background:#f4f7fc;border:1px solid #dce6f0;border-radius:8px;padding:14px 16px;font-size:13px;color:#253756;line-height:1.7}
.rec-box{background:#f0f4fa;border:1px solid #c8d8ec;border-radius:7px;padding:11px 14px;display:flex;align-items:center;gap:10px}
.rec-icon{width:32px;height:32px;background:#0a3d8f;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.rec-label{font-size:11px;font-weight:700;color:#6b7fa8;text-transform:uppercase;letter-spacing:.8px}
.rec-url{font-size:11px;font-family:monospace;color:#0a3d8f;word-break:break-all}
.cert-box{background:linear-gradient(135deg,#0d1f3c,#102a50);border-radius:10px;padding:16px 20px;margin-top:20px;display:flex;align-items:flex-start;gap:14px}
.cert-icon{width:36px;height:36px;background:#CC0000;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;color:#fff;font-weight:900}
.cert-text{font-size:12px;color:rgba(255,255,255,.75);line-height:1.6}
.cert-text strong{color:#fff;font-size:13px;display:block;margin-bottom:3px}
.footer{background:#f0f4fa;border-top:2px solid #dce6f0;padding:12px 32px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.fl{font-size:11px;color:#8a9ab8}
.fl strong{color:#0a1628;display:block;font-size:12px}
.fr{font-size:11px;font-weight:700;color:#CC0000;text-align:right}
.print-btn{position:fixed;bottom:18px;right:18px;background:#0a3d8f;color:#fff;border:none;padding:12px 22px;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(10,61,143,.35);z-index:999}
.print-btn:hover{background:#1a6fff}
@media print{.print-btn{display:none}body{background:#fff}.page{box-shadow:none;max-width:100%}}
</style>
</head>
<body>
<div class="page">
<div class="hdr">
  <div class="hdr-top">
    <div class="hdr-brand">
      <div class="hdr-logo">JBA</div>
      <div>
        <div class="hdr-title">Call Attempt Evidence</div>
        <div class="hdr-sub">JBA Property Solutions — Automated Outreach Record</div>
      </div>
    </div>
    <div class="hdr-badge">
      <div class="hdr-badge-label">Report</div>
      <div class="hdr-badge-val">#${report.id}</div>
    </div>
  </div>
  <div class="hdr-strip">
    <span class="hdr-meta"><strong>Contact Type:</strong> ${callType}</span>
    <span class="hdr-meta"><strong>Contact:</strong> ${esc(contactName)}</span>
    <span class="hdr-meta"><strong>Phone:</strong> ${esc(contactPhone)}</span>
    <span class="hdr-meta"><strong>Carrier:</strong> ${esc(carrier)}</span>
    <span class="hdr-meta"><strong>Generated:</strong> ${esc(genDate)}</span>
  </div>
</div>
<div class="body">

  <div class="status-banner" style="background:${sbg}">
    <div class="dot"></div>
    <div>
      <div class="slabel">${slabel}</div>
      <div class="sdesc">Call completed — status confirmed by Bland.ai webhook · Answered by: ${esc(answeredBy)}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Work Order Details</div>
    <div class="grid2">
      <div class="field full"><div class="flbl">Property Address</div><div class="fval">${esc(report.address||'—')}</div></div>
      <div class="field"><div class="flbl">Order Number</div><div class="fval">${esc(report.order_number||'—')}</div></div>
      <div class="field"><div class="flbl">Inspector</div><div class="fval">${esc(report.inspector_name||'—')}</div></div>
      <div class="field"><div class="flbl">Reason for Non-Completion</div><div class="fval">${esc(reasonLabel)}</div></div>
      <div class="field"><div class="flbl">Insurance Carrier</div><div class="fval">${esc(carrier)}</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Call Record — ${callType}</div>
    <div class="grid2">
      <div class="field"><div class="flbl">Contact Name</div><div class="fval">${esc(contactName)}</div></div>
      <div class="field"><div class="flbl">Phone Number Called</div><div class="fval">${esc(contactPhone)}</div></div>
      <div class="field"><div class="flbl">Call Initiated At (ET)</div><div class="fval">${esc(dispAt)}</div></div>
      <div class="field"><div class="flbl">Call Ended At (ET)</div><div class="fval">${esc(endedAt)}</div></div>
      <div class="field"><div class="flbl">Call Status</div><div class="fval" style="color:${sc};font-weight:900">${slabel}</div></div>
      <div class="field"><div class="flbl">Answered By</div><div class="fval">${esc(answeredBy)}</div></div>
      <div class="field full"><div class="flbl">Bland.ai Call ID</div><div class="fval mono">${esc(callId)}</div></div>
    </div>
  </div>

  ${recUrl ? `
  <div class="section">
    <div class="section-title">Call Recording</div>
    <div class="rec-box">
      <div class="rec-icon">▶</div>
      <div>
        <div class="rec-label">Recording URL</div>
        <div class="rec-url"><a href="${esc(recUrl)}" target="_blank" style="color:#0a3d8f">${esc(recUrl)}</a></div>
      </div>
    </div>
  </div>` : ''}

  <div class="section">
    <div class="section-title">AI Call Summary</div>
    <div class="summary-box">${summary}</div>
  </div>

  <div class="cert-box">
    <div class="cert-icon">✓</div>
    <div class="cert-text">
      <strong>Official Certification of Call Attempt</strong>
      This document certifies that JBA Property Solutions, acting as an authorized field inspection partner of ${esc(carrier)},
      placed an automated notification call to the ${callType} (${esc(contactName)}) at ${esc(contactPhone)} on ${esc(dispAt)}.
      This call was dispatched via Bland.ai (Call ID: ${esc(callId)}) as part of the non-completion follow-up process
      for property survey order #${esc(report.order_number||'—')} at ${esc(report.address||'—')}.
      All timestamps are in Eastern Time (ET).
    </div>
  </div>

</div>
<div class="footer">
  <div class="fl"><strong>JBA Property Solutions</strong>Automated evidence document — Report #${report.id} — All times in ET</div>
  <div class="fr">${esc(carrier)} Partner<br><span style="color:#8a9ab8;font-weight:400">Order: ${esc(report.order_number||'—')}</span></div>
</div>
</div>
<div style="position:fixed;bottom:18px;right:18px;display:flex;flex-direction:column;gap:8px;z-index:999">
  <button class="print-btn" onclick="window.print()">🖨 Print / Save PDF</button>
  <button class="print-btn" id="jpegBtn" onclick="saveJPEG()" style="background:#CC0000;">📷 Save as JPEG</button>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<script>
async function saveJPEG() {
  const btn = document.getElementById('jpegBtn');
  btn.textContent = '⏳ Generating...';
  btn.disabled = true;
  try {
    // Hide buttons during capture
    document.querySelectorAll('.print-btn, #jpegBtn').forEach(b => b.style.display='none');
    const canvas = await html2canvas(document.querySelector('.page'), {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
    });
    document.querySelectorAll('.print-btn, #jpegBtn').forEach(b => b.style.display='');
    const link = document.createElement('a');
    link.download = 'call-evidence-report${report.id}-${call.type}.jpg';
    link.href = canvas.toDataURL('image/jpeg', 0.95);
    link.click();
  } catch(e) {
    alert('Error generating JPEG: ' + e.message);
  }
  btn.textContent = '📷 Save as JPEG';
  btn.disabled = false;
  document.querySelectorAll('.print-btn, #jpegBtn').forEach(b => b.style.display='');
}
</script>
</body>
</html>`;

  fs.writeFileSync(outPath, html, 'utf8');
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
    };

    const defaultScripts = {
      agentScript: 'Our inspector was unable to complete the survey today. Could you please assist by contacting the client so we can arrange to complete the survey?',
      phScript:    'Our inspector was unable to complete the survey today. We would like to schedule a time to return. The survey is exterior only and takes just a few minutes.',
    };

    const s = situationMap[reason] || defaultScripts;

    const task = isAgent ? `You are Anna from JBA Property Solutions. Ask for ${name}. When reached say: "${s.agentScript} Questions? Call ${JBA_PHONE}." Voicemail: "Hi ${name}, Anna from JBA Property Solutions. Survey at ${address} order ${orderNum}. ${s.agentScript} Call us at ${JBA_PHONE}." Never say inspection, always say survey. Summarize outcome.`.trim() : `You are Anna from JBA Property Solutions. Ask for ${name}. When reached say: "${s.phScript} Questions? Call ${JBA_PHONE}." Goal: get permission, gate code, address, or schedule date Mon-Sat 8AM-5PM. Voicemail: "Hi ${name}, Anna from JBA Property Solutions. Survey at ${address} order ${orderNum}. ${s.phScript} Call us at ${JBA_PHONE}." Never say inspection, always say survey. Summarize outcome.`.trim();

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
      rep.agent_phone && rep.agent_phone !== rep.policy_holder_phone
        ? { type: 'agent', phone: rep.agent_phone, name: rep.agent_name } : null,
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
      // Generate evidence HTML — wrapped so a crash here doesn't lose the call data
      try {
        entry.evidence_file    = generateCallEvidenceHTML(rep, entry);
        entry.screenshot_file  = generateCallScreenshotSVG(rep, entry);
        // call_screenshot points to last screenshot for backward compat
        rep.call_screenshot = entry.screenshot_file;
      } catch (evErr) {
        console.error('Evidence generation failed:', evErr.message);
      }
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
    console.log(`Webhook: report ${report_id} call ${call_id} → ${mapped} | evidence: ${entry?.evidence_file || 'none'}`);
  } catch (e) { console.error('Webhook:', e.message); }
  res.sendStatus(200);
});

// ── Evidence by call index ───────────────────────────────────
app.get('/api/reports/:id/evidence/:callIndex', (req, res) => {
  try {
    const db  = readDB();
    const rep = db.reports.find(r => r.id === Number(req.params.id));
    if (!rep) return res.status(404).send('Report not found');
    const idx  = Number(req.params.callIndex);
    const call = rep.calls?.[idx];
    if (!call) return res.status(404).send('Call not found');
    if (!call.evidence_file) return res.status(404).send('Evidence not yet generated');
    const filePath = path.join(__dirname, 'uploads', 'calls', call.evidence_file);
    if (!fs.existsSync(filePath)) return res.status(404).send('Evidence file missing');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.resolve(filePath));
  } catch (e) { res.status(500).send(e.message); }
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
      badAddress:   reports.filter(r => r.reason === 'bad_address').length,
      askedLeave:   reports.filter(r => r.reason === 'asked_to_leave').length,
      gated:        reports.filter(r => r.reason === 'gated').length,
      dog:          reports.filter(r => r.reason === 'dog').length,
      child:        reports.filter(r => r.reason === 'child').length,
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
