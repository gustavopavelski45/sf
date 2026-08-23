'use strict';

const crypto = require('crypto');

const BOT_REPORT_FIELDS = Object.freeze([
  'id',
  'inspector_name',
  'property_name',
  'address',
  'order_number',
  'work_code',
  'due_date',
  'reason',
  'source',
  'created_at',
]);

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hasBotReportsAccess(req, expectedKey) {
  const supplied = req.get('x-bot-key') || '';
  return !!expectedKey && safeEqual(supplied, expectedKey);
}

function isIsoDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function validateBotReportsQuery(query) {
  const startDate = String(query.start_date || '');
  const endDate = String(query.end_date || '');
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
    return { ok: false, error: 'invalid_date_range' };
  }
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${endDate}T00:00:00.000Z`);
  const spanDays = (endMs - startMs) / 86_400_000;
  if (spanDays < 0 || spanDays > 3) {
    return { ok: false, error: 'invalid_date_range' };
  }
  return { ok: true, startDate, endDate };
}

function toBotReport(report) {
  return Object.fromEntries(BOT_REPORT_FIELDS.map((field) => [field, report[field] ?? null]));
}

function selectBotReports(reports, startDate, endDate) {
  return reports
    .filter((report) => {
      const date = String(report.created_at || '').slice(0, 10);
      return date >= startDate && date <= endDate;
    })
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
    .map(toBotReport);
}

module.exports = {
  BOT_REPORT_FIELDS,
  hasBotReportsAccess,
  safeEqual,
  selectBotReports,
  toBotReport,
  validateBotReportsQuery,
};
