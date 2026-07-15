// src/deadlineEngine.js
// SW.CA1 — Shared date/deadline math (extracted for M12)
//
// Extracted so server.js (live Compliance Overview route) and
// ai/processor.js (background 30s sweep — deadline engine + new M12 alert
// engine) use the EXACT same date logic, instead of hand-maintained copies
// that can silently drift apart from each other.
//
// Before this extraction:
//   - server.js had its own _periodEndDate / _subtaskDeadline / _periodDeadline
//   - processor.js had its own separate getPeriodDeadline
//
// While extracting for M12, found that _periodDeadline (server.js) and
// getPeriodDeadline (processor.js) both still had the SAME local-time-then-
// .toISOString() bug that was found and fixed in _subtaskDeadline back in
// M11.9 (silently shifts the date back one calendar day under IST). Fixed
// here, in the one shared copy, so both callers get the corrected version
// automatically.
//
// Permanent rule (blueprint v2.10, Section 6): any function that builds a
// calendar date from y/m/d components and serializes it as an ISO string
// MUST use Date.UTC() directly — never `new Date(y, m, d)` (local time)
// followed by `.toISOString()` (always UTC). That mismatch is the bug class.

// periodEndDate — given a period string and the rule_type used to interpret
// it, returns {y, m} for the CALENDAR MONTH the period ends in. This is the
// anchor point that a subtask's due_month_offset counts forward from.
//   monthly:   the period's own month is its end month.
//   quarterly: Indian FY quarters — Q1 Apr-Jun ends June, Q2 Jul-Sep ends
//              September, Q3 Oct-Dec ends December, Q4 Jan-Mar ends March
//              (of the following calendar year).
//   annual:    Indian FY ends March 31 of the FY's end year.
function periodEndDate(period, ruleType) {
  if (!period || !ruleType) return null;
  if (ruleType === 'monthly') {
    const [y, m] = period.split('-').map(Number);
    if (!y || !m) return null;
    return { y, m };
  }
  if (ruleType === 'quarterly') {
    const match = period.match(/^(\d{4})-Q(\d)$/);
    if (!match) return null;
    const fy = parseInt(match[1]), q = parseInt(match[2]);
    const qEndMap = { 1: { m: 6, y: fy }, 2: { m: 9, y: fy }, 3: { m: 12, y: fy }, 4: { m: 3, y: fy + 1 } };
    return qEndMap[q] || null;
  }
  if (ruleType === 'annual') {
    const match = period.match(/^FY-(\d{4})-(\d{2,4})$/);
    if (!match) return null;
    const startYear = parseInt(match[1]);
    const endYear = match[2].length === 2 ? startYear + 1 : parseInt(match[2]);
    return { y: endYear, m: 3 };
  }
  return null;
}

// subtaskDeadline — computes a real due date for ONE subtask in the current
// period, from its own due_day + due_month_offset, anchored to periodEndDate.
// ruleType — pass the subtask's own `frequency` if set; if blank, pass the
// service's (or client's effective) rule_type instead.
function subtaskDeadline(subtask, period, ruleType) {
  if (!subtask || !subtask.due_day || !period || !ruleType) return null;
  const end = periodEndDate(period, ruleType);
  if (!end) return null;
  const offset = subtask.due_month_offset || 0;
  const totalMonths = (end.m - 1) + offset; // 0-indexed month math
  const year = end.y + Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  return new Date(Date.UTC(year, month - 1, subtask.due_day)).toISOString().split('T')[0];
}

// periodDeadline — the WHOLE-SERVICE deadline for a period. Used when no
// dated subtask is driving the cell (the "all_done" / fallback branches in
// Compliance Overview) and for clients.next_deadline via the deadline engine.
//
// FIXED during this M12 extraction — previously built with a local-time
// Date constructor then read back via .toISOString(), same bug class fixed
// in subtaskDeadline for M11.9. Now built with Date.UTC() directly.
function periodDeadline(rule, period) {
  if (!rule || !rule.rule_type || !rule.due_day || !period) return null;
  if (rule.rule_type === 'monthly') {
    const [year, month] = period.split('-').map(Number);
    if (!year || !month) return null;
    return new Date(Date.UTC(year, month - 1, rule.due_day)).toISOString().split('T')[0];
  }
  if (rule.rule_type === 'quarterly') {
    const m = period.match(/^(\d{4})-Q(\d)$/);
    if (!m) return null;
    const fy = parseInt(m[1]), q = parseInt(m[2]);
    const dlMap = { 1: { m: 7, y: fy }, 2: { m: 10, y: fy }, 3: { m: 1, y: fy + 1 }, 4: { m: 5, y: fy + 1 } };
    const dd = dlMap[q];
    return new Date(Date.UTC(dd.y, dd.m - 1, rule.due_day)).toISOString().split('T')[0];
  }
  if (rule.rule_type === 'annual') {
    const m = period.match(/^FY-(\d{4})-(\d{2,4})$/);
    if (!m) return null;
    const startYear = parseInt(m[1]);
    const endYear   = m[2].length === 2 ? startYear + 1 : parseInt(m[2]);
    return new Date(Date.UTC(endYear, (rule.due_month || 7) - 1, rule.due_day)).toISOString().split('T')[0];
  }
  return null;
}

module.exports = { periodEndDate, subtaskDeadline, periodDeadline };
