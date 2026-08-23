'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jba-bot-reports-'));
const dbFile = path.join(tempDir, 'reports.json');
fs.writeFileSync(dbFile, JSON.stringify({
  nextId: 3,
  reports: [
    {
      id: 1,
      inspector_name: 'Inspector A',
      property_name: 'Property A',
      address: '1 Main St',
      order_number: '354982573',
      work_code: 'E3RNN',
      due_date: '2026-08-21',
      reason: 'No Access',
      source: 'site',
      created_at: '2026-08-21T01:30:00.000Z',
      lockbox_code: 'SECRET',
      policy_holder_phone: '+1 555 000 0000',
      agent_phone: '+1 555 000 0001',
      order_screenshot: 'private.jpg',
      justification_photo: 'private-proof.jpg',
      notes: 'free-form private note',
      calls: [{ phone: '+1 555 000 0002' }],
    },
    {
      id: 2,
      inspector_name: 'Outside Range',
      created_at: '2026-08-10T12:00:00.000Z',
    },
  ],
}));

process.env.REPORTS_DB_FILE = dbFile;
process.env.BOT_REPORTS_READ_KEY = 'read-only-test-key';
process.env.DASHBOARD_PASSWORD = 'dashboard-test-password';

const { BOT_REPORT_FIELDS } = require('../bot-reports');
const { app } = require('../server');

describe('GET /api/bot/reports', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('nega chave ausente ou incorreta', async () => {
    const query = '?start_date=2026-08-20&end_date=2026-08-22';
    const missing = await fetch(`${baseUrl}/api/bot/reports${query}`);
    const wrong = await fetch(`${baseUrl}/api/bot/reports${query}`, {
      headers: { 'x-bot-key': 'wrong-key' },
    });

    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
  });

  it('exige intervalo curto e válido', async () => {
    const missing = await fetch(`${baseUrl}/api/bot/reports`, {
      headers: { 'x-bot-key': 'read-only-test-key' },
    });
    const tooWide = await fetch(`${baseUrl}/api/bot/reports?start_date=2026-08-01&end_date=2026-08-22`, {
      headers: { 'x-bot-key': 'read-only-test-key' },
    });

    assert.equal(missing.status, 400);
    assert.equal(tooWide.status, 400);
  });

  it('retorna allowlist sem fotos, lockbox, telefones, chamadas ou notas', async () => {
    const response = await fetch(`${baseUrl}/api/bot/reports?start_date=2026-08-20&end_date=2026-08-22`, {
      headers: { 'x-bot-key': 'read-only-test-key' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.reports.length, 1);
    assert.deepEqual(Object.keys(body.reports[0]), BOT_REPORT_FIELDS);
    assert.equal(body.reports[0].order_number, '354982573');
    for (const forbidden of ['lockbox_code', 'policy_holder_phone', 'agent_phone', 'order_screenshot', 'justification_photo', 'notes', 'calls']) {
      assert.equal(Object.hasOwn(body.reports[0], forbidden), false);
    }
  });

  it('mantém a API humana protegida por sessão', async () => {
    const response = await fetch(`${baseUrl}/api/reports`);
    assert.equal(response.status, 401);
  });
});
