import { ipcMain, BrowserWindow, dialog } from 'electron';
import { dbApi as db } from './db.js';
import { fetchAllProducts, getProductInfo, getShopInfo, randomSleep, updateDaysToShip } from './shopee-client.js';

const running = new Set();
const stopRequested = new Set();
const now = () => Math.floor(Date.now() / 1000);
const LOG_RETENTION_DAYS = 15;
const DETAIL_WORKERS = 10;
const DETAIL_RETRY = 3;
const CHANGE_WORKERS = 1;
const FETCH_RESUME_INTERVAL_MS = 30000;
const NETWORK_PROBE_INTERVAL_MS = 2000;
let logCleanupTimer = null;
let scheduleTimer = null;
const activeScheduleRuns = new Set();

function addLog(accountId, tab, message, type = 'info') {
  db.prepare('INSERT INTO logs (account_id, tab, message, type, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, tab, message, type, now());
}
function addScheduleTaskLog(taskId, message, type = 'info', groupId = null) {
  db.prepare('INSERT INTO schedule_task_logs (task_id, group_id, message, type, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, groupId, message, type, now());
}

function createTask(accountId, taskType, payload = {}) {
  const t = now();
  return db.prepare(`
    INSERT INTO task_queue (account_id, task_type, payload_json, status, created_at, updated_at, last_error)
    VALUES (?, ?, ?, 'running', ?, ?, NULL)
  `).run(accountId, taskType, JSON.stringify(payload || {}), t, t).lastInsertRowid;
}

function findLatestListPhaseFinishedLogTime(accountId, fromTs) {
  const row = db.prepare(`
    SELECT created_at
    FROM logs
    WHERE account_id = ?
      AND tab = 'products'
      AND created_at >= ?
      AND message LIKE 'List phase finished.%'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(accountId, Number(fromTs || 0));
  return Number(row?.created_at || 0);
}

function hasListPhaseFinishedForTask(accountId, taskRow) {
  if (!taskRow) return false;
  const startTs = Number(taskRow.created_at || 0);
  if (!startTs) return false;
  const endTs = Number(taskRow.updated_at || 0) || now();
  const finishedTs = findLatestListPhaseFinishedLogTime(accountId, startTs);
  return finishedTs >= startTs && finishedTs <= endTs + 1;
}

function markTaskDone(taskId) {
  db.prepare('UPDATE task_queue SET status = ?, updated_at = ?, last_error = NULL WHERE id = ?')
    .run('done', now(), taskId);
}

function markTaskFailed(taskId, err) {
  db.prepare('UPDATE task_queue SET status = ?, updated_at = ?, last_error = ? WHERE id = ?')
    .run('failed', now(), String(err?.message || err || ''), taskId);
}

function markAccountTasksStopped(accountId) {
  db.prepare("UPDATE task_queue SET status = 'stopped', updated_at = ?, last_error = ? WHERE account_id = ? AND status = 'running'")
    .run(now(), 'Task stopped by user', accountId);
}

async function runExclusive(accountId, fn) {
  if (running.has(accountId)) throw new Error('Task already running');
  running.add(accountId);
  stopRequested.delete(accountId);
  try {
    return await fn();
  } finally {
    stopRequested.delete(accountId);
    running.delete(accountId);
  }
}

function ensureNotStopped(accountId) {
  if (stopRequested.has(accountId)) {
    throw new Error('Task stopped by user');
  }
}

function getTaskPayload(taskId) {
  const row = db.prepare('SELECT payload_json FROM task_queue WHERE id = ?').get(taskId);
  if (!row?.payload_json) return {};
  try {
    return JSON.parse(row.payload_json) || {};
  } catch {
    return {};
  }
}

function updateTaskPayload(taskId, patch) {
  const prev = getTaskPayload(taskId);
  const next = { ...prev, ...(patch || {}) };
  db.prepare('UPDATE task_queue SET payload_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(next), now(), taskId);
}

function isRetriableError(msg) {
  const s = String(msg || '').toLowerCase();
  if (!s) return false;
  if (/task stopped by user/i.test(s)) return false;
  return (
    /http 429/.test(s)
    || /rate limit/.test(s)
    || /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up/.test(s)
    || /network|failed to fetch|fetch failed/.test(s)
    || /request failed|gateway|bad gateway|service unavailable/.test(s)
    || /http 401|http 403|unauthorized|forbidden|not login|invalid token|token invalid|cookie/.test(s)
  );
}

function isRateLimitError(msg) {
  return /http 429|rate limit/i.test(String(msg || ''));
}

function isNetworkError(msg) {
  return /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|failed to fetch|fetch failed/i
    .test(String(msg || ''));
}
function isCookieExpiredError(msg) {
  const s = String(msg || '').toLowerCase();
  if (!s) return false;
  return (
    /http 401|http 403/.test(s)
    || /unauthorized|forbidden|not login|token invalid|invalid token|login expired|session expired/.test(s)
    || /cookie json 不能為空|cookie json 解析失敗|cookie 必須是 json 格式|missing cookie/.test(s)
  );
}

async function waitForNetworkRecovery(accountId, tab, cookieJson) {
  addLog(accountId, tab, `Network down, start probing every ${Math.floor(NETWORK_PROBE_INTERVAL_MS / 1000)}s`, 'info');
  let probeCount = 0;
  while (true) {
    ensureNotStopped(accountId);
    try {
      await getShopInfo(cookieJson);
      addLog(accountId, tab, 'Network probe passed, resume task', 'success');
      return;
    } catch (e) {
      const msg = String(e?.message || e || '');
      // If error is not network-like, stop probing and rethrow so task can fail fast.
      if (!isNetworkError(msg)) {
        throw e;
      }
      probeCount += 1;
      if (probeCount % 15 === 0) {
        addLog(accountId, tab, `Still offline after ${probeCount} probes`, 'info');
      }
      await new Promise((r) => setTimeout(r, NETWORK_PROBE_INTERVAL_MS));
    }
  }
}
async function waitForCookieRecovery(accountId, tab) {
  addLog(accountId, tab, `Cookie invalid/expired. Please update cookie in account editor, probing every ${Math.floor(NETWORK_PROBE_INTERVAL_MS / 1000)}s`, 'error');
  let probeCount = 0;
  while (true) {
    ensureNotStopped(accountId);
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acc) throw new Error('Account not found');
    try {
      await getShopInfo(acc.cookie_json);
      addLog(accountId, tab, 'Cookie probe passed, resume task', 'success');
      return acc.cookie_json;
    } catch (e) {
      probeCount += 1;
      if (probeCount % 15 === 0) {
        addLog(accountId, tab, `Still waiting for valid cookie... probes=${probeCount}`, 'info');
      }
      await new Promise((r) => setTimeout(r, NETWORK_PROBE_INTERVAL_MS));
    }
  }
}

function cleanupOldLogs() {
  const threshold = now() - LOG_RETENTION_DAYS * 24 * 60 * 60;
  const row = db.prepare('SELECT COUNT(1) AS c FROM logs WHERE created_at < ?').get(threshold);
  const count = Number(row?.c || 0);
  if (count > 0) {
    db.prepare('DELETE FROM logs WHERE created_at < ?').run(threshold);
    console.log(`[log-cleanup] removed ${count} logs older than ${LOG_RETENTION_DAYS} days`);
  } else {
    console.log('[log-cleanup] nothing to remove');
  }
}

function msUntilNextMidnight() {
  const d = new Date();
  const next = new Date(d);
  next.setHours(24, 0, 0, 0);
  return Math.max(1000, next.getTime() - d.getTime());
}

function startLogCleanupScheduler() {
  if (logCleanupTimer) return;
  const scheduleNext = () => {
    const delay = msUntilNextMidnight();
    logCleanupTimer = setTimeout(() => {
      try {
        cleanupOldLogs();
      } catch (e) {
        console.error('[log-cleanup] failed:', e);
      } finally {
        scheduleNext();
      }
    }, delay);
  };
  scheduleNext();
}

async function executeFetchProducts(accountId, taskId = null, resumePayload = null) {
  ensureNotStopped(accountId);
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) throw new Error('Account not found');
  addLog(accountId, 'products', 'Start fetching products');
  const resume = resumePayload || {};
  const latestIds = new Set();
  const hasCheckpoint = Boolean(resume?.list_initialized);
  if (hasCheckpoint) {
    const rows = db.prepare('SELECT product_id FROM products WHERE account_id = ? AND exists_in_latest = 1').all(accountId);
    for (const r of rows) latestIds.add(r.product_id);
    addLog(accountId, 'products', `Resume checkpoint loaded: cursor=${resume?.resume_cursor || ''} page=${Number(resume?.resume_page || 0)} fetched=${Number(resume?.fetched_count || 0)} latest=${latestIds.size}`, 'info');
  }
  const detailQueued = new Set();
  const detailQueue = [];
  let detailDone = 0;
  let detailOk = 0;
  let expectedTotal = Number(resume?.expected_total || 0);
  let listDone = false;
  let fetchedTotal = Number(resume?.fetched_count || 0);
  let resumeCursor = String(resume?.resume_cursor || '');
  let resumePage = Number(resume?.resume_page || 0);
  let perfApiMs = 0;
  let perfDbMs = 0;
  let perfTotalMs = 0;
  const detailDeferred429 = [];
  const detailDeferredNet = [];
  const detailDeferredCookie = [];
  const upsertBasic = db.prepare(`
      INSERT INTO products (account_id, product_id, name, image, price, stock, days_to_ship, status, is_pre_order, detail_json, fetched_at, exists_in_latest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(account_id, product_id) DO UPDATE SET
        name=excluded.name,image=excluded.image,price=excluded.price,stock=excluded.stock,
        days_to_ship=excluded.days_to_ship,status=excluded.status,is_pre_order=excluded.is_pre_order,
        fetched_at=excluded.fetched_at,exists_in_latest=1
    `);
  const updateDetail = db.prepare('UPDATE products SET detail_json = ?, fetched_at = ?, days_to_ship = ?, is_pre_order = ? WHERE account_id = ? AND product_id = ?');
  const sleepWithStop = async (ms) => {
    let left = ms;
    while (left > 0) {
      ensureNotStopped(accountId);
      const chunk = Math.min(1000, left);
      await new Promise((r) => setTimeout(r, chunk));
      left -= chunk;
    }
  };

  const logDetailProgress = () => {
    const base = Math.max(expectedTotal, fetchedTotal, detailDone, 1);
    const listNotFinished = !listDone;
    const displayTotal = listNotFinished && detailDone >= base ? base + 1 : base;
    const percent = Math.min(100, Math.floor((detailDone / displayTotal) * 100));
    const statusSuffix = listNotFinished ? ' list=running' : ' list=done';
    addLog(accountId, 'products', `Progress detail: ${detailDone}/${displayTotal} success=${detailOk} percent=${percent}${statusSuffix}`);
    if (detailDone > 0 && detailDone % 20 === 0) {
      const denom = Math.max(detailOk, 1);
      addLog(
        accountId,
        'products',
        `Detail perf summary done=${detailDone} ok=${detailOk} avg_api=${Math.round(perfApiMs / denom)}ms avg_db=${Math.round(perfDbMs / denom)}ms avg_total=${Math.round(perfTotalMs / denom)}ms`,
      );
    }
  };

  const processDetailItem = async (productId, phaseLabel = 'main') => {
    const tStart = Date.now();
    try {
      const tApiStart = Date.now();
      const detail = await withRetry(
        () => getProductInfo(acc.cookie_json, productId, false),
        DETAIL_RETRY,
        (attempt, err) => addLog(accountId, 'products', `Detail retry ${attempt}/${DETAIL_RETRY}: ${productId} ${err?.message || err}`, 'error'),
      );
      const apiMs = Date.now() - tApiStart;
      const dts = Number(detail?.pre_order_info?.days_to_ship ?? 0);
      const isPre = detail?.pre_order_info?.pre_order ? 1 : 0;
      const tDbStart = Date.now();
      updateDetail.run(JSON.stringify(detail || {}), now(), dts, isPre, accountId, productId);
      const dbMs = Date.now() - tDbStart;
      const totalMs = Date.now() - tStart;
      perfApiMs += apiMs;
      perfDbMs += dbMs;
      perfTotalMs += totalMs;
      detailOk += 1;
      addLog(accountId, 'products', `Detail perf item=${productId} api=${apiMs}ms db=${dbMs}ms total=${totalMs}ms phase=${phaseLabel}`);
      detailDone += 1;
      logDetailProgress();
      return 'done';
    } catch (e) {
      const msg = String(e?.message || e || '');
      if (isRateLimitError(msg)) {
        addLog(accountId, 'products', `Detail defer429(${phaseLabel}): ${productId} ${msg}`, 'info');
        return 'defer429';
      }
      if (isNetworkError(msg)) {
        addLog(accountId, 'products', `Detail deferNet(${phaseLabel}): ${productId} ${msg}`, 'info');
        return 'deferNet';
      }
      if (isCookieExpiredError(msg)) {
        addLog(accountId, 'products', `Detail deferCookie(${phaseLabel}): ${productId} ${msg}`, 'info');
        return 'deferCookie';
      }
      addLog(accountId, 'products', `Detail failed: ${productId} ${msg}`, 'error');
      detailDone += 1;
      logDetailProgress();
      return 'failed';
    }
  };

  const runDetailWorker = async () => {
    while (!listDone || detailQueue.length > 0) {
      ensureNotStopped(accountId);
      const productId = detailQueue.shift();
      if (!productId) {
        await sleepShort();
        continue;
      }
      const status = await processDetailItem(productId, 'main');
      if (status === 'defer429') {
        detailDeferred429.push(productId);
      } else if (status === 'deferNet') {
        detailDeferredNet.push(productId);
      } else if (status === 'deferCookie') {
        detailDeferredCookie.push(productId);
      }
      await detailPaceSleep();
    }
  };
  const detailWorkers = Array.from({ length: DETAIL_WORKERS }, () => runDetailWorker());
  if (!hasCheckpoint) {
    db.prepare('UPDATE products SET exists_in_latest = 0 WHERE account_id = ?').run(accountId);
  }
  let fetchAttempt = 0;
  try {
    while (true) {
      ensureNotStopped(accountId);
      try {
        await fetchAllProducts(
          acc.cookie_json,
          (m) => {
            ensureNotStopped(accountId);
            addLog(accountId, 'products', m);
          },
          (pageProducts, meta) => {
            ensureNotStopped(accountId);
            expectedTotal = Number(meta?.totalProducts || expectedTotal || 0);
            resumeCursor = String(meta?.nextCursor || '');
            resumePage = Number(meta?.page || resumePage || 0);
            const t = now();
            for (const p of pageProducts) {
              const existed = latestIds.has(p.product_id);
              latestIds.add(p.product_id);
              if (!existed) fetchedTotal += 1;
              upsertBasic.run(
                accountId,
                p.product_id,
                p.name,
                p.image,
                p.price,
                p.stock,
                p.days_to_ship,
                p.status,
                p.is_pre_order ? 1 : 0,
                '{}',
                t,
              );
              if (p.product_id && !detailQueued.has(p.product_id)) {
                detailQueued.add(p.product_id);
                detailQueue.push(p.product_id);
              }
            }
            addLog(accountId, 'products', `Saved page ${meta.page}/${meta.totalPages || '?'} to DB. current=${meta.fetchedCount}`);
            if (taskId) {
              updateTaskPayload(taskId, {
                list_initialized: true,
                resume_cursor: resumeCursor,
                resume_page: resumePage,
                fetched_count: fetchedTotal,
                expected_total: expectedTotal,
              });
            }
          },
          {
            startCursor: resumeCursor,
            startPage: resumePage,
            knownTotal: expectedTotal,
            fetchedCount: fetchedTotal,
          },
        );
        break;
      } catch (e) {
        const msg = e?.message || String(e);
        if (!isRetriableError(msg)) {
          addLog(accountId, 'products', `Fetch failed: ${msg}`, 'error');
          throw e;
        }
        if (isRateLimitError(msg)) {
          fetchAttempt += 1;
          addLog(accountId, 'products', `Fetch failed (429): ${msg}`, 'error');
          addLog(
            accountId,
            'products',
            `Rate limit cooldown: wait ${Math.floor(FETCH_RESUME_INTERVAL_MS / 1000)}s then retry`,
            'info',
          );
          await sleepWithStop(FETCH_RESUME_INTERVAL_MS);
          continue;
        }
        if (isNetworkError(msg)) {
          addLog(accountId, 'products', `Fetch failed (network): ${msg}`, 'error');
          await waitForNetworkRecovery(accountId, 'products', acc.cookie_json);
          addLog(accountId, 'products', 'Retry fetch immediately after network recovery', 'info');
          continue;
        }
        if (isCookieExpiredError(msg)) {
          addLog(accountId, 'products', `Fetch failed (cookie): ${msg}`, 'error');
          acc.cookie_json = await waitForCookieRecovery(accountId, 'products');
          addLog(accountId, 'products', 'Retry fetch immediately after cookie recovery', 'info');
          continue;
        }
        fetchAttempt += 1;
        addLog(accountId, 'products', `Fetch failed (retriable): ${msg}`, 'error');
        addLog(
          accountId,
          'products',
          `Auto resume ${fetchAttempt}: wait ${Math.floor(FETCH_RESUME_INTERVAL_MS / 1000)}s then retry fetch list`,
          'info',
        );
        await sleepWithStop(FETCH_RESUME_INTERVAL_MS);
      }
    }
  } finally {
    listDone = true;
  }

  const staleCountRow = db.prepare('SELECT COUNT(1) AS c FROM products WHERE account_id = ? AND exists_in_latest = 0').get(accountId);
  const staleCount = Number(staleCountRow?.c || 0);
  if (staleCount > 0) {
    db.prepare('DELETE FROM products WHERE account_id = ? AND exists_in_latest = 0').run(accountId);
    addLog(accountId, 'products', `Removed stale products: ${staleCount}`, 'success');
  }

  addLog(accountId, 'products', `List phase finished. total=${fetchedTotal}`, 'success');
  await Promise.all(detailWorkers);
  while (detailDeferred429.length > 0 || detailDeferredNet.length > 0 || detailDeferredCookie.length > 0) {
    ensureNotStopped(accountId);
    if (detailDeferredCookie.length > 0) {
      const pendingCookie = detailDeferredCookie.length;
      addLog(accountId, 'products', `Detail deferred-cookie round: pending=${pendingCookie}`, 'info');
      acc.cookie_json = await waitForCookieRecovery(accountId, 'products');
      const roundCookie = detailDeferredCookie.splice(0, detailDeferredCookie.length);
      for (const pid of roundCookie) {
        ensureNotStopped(accountId);
        const status = await processDetailItem(pid, 'deferred-cookie');
        if (status === 'defer429') detailDeferred429.push(pid);
        else if (status === 'deferNet') detailDeferredNet.push(pid);
        else if (status === 'deferCookie') detailDeferredCookie.push(pid);
        await detailPaceSleep();
      }
      continue;
    }
    if (detailDeferredNet.length > 0) {
      const pendingNet = detailDeferredNet.length;
      addLog(accountId, 'products', `Detail deferred-net round: pending=${pendingNet}`, 'info');
      await waitForNetworkRecovery(accountId, 'products', acc.cookie_json);
      const roundNet = detailDeferredNet.splice(0, detailDeferredNet.length);
      for (const pid of roundNet) {
        ensureNotStopped(accountId);
        const status = await processDetailItem(pid, 'deferred-net');
        if (status === 'defer429') detailDeferred429.push(pid);
        else if (status === 'deferNet') detailDeferredNet.push(pid);
        else if (status === 'deferCookie') detailDeferredCookie.push(pid);
        await detailPaceSleep();
      }
      continue;
    }
    if (detailDeferred429.length === 0) continue;
    const pending429 = detailDeferred429.length;
    addLog(accountId, 'products', `Detail deferred-429 round: pending=${pending429}, wait 30s`, 'info');
    await sleepWithStop(30000);
    const round429 = detailDeferred429.splice(0, detailDeferred429.length);
    for (const pid of round429) {
      ensureNotStopped(accountId);
      const status = await processDetailItem(pid, 'deferred-429');
      if (status === 'defer429') detailDeferred429.push(pid);
      else if (status === 'deferNet') detailDeferredNet.push(pid);
      else if (status === 'deferCookie') detailDeferredCookie.push(pid);
      await detailPaceSleep();
    }
  }
  addLog(accountId, 'products', `Progress detail: ${detailDone}/${Math.max(expectedTotal, fetchedTotal, detailDone)} success=${detailOk} percent=100`);
  addLog(accountId, 'products', `Detail phase finished. success=${detailOk}, total=${Math.max(expectedTotal, fetchedTotal, detailDone)}`, 'success');
  addLog(accountId, 'products', `Fetch finished. total=${fetchedTotal}`, 'success');
  if (taskId) {
    updateTaskPayload(taskId, {
      list_initialized: true,
      resume_cursor: '',
      resume_page: resumePage,
      fetched_count: fetchedTotal,
      expected_total: expectedTotal,
      fetch_done: true,
    });
  }
  return true;
}

function sleepShort() {
  return new Promise((resolve) => setTimeout(resolve, 120));
}

async function withRetry(fn, maxAttempts, onRetry) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= maxAttempts) break;
      onRetry?.(attempt, e);
      await sleepBackoff(attempt);
    }
  }
  throw lastErr;
}

function sleepBackoff(attempt) {
  const base = 180;
  const jitter = Math.floor(Math.random() * 140);
  return new Promise((resolve) => setTimeout(resolve, base * attempt + jitter));
}

function detailPaceSleep() {
  const ms = 120 + Math.floor(Math.random() * 180);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHm(hm) {
  const m = String(hm || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`Invalid time format: ${hm}`);
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) throw new Error(`Invalid time value: ${hm}`);
  return { h, m: mm };
}

function calcNextRunAt(rule, fromTs) {
  const from = new Date((Number(fromTs) || now()) * 1000);
  if (rule.rule_type === 'daily') {
    const { h, m } = parseHm(rule.daily_time);
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }
  if (rule.rule_type === 'weekly') {
    const wd = Number(rule.weekly_day);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new Error(`Invalid weekly_day: ${rule.weekly_day}`);
    const { h, m } = parseHm(rule.weekly_time);
    const d = new Date(from);
    d.setSeconds(0, 0);
    const cur = d.getDay();
    let delta = wd - cur;
    if (delta < 0) delta += 7;
    d.setDate(d.getDate() + delta);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 7);
    return Math.floor(d.getTime() / 1000);
  }
  throw new Error(`Unknown rule_type: ${rule.rule_type}`);
}

function normalizeRuleInput(input) {
  const ruleType = String(input?.rule_type || '').trim();
  const days = Number(input?.days_to_ship);
  if (!Number.isInteger(days) || days < 0 || days > 30) throw new Error('days_to_ship must be 0-30');
  if (ruleType !== 'daily' && ruleType !== 'weekly') throw new Error('rule_type must be daily or weekly');
  if (ruleType === 'daily') {
    parseHm(input?.daily_time);
    return {
      rule_type: 'daily',
      daily_time: String(input.daily_time),
      weekly_day: null,
      weekly_time: null,
      days_to_ship: days,
    };
  }
  parseHm(input?.weekly_time);
  const wd = Number(input?.weekly_day);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new Error('weekly_day must be 0..6');
  return {
    rule_type: 'weekly',
    daily_time: null,
    weekly_day: wd,
    weekly_time: String(input.weekly_time),
    days_to_ship: days,
  };
}

function fetchScheduleTasks(accountId) {
  const tasks = db.prepare('SELECT * FROM schedule_tasks WHERE account_id = ? ORDER BY id DESC').all(accountId);
  const ruleStmt = db.prepare('SELECT * FROM schedule_rules WHERE task_id = ? ORDER BY id DESC');
  const countStmt = db.prepare('SELECT COUNT(1) AS c FROM schedule_task_products WHERE task_id = ?');
  const listStmt = db.prepare(`
    SELECT p.product_id, p.name, p.days_to_ship
    FROM schedule_task_products sp
    JOIN products p ON p.product_id = sp.product_id AND p.account_id = ?
    WHERE sp.task_id = ?
    ORDER BY p.product_id DESC
  `);
  return tasks.map((t) => ({
    ...t,
    is_active: Number(t.is_active || 0),
    run_total: Number(t.run_total || 0),
    run_done: Number(t.run_done || 0),
    run_success: Number(t.run_success || 0),
    run_fail: Number(t.run_fail || 0),
    run_skip: Number(t.run_skip || 0),
    product_count: Number(countStmt.get(t.id)?.c || 0),
    rules: ruleStmt.all(t.id),
    products: listStmt.all(accountId, t.id),
  }));
}

async function executeDetailPhase(accountId, cookieJson, onlyPending = false) {
  ensureNotStopped(accountId);
  const sql = onlyPending
    ? "SELECT product_id, name FROM products WHERE account_id = ? AND exists_in_latest = 1 AND (detail_json IS NULL OR detail_json = '' OR detail_json = '{}') ORDER BY product_id DESC"
    : 'SELECT product_id, name FROM products WHERE account_id = ? AND exists_in_latest = 1 ORDER BY product_id DESC';
  const latestList = db.prepare(sql).all(accountId);
  addLog(accountId, 'products', `Start detail phase. total=${latestList.length}${onlyPending ? ' (pending only)' : ''}`);
  const updateDetail = db.prepare('UPDATE products SET detail_json = ?, fetched_at = ?, days_to_ship = ?, is_pre_order = ? WHERE account_id = ? AND product_id = ?');
  const sleepWithStop = async (ms) => {
    let left = ms;
    while (left > 0) {
      ensureNotStopped(accountId);
      const chunk = Math.min(1000, left);
      await new Promise((r) => setTimeout(r, chunk));
      left -= chunk;
    }
  };
  let detailOk = 0;
  let detailDone = 0;
  let perfApiMs = 0;
  let perfDbMs = 0;
  let perfTotalMs = 0;
  const detailDeferred429 = [];
  const detailDeferredNet = [];
  const queue = latestList.map((x) => x.product_id);
  const logDetailProgress = () => {
    const percent = latestList.length > 0 ? Math.floor((detailDone / latestList.length) * 100) : 100;
    addLog(accountId, 'products', `Progress detail: ${detailDone}/${latestList.length} success=${detailOk} percent=${percent}`);
    if (detailDone > 0 && detailDone % 20 === 0) {
      const denom = Math.max(detailOk, 1);
      addLog(
        accountId,
        'products',
        `Detail perf summary done=${detailDone} ok=${detailOk} avg_api=${Math.round(perfApiMs / denom)}ms avg_db=${Math.round(perfDbMs / denom)}ms avg_total=${Math.round(perfTotalMs / denom)}ms`,
      );
    }
  };

  const processDetailItem = async (productId, phaseLabel = 'main') => {
    const tStart = Date.now();
    try {
      const tApiStart = Date.now();
      const detail = await withRetry(
        () => getProductInfo(cookieJson, productId, false),
        DETAIL_RETRY,
        (attempt, err) => addLog(accountId, 'products', `Detail retry ${attempt}/${DETAIL_RETRY}: ${productId} ${err?.message || err}`, 'error'),
      );
      const apiMs = Date.now() - tApiStart;
      const dts = Number(detail?.pre_order_info?.days_to_ship ?? 0);
      const isPre = detail?.pre_order_info?.pre_order ? 1 : 0;
      const tDbStart = Date.now();
      updateDetail.run(JSON.stringify(detail || {}), now(), dts, isPre, accountId, productId);
      const dbMs = Date.now() - tDbStart;
      const totalMs = Date.now() - tStart;
      perfApiMs += apiMs;
      perfDbMs += dbMs;
      perfTotalMs += totalMs;
      detailOk += 1;
      detailDone += 1;
      addLog(accountId, 'products', `Detail perf item=${productId} api=${apiMs}ms db=${dbMs}ms total=${totalMs}ms phase=${phaseLabel}`);
      logDetailProgress();
      return 'done';
    } catch (e) {
      const msg = String(e?.message || e || '');
      if (isRateLimitError(msg)) {
        addLog(accountId, 'products', `Detail defer429(${phaseLabel}): ${productId} ${msg}`, 'info');
        return 'defer429';
      }
      if (isNetworkError(msg)) {
        addLog(accountId, 'products', `Detail deferNet(${phaseLabel}): ${productId} ${msg}`, 'info');
        return 'deferNet';
      }
      if (isCookieExpiredError(msg)) {
        addLog(accountId, 'products', `Detail deferCookie(${phaseLabel}): ${productId} ${msg}`, 'info');
        return 'deferCookie';
      }
      addLog(accountId, 'products', `Detail failed: ${productId} ${msg}`, 'error');
      detailDone += 1;
      logDetailProgress();
      return 'failed';
    }
  };

  const worker = async () => {
    while (queue.length > 0) {
      ensureNotStopped(accountId);
      const productId = queue.shift();
      if (!productId) break;
      const status = await processDetailItem(productId, 'main');
      if (status === 'defer429') {
        detailDeferred429.push(productId);
      } else if (status === 'deferNet') {
        detailDeferredNet.push(productId);
      } else if (status === 'deferCookie') {
        detailDeferredCookie.push(productId);
      }
      await detailPaceSleep();
    }
  };
  await Promise.all(Array.from({ length: DETAIL_WORKERS }, () => worker()));
  while (detailDeferred429.length > 0 || detailDeferredNet.length > 0 || detailDeferredCookie.length > 0) {
    ensureNotStopped(accountId);
    if (detailDeferredCookie.length > 0) {
      const pendingCookie = detailDeferredCookie.length;
      addLog(accountId, 'products', `Detail deferred-cookie round: pending=${pendingCookie}`, 'info');
      cookieJson = await waitForCookieRecovery(accountId, 'products');
      const roundCookie = detailDeferredCookie.splice(0, detailDeferredCookie.length);
      for (const pid of roundCookie) {
        ensureNotStopped(accountId);
        const status = await processDetailItem(pid, 'deferred-cookie');
        if (status === 'defer429') detailDeferred429.push(pid);
        else if (status === 'deferNet') detailDeferredNet.push(pid);
        else if (status === 'deferCookie') detailDeferredCookie.push(pid);
        await detailPaceSleep();
      }
      continue;
    }
    if (detailDeferredNet.length > 0) {
      const pendingNet = detailDeferredNet.length;
      addLog(accountId, 'products', `Detail deferred-net round: pending=${pendingNet}`, 'info');
      await waitForNetworkRecovery(accountId, 'products', cookieJson);
      const roundNet = detailDeferredNet.splice(0, detailDeferredNet.length);
      for (const pid of roundNet) {
        ensureNotStopped(accountId);
        const status = await processDetailItem(pid, 'deferred-net');
        if (status === 'defer429') detailDeferred429.push(pid);
        else if (status === 'deferNet') detailDeferredNet.push(pid);
        else if (status === 'deferCookie') detailDeferredCookie.push(pid);
        await detailPaceSleep();
      }
      continue;
    }
    if (detailDeferred429.length === 0) continue;
    const pending429 = detailDeferred429.length;
    addLog(accountId, 'products', `Detail deferred-429 round: pending=${pending429}, wait 30s`, 'info');
    await sleepWithStop(30000);
    const round429 = detailDeferred429.splice(0, detailDeferred429.length);
    for (const pid of round429) {
      ensureNotStopped(accountId);
      const status = await processDetailItem(pid, 'deferred-429');
      if (status === 'defer429') detailDeferred429.push(pid);
      else if (status === 'deferNet') detailDeferredNet.push(pid);
      else if (status === 'deferCookie') detailDeferredCookie.push(pid);
      await detailPaceSleep();
    }
  }
  addLog(accountId, 'products', `Detail phase finished. success=${detailOk}, total=${latestList.length}`, 'success');
}

async function executeBatchChange(accountId, days, selectedProductIds = null, opts = {}) {
  ensureNotStopped(accountId);
  if (days < 0 || days > 30) throw new Error('days must be between 0 and 30');
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) throw new Error('Account not found');
  let list = [];
  if (Array.isArray(selectedProductIds)) {
    const ids = [...new Set(selectedProductIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
    if (ids.length === 0) throw new Error('No product selected for change');
    const placeholders = ids.map(() => '?').join(',');
    list = db.prepare(`SELECT * FROM products WHERE account_id = ? AND in_change_list = 1 AND product_id IN (${placeholders})`).all(accountId, ...ids);
  } else {
    list = db.prepare('SELECT * FROM products WHERE account_id = ? AND in_change_list = 1').all(accountId);
  }
  if (list.length === 0) throw new Error('No product in change list');
  const logTab = String(opts?.logTab || 'change');
  const logPrefix = String(opts?.logPrefix || '');
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  const onLog = typeof opts?.onLog === 'function' ? opts.onLog : null;
  const emitLog = (message, type = 'info') => {
    const msg = logPrefix ? `${logPrefix}${message}` : message;
    addLog(accountId, logTab, msg, type);
    if (onLog) onLog(msg, type);
  };
  let ok = 0; let fail = 0; let skip = 0; let done = 0;
  const deferred429 = [];
  const deferredNet = [];
  const deferredCookie = [];
  emitLog(`Batch start. total=${list.length}, days=${days}`);
  const startedAt = Date.now();
  const queue = [...list];
  const sleepWithStop = async (ms) => {
    let left = ms;
    while (left > 0) {
      ensureNotStopped(accountId);
      const chunk = Math.min(1000, left);
      await new Promise((r) => setTimeout(r, chunk));
      left -= chunk;
    }
  };
  const updateProgressLog = () => {
    const percent = Math.floor((done / list.length) * 100);
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    const speed = done / elapsedSec;
    const etaSec = speed > 0 ? Math.round((list.length - done) / speed) : 0;
    emitLog(`Progress change: ${done}/${list.length} success=${ok} fail=${fail} skip=${skip} percent=${percent} speed=${speed.toFixed(2)} eta=${etaSec}s`);
    if (onProgress) onProgress({ done, total: list.length, ok, fail, skip, percent });
  };
  const processOneItem = async (p, phaseLabel) => {
    emitLog(`Item start(${phaseLabel}): ${p.product_id} ${p.name}`);
    let err = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        emitLog(`Item ${p.product_id} attempt ${attempt}/3: get_product_info`);
        const info = await getProductInfo(acc.cookie_json, p.product_id, false);
        const currentDays = Number(info?.pre_order_info?.days_to_ship ?? 0);
        if (currentDays === days) {
          skip += 1;
          db.prepare('UPDATE products SET days_to_ship = ?, is_pre_order = ? WHERE account_id = ? AND product_id = ?')
            .run(currentDays, currentDays > 0 ? 1 : 0, accountId, p.product_id);
          emitLog(`Skipped: ${p.product_id} ${p.name} days_to_ship unchanged (${currentDays})`, 'info');
          done += 1;
          updateProgressLog();
          return 'done';
        }

        emitLog(`Item ${p.product_id} attempt ${attempt}/3: update days ${currentDays} -> ${days}`);
        await randomSleep();
        await updateDaysToShip(acc.cookie_json, p.product_id, days, info);
        ok += 1;
        db.prepare('UPDATE products SET days_to_ship = ?, is_pre_order = ? WHERE account_id = ? AND product_id = ?')
          .run(days, days > 0 ? 1 : 0, accountId, p.product_id);
        emitLog(`Success: ${p.product_id} ${p.name} ${currentDays} -> ${days}`, 'success');
        done += 1;
        updateProgressLog();
        return 'done';
      } catch (e) {
        err = e;
        const msg = String(e?.message || e || '');
        emitLog(`Item ${p.product_id} attempt ${attempt}/3 failed: ${msg}`, 'error');
        if (isRateLimitError(msg)) {
          const waitSec = attempt * 2;
          emitLog(`Rate limited (429). wait ${waitSec}s then retry`, 'info');
          await sleepWithStop(waitSec * 1000);
        } else if (isNetworkError(msg)) {
          emitLog(`Network error on item, defer to network queue`, 'info');
          break;
        } else if (isCookieExpiredError(msg)) {
          emitLog(`Cookie error on item, defer to cookie queue`, 'info');
          break;
        } else {
          if (attempt < 3) await randomSleep();
        }
      }
    }

    if (isRateLimitError(String(err?.message || err || ''))) {
      emitLog(`Defer 429 item to tail queue: ${p.product_id} ${p.name}`, 'info');
      return 'defer429';
    }
    if (isNetworkError(String(err?.message || err || ''))) {
      emitLog(`Defer network item to tail queue: ${p.product_id} ${p.name}`, 'info');
      return 'deferNet';
    }
    if (isCookieExpiredError(String(err?.message || err || ''))) {
      emitLog(`Defer cookie item to tail queue: ${p.product_id} ${p.name}`, 'info');
      return 'deferCookie';
    }

    fail += 1;
    done += 1;
    emitLog(`Failed: ${p.product_id} ${p.name} ${err?.message || err}`, 'error');
    updateProgressLog();
    return 'failed';
  };
  const worker = async () => {
    while (queue.length > 0) {
      ensureNotStopped(accountId);
      const p = queue.shift();
      if (!p) break;
      const status = await processOneItem(p, 'main');
      if (status === 'defer429') deferred429.push(p);
      if (status === 'deferNet') deferredNet.push(p);
      if (status === 'deferCookie') deferredCookie.push(p);
      await randomSleep();
    }
  };
  await Promise.all(Array.from({ length: CHANGE_WORKERS }, () => worker()));
  if (deferred429.length > 0 || deferredNet.length > 0 || deferredCookie.length > 0) {
    emitLog(`Enter deferred phase: pending429=${deferred429.length} pendingNet=${deferredNet.length} pendingCookie=${deferredCookie.length}`, 'info');
  }
  while (deferred429.length > 0 || deferredNet.length > 0 || deferredCookie.length > 0) {
    ensureNotStopped(accountId);
    if (deferredCookie.length > 0) {
      emitLog(`Deferred-cookie round start: pending=${deferredCookie.length}`, 'info');
      acc.cookie_json = await waitForCookieRecovery(accountId, logTab);
      const roundCookie = deferredCookie.splice(0, deferredCookie.length);
      for (const p of roundCookie) {
        ensureNotStopped(accountId);
        const status = await processOneItem(p, 'deferredCookie');
        if (status === 'defer429') deferred429.push(p);
        if (status === 'deferNet') deferredNet.push(p);
        if (status === 'deferCookie') deferredCookie.push(p);
        await randomSleep();
      }
      continue;
    }
    if (deferredNet.length > 0) {
      emitLog(`Deferred-net round start: pending=${deferredNet.length}`, 'info');
      await waitForNetworkRecovery(accountId, 'change', acc.cookie_json);
      const roundNet = deferredNet.splice(0, deferredNet.length);
      for (const p of roundNet) {
        ensureNotStopped(accountId);
        const status = await processOneItem(p, 'deferredNet');
        if (status === 'defer429') deferred429.push(p);
        if (status === 'deferNet') deferredNet.push(p);
        if (status === 'deferCookie') deferredCookie.push(p);
        await randomSleep();
      }
      continue;
    }
    if (deferred429.length > 0) {
      emitLog(`Deferred-429 round start: pending=${deferred429.length}. wait 30s`, 'info');
      await sleepWithStop(30000);
      const round429 = deferred429.splice(0, deferred429.length);
      for (const p of round429) {
        ensureNotStopped(accountId);
        const status = await processOneItem(p, 'deferred429');
        if (status === 'defer429') deferred429.push(p);
        if (status === 'deferNet') deferredNet.push(p);
        if (status === 'deferCookie') deferredCookie.push(p);
        await randomSleep();
      }
    }
  }
  emitLog(`Batch finished. success=${ok}, skipped=${skip}, failed=${fail}`, 'success');
  return { ok, fail, skip };
}

async function runScheduleRule(task, rule) {
  const accountId = Number(task.account_id);
  const ruleId = Number(rule.id);
  const key = `${ruleId}`;
  if (activeScheduleRuns.has(key)) return;
  activeScheduleRuns.add(key);
  const runGroupId = now();
  try {
    const ids = db.prepare('SELECT product_id FROM schedule_task_products WHERE task_id = ?').all(task.id).map((x) => Number(x.product_id));
    if (!ids.length) {
      db.prepare('UPDATE schedule_tasks SET last_run_at = ?, last_result = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(now(), 'skipped', 'no products in schedule task', now(), task.id);
      addScheduleTaskLog(task.id, `Skip run: no products (rule=${rule.id})`, 'info', runGroupId);
      return;
    }
    db.prepare('UPDATE schedule_tasks SET run_status = ?, run_total = ?, run_done = 0, run_success = 0, run_fail = 0, run_skip = 0, run_started_at = ?, run_updated_at = ? WHERE id = ?')
      .run('running', ids.length, now(), now(), task.id);
    addScheduleTaskLog(task.id, `Schedule run start: rule=${rule.id} products=${ids.length} days=${rule.days_to_ship}`, 'info', runGroupId);
    await runExclusive(accountId, async () => {
      await runTaskWithRecord(accountId, 'schedule_run', { taskId: task.id, ruleId: rule.id, days: rule.days_to_ship, selectedProductIds: ids }, async () => {
        addLog(accountId, 'change', `Schedule run start: task=${task.name} rule=${rule.id} products=${ids.length} days=${rule.days_to_ship}`, 'info');
        const ret = await executeBatchChange(accountId, Number(rule.days_to_ship), ids, {
          logTab: 'change',
          logPrefix: `[CRON ${task.id}] `,
          onLog: (m, type) => addScheduleTaskLog(task.id, m, type, runGroupId),
          onProgress: (p) => {
            db.prepare('UPDATE schedule_tasks SET run_status = ?, run_total = ?, run_done = ?, run_success = ?, run_fail = ?, run_skip = ?, run_updated_at = ? WHERE id = ?')
              .run('running', p.total, p.done, p.ok, p.fail, p.skip, now(), task.id);
          },
        });
        db.prepare('UPDATE schedule_tasks SET last_run_at = ?, last_result = ?, last_error = NULL, updated_at = ? WHERE id = ?')
          .run(now(), `ok:${ret.ok}/skip:${ret.skip}/fail:${ret.fail}`, now(), task.id);
        db.prepare('UPDATE schedule_tasks SET run_status = ?, run_updated_at = ? WHERE id = ?').run('idle', now(), task.id);
        addScheduleTaskLog(task.id, `Schedule run finished: ok=${ret.ok} skip=${ret.skip} fail=${ret.fail}`, 'success', runGroupId);
        addLog(accountId, 'change', `Schedule run finished: task=${task.name} rule=${rule.id}`, 'success');
      });
    });
  } catch (e) {
    db.prepare('UPDATE schedule_tasks SET last_run_at = ?, last_result = ?, last_error = ?, updated_at = ? WHERE id = ?')
      .run(now(), 'failed', String(e?.message || e || ''), now(), task.id);
    db.prepare('UPDATE schedule_tasks SET run_status = ?, run_updated_at = ? WHERE id = ?').run('failed', now(), task.id);
    addScheduleTaskLog(task.id, `Schedule run failed: ${e?.message || e}`, 'error', runGroupId);
    addLog(accountId, 'change', `Schedule run failed: task=${task.name} rule=${rule.id} ${e?.message || e}`, 'error');
  } finally {
    activeScheduleRuns.delete(key);
  }
}

async function tickSchedules() {
  const ts = now();
  const rows = db.prepare(`
    SELECT r.*, t.account_id, t.name AS task_name, t.id AS task_id
    FROM schedule_rules r
    JOIN schedule_tasks t ON t.id = r.task_id
    WHERE t.is_active = 1
    ORDER BY r.next_run_at ASC, r.id ASC
  `).all();
  for (const r of rows) {
    let nextRunAt = Number(r.next_run_at || 0);
    if (!nextRunAt) {
      nextRunAt = calcNextRunAt(r, ts - 1);
      db.prepare('UPDATE schedule_rules SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextRunAt, ts, r.id);
    }
    if (nextRunAt > ts) continue;
    let nextAfter = calcNextRunAt(r, nextRunAt + 1);
    let missed = 0;
    while (ts >= nextAfter) {
      missed += 1;
      nextRunAt = nextAfter;
      nextAfter = calcNextRunAt(r, nextRunAt + 1);
    }
    if (missed > 0) {
      db.prepare('UPDATE schedule_rules SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextAfter, ts, r.id);
      addScheduleTaskLog(r.task_id, `Schedule missed ${missed} slot(s): rule=${r.id}`, 'info', ts);
      addLog(Number(r.account_id), 'change', `Schedule missed ${missed} slot(s): task=${r.task_name} rule=${r.id}`, 'info');
      continue;
    }
    if (running.has(Number(r.account_id))) {
      // 賬戶有其他任務在跑：先等待，不前推 next_run_at
      continue;
    }
    db.prepare('UPDATE schedule_rules SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextAfter, ts, r.id);
    await runScheduleRule({ id: r.task_id, account_id: r.account_id, name: r.task_name }, r);
  }
}

function startScheduleTimer() {
  if (scheduleTimer) return;
  scheduleTimer = setInterval(() => {
    tickSchedules().catch(() => {});
  }, 1000);
}

async function runTaskWithRecord(accountId, taskType, payload, runner) {
  const taskId = createTask(accountId, taskType, payload);
  try {
    const ret = await runner(taskId);
    markTaskDone(taskId);
    return ret;
  } catch (e) {
    markTaskFailed(taskId, e);
    throw e;
  }
}

function resumeInterruptedTasks() {
  const RETRY_WINDOW_SEC = 24 * 60 * 60;
  const nowSec = now();

  const tasks = db.prepare(
    "SELECT * FROM task_queue WHERE status = 'running' OR status = 'failed' ORDER BY id ASC",
  ).all().filter((t) => {
    if (t.status === 'running') return true;
    const updatedAt = Number(t.updated_at || 0);
    if (updatedAt <= 0 || nowSec - updatedAt > RETRY_WINDOW_SEC) return false;
    return isRetriableError(t.last_error);
  });
  if (!tasks.length) return;
  for (const t of tasks) {
    const accountId = Number(t.account_id);
    let payload = {};
    try { payload = JSON.parse(t.payload_json || '{}'); } catch {}
    const resumeSource = t.status === 'running' ? 'interrupted' : 'retriable-failed';
    if (t.task_type === 'products_fetch') {
      addLog(accountId, 'products', `Resuming ${resumeSource} task #${t.id}: products_fetch`, 'info');
      runExclusive(accountId, async () => {
        try {
          db.prepare("UPDATE task_queue SET status = 'running', updated_at = ? WHERE id = ?").run(now(), t.id);
          const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
          if (!acc) throw new Error('Account not found');
          const latestCount = Number(db.prepare('SELECT COUNT(1) AS c FROM products WHERE account_id = ? AND exists_in_latest = 1').get(accountId)?.c || 0);
          const pendingCount = Number(db.prepare("SELECT COUNT(1) AS c FROM products WHERE account_id = ? AND exists_in_latest = 1 AND (detail_json IS NULL OR detail_json = '' OR detail_json = '{}')").get(accountId)?.c || 0);
          const listFinished = hasListPhaseFinishedForTask(accountId, t);
          if (listFinished && latestCount > 0 && pendingCount > 0) {
            addLog(accountId, 'products', `Resume strategy: continue detail phase only. pending=${pendingCount}/${latestCount}`, 'info');
            await executeDetailPhase(accountId, acc.cookie_json, true);
          } else {
            if (!listFinished) {
              addLog(accountId, 'products', 'Resume strategy: list phase was not finished, rerun full fetch flow', 'info');
            } else {
              addLog(accountId, 'products', 'Resume strategy: rerun full fetch flow', 'info');
            }
            await executeFetchProducts(accountId, Number(t.id), payload);
          }
          markTaskDone(t.id);
        } catch (e) {
          markTaskFailed(t.id, e);
          addLog(accountId, 'products', `Resume failed: ${e?.message || e}`, 'error');
        }
      }).catch(() => {});
    } else if (t.task_type === 'change_batch') {
      const days = Number(payload?.days);
      addLog(accountId, 'change', `Resuming ${resumeSource} task #${t.id}: change_batch days=${days}`, 'info');
      runExclusive(accountId, async () => {
        try {
          db.prepare("UPDATE task_queue SET status = 'running', updated_at = ? WHERE id = ?").run(now(), t.id);
          await executeBatchChange(accountId, days, payload?.selectedProductIds || null);
          markTaskDone(t.id);
        } catch (e) {
          markTaskFailed(t.id, e);
          addLog(accountId, 'change', `Resume failed: ${e?.message || e}`, 'error');
        }
      }).catch(() => {});
    } else {
      markTaskFailed(t.id, new Error(`Unknown task type: ${t.task_type}`));
    }
  }
}

export function initHandlers() {
  ipcMain.handle('ui:confirm', async (e, opts = {}) => {
    const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow() || undefined;
    const ret = await dialog.showMessageBox(win, {
      type: opts?.type || 'question',
      title: opts?.title || '確認',
      message: String(opts?.message || ''),
      detail: String(opts?.detail || ''),
      buttons: Array.isArray(opts?.buttons) && opts.buttons.length ? opts.buttons : ['確定', '取消'],
      defaultId: Number.isFinite(opts?.defaultId) ? Number(opts.defaultId) : 0,
      cancelId: Number.isFinite(opts?.cancelId) ? Number(opts.cancelId) : 1,
    });
    return { confirmed: ret.response === 0, response: ret.response };
  });

  ipcMain.handle('accounts:get', () => db.prepare('SELECT * FROM accounts ORDER BY id DESC').all());

  ipcMain.handle('accounts:add', async (_e, shopId, cookieJson) => {
    const info = await getShopInfo(cookieJson);
    if (Number(info.shop_id) !== Number(shopId)) throw new Error(`shop_id mismatch: input=${shopId}, actual=${info.shop_id}`);
    const t = now();
    const ret = db.prepare('INSERT OR REPLACE INTO accounts (shop_id, shop_name, cookie_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(shopId, info.name, cookieJson, t, t);
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(ret.lastInsertRowid);
  });

  ipcMain.handle('accounts:update-cookie', async (_e, id, cookieJson) => {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!acc) throw new Error('Account not found');
    const info = await getShopInfo(cookieJson);
    if (Number(info.shop_id) !== Number(acc.shop_id)) throw new Error('shop_id mismatch');
    db.prepare('UPDATE accounts SET cookie_json = ?, shop_name = ?, updated_at = ? WHERE id = ?')
      .run(cookieJson, info.name, now(), id);
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  });

  ipcMain.handle('accounts:delete', (_e, id) => {
    db.prepare('DELETE FROM products WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM logs WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM task_queue WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle('accounts:validate', async (_e, id) => {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!acc) throw new Error('Account not found');
    const info = await getShopInfo(acc.cookie_json);
    if (Number(info.shop_id) !== Number(acc.shop_id)) throw new Error('Cookie invalid for current shop');
    return acc;
  });

  ipcMain.handle('products:fetch', (_e, accountId) => runExclusive(accountId, async () => (
    runTaskWithRecord(accountId, 'products_fetch', { list_initialized: false, resume_cursor: '', resume_page: 0, fetched_count: 0, expected_total: 0, fetch_done: false }, async (taskId) => executeFetchProducts(accountId, taskId))
  )));

  ipcMain.handle('products:get', (_e, accountId) => db.prepare('SELECT * FROM products WHERE account_id = ? ORDER BY product_id DESC').all(accountId));
  ipcMain.handle('change-list:add', (_e, accountId, ids) => {
    const stmt = db.prepare('UPDATE products SET in_change_list = 1 WHERE account_id = ? AND product_id = ?');
    const tx = db.transaction((arr) => arr.forEach((id) => stmt.run(accountId, id)));
    tx(ids || []);
    return true;
  });
  ipcMain.handle('change-list:remove', (_e, accountId, ids) => {
    const stmt = db.prepare('UPDATE products SET in_change_list = 0 WHERE account_id = ? AND product_id = ?');
    const tx = db.transaction((arr) => arr.forEach((id) => stmt.run(accountId, id)));
    tx(ids || []);
    return true;
  });
  ipcMain.handle('change-list:get', (_e, accountId) => db.prepare('SELECT * FROM products WHERE account_id = ? AND in_change_list = 1 ORDER BY product_id DESC').all(accountId));

  ipcMain.handle('change:batch', (_e, accountId, days, selectedProductIds = null) => runExclusive(accountId, async () => (
    runTaskWithRecord(accountId, 'change_batch', { days, selectedProductIds: selectedProductIds || null }, async () => executeBatchChange(accountId, days, selectedProductIds))
  )));

  ipcMain.handle('schedule:tasks:get', (_e, accountId) => fetchScheduleTasks(accountId));
  ipcMain.handle('schedule:task:create', (_e, accountId, payload = {}) => {
    const name = String(payload?.name || '').trim();
    const note = String(payload?.note || '').trim();
    if (!name) throw new Error('Task name is required');
    const t = now();
    const id = db.prepare('INSERT INTO schedule_tasks (account_id, name, note, is_active, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(accountId, name, note, t, t).lastInsertRowid;
    return db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(id);
  });
  ipcMain.handle('schedule:task:update', (_e, taskId, payload = {}) => {
    const task = db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(taskId);
    if (!task) throw new Error('Task not found');
    const name = String(payload?.name ?? task.name).trim();
    const note = String(payload?.note ?? task.note).trim();
    if (!name) throw new Error('Task name is required');
    db.prepare('UPDATE schedule_tasks SET name = ?, note = ?, updated_at = ? WHERE id = ?').run(name, note, now(), taskId);
    return true;
  });
  ipcMain.handle('schedule:task:save-draft', (_e, taskId, payload = {}) => {
    const task = db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(taskId);
    if (!task) throw new Error('Task not found');
    const name = String(payload?.name ?? task.name).trim();
    const note = String(payload?.note ?? task.note).trim();
    if (!name) throw new Error('Task name is required');
    const productIds = [...new Set((payload?.products || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
    const rulesRaw = Array.isArray(payload?.rules) ? payload.rules : [];
    const t = now();

    const tx = db.transaction(() => {
      db.prepare('UPDATE schedule_tasks SET name = ?, note = ?, updated_at = ? WHERE id = ?').run(name, note, t, taskId);

      db.prepare('DELETE FROM schedule_task_products WHERE task_id = ?').run(taskId);
      if (productIds.length) {
        const insProduct = db.prepare('INSERT OR IGNORE INTO schedule_task_products (task_id, product_id, created_at) VALUES (?, ?, ?)');
        for (const pid of productIds) insProduct.run(taskId, pid, t);
      }

      const existingRules = db.prepare('SELECT * FROM schedule_rules WHERE task_id = ?').all(taskId);
      const existingMap = new Map(existingRules.map((r) => [Number(r.id), r]));
      const incomingIds = new Set();
      const insRule = db.prepare(`
        INSERT INTO schedule_rules (task_id, rule_type, daily_time, weekly_day, weekly_time, days_to_ship, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updRule = db.prepare(`
        UPDATE schedule_rules
        SET rule_type = ?, daily_time = ?, weekly_day = ?, weekly_time = ?, days_to_ship = ?, next_run_at = ?, updated_at = ?
        WHERE id = ? AND task_id = ?
      `);
      for (const raw of rulesRaw) {
        const incomingId = Number(raw?.id);
        const hasId = Number.isFinite(incomingId) && incomingId > 0 && existingMap.has(incomingId);
        const r = normalizeRuleInput(raw);
        const nextRunAt = calcNextRunAt(r, t - 1);
        if (hasId) {
          incomingIds.add(incomingId);
          updRule.run(r.rule_type, r.daily_time, r.weekly_day, r.weekly_time, r.days_to_ship, nextRunAt, t, incomingId, taskId);
        } else {
          insRule.run(taskId, r.rule_type, r.daily_time, r.weekly_day, r.weekly_time, r.days_to_ship, nextRunAt, t, t);
        }
      }
      const delRule = db.prepare('DELETE FROM schedule_rules WHERE id = ? AND task_id = ?');
      for (const old of existingRules) {
        const oldId = Number(old.id);
        if (!incomingIds.has(oldId)) {
          const stillExistsInPayload = rulesRaw.some((x) => Number(x?.id) === oldId);
          if (!stillExistsInPayload) delRule.run(oldId, taskId);
        }
      }
    });
    tx();
    return true;
  });
  ipcMain.handle('schedule:task:set-active', (_e, taskId, isActive) => {
    const task = db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(taskId);
    if (!task) throw new Error('Task not found');
    const active = Number(isActive ? 1 : 0);
    db.prepare('UPDATE schedule_tasks SET is_active = ?, updated_at = ? WHERE id = ?').run(active, now(), taskId);
    if (active === 1) {
      const rules = db.prepare('SELECT * FROM schedule_rules WHERE task_id = ?').all(taskId);
      for (const r of rules) {
        const nextRunAt = calcNextRunAt(r, now() - 1);
        db.prepare('UPDATE schedule_rules SET next_run_at = ?, updated_at = ? WHERE id = ?').run(nextRunAt, now(), r.id);
      }
    }
    return true;
  });
  ipcMain.handle('schedule:task:delete', (_e, taskId) => {
    db.prepare('DELETE FROM schedule_task_products WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM schedule_rules WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM schedule_tasks WHERE id = ?').run(taskId);
    return true;
  });
  ipcMain.handle('schedule:rule:create', (_e, taskId, input = {}) => {
    const task = db.prepare('SELECT * FROM schedule_tasks WHERE id = ?').get(taskId);
    if (!task) throw new Error('Task not found');
    const r = normalizeRuleInput(input);
    const t = now();
    const nextRunAt = calcNextRunAt(r, t - 1);
    const id = db.prepare(`
      INSERT INTO schedule_rules (task_id, rule_type, daily_time, weekly_day, weekly_time, days_to_ship, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, r.rule_type, r.daily_time, r.weekly_day, r.weekly_time, r.days_to_ship, nextRunAt, t, t).lastInsertRowid;
    return db.prepare('SELECT * FROM schedule_rules WHERE id = ?').get(id);
  });
  ipcMain.handle('schedule:rule:update', (_e, ruleId, input = {}) => {
    const old = db.prepare('SELECT * FROM schedule_rules WHERE id = ?').get(ruleId);
    if (!old) throw new Error('Rule not found');
    const merged = normalizeRuleInput({ ...old, ...input });
    const nextRunAt = calcNextRunAt(merged, now() - 1);
    db.prepare(`
      UPDATE schedule_rules
      SET rule_type = ?, daily_time = ?, weekly_day = ?, weekly_time = ?, days_to_ship = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `).run(merged.rule_type, merged.daily_time, merged.weekly_day, merged.weekly_time, merged.days_to_ship, nextRunAt, now(), ruleId);
    return true;
  });
  ipcMain.handle('schedule:rule:delete', (_e, ruleId) => {
    db.prepare('DELETE FROM schedule_rules WHERE id = ?').run(ruleId);
    return true;
  });
  ipcMain.handle('schedule:products:candidates', (_e, accountId, taskId) => {
    return db.prepare(`
      SELECT p.product_id, p.name, p.days_to_ship
      FROM products p
      WHERE p.account_id = ? AND p.in_change_list = 1
        AND p.product_id NOT IN (SELECT product_id FROM schedule_task_products WHERE task_id = ?)
      ORDER BY p.product_id DESC
    `).all(accountId, taskId);
  });
  ipcMain.handle('schedule:products:add', (_e, taskId, productIds = []) => {
    const ids = [...new Set((productIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
    if (!ids.length) return true;
    const stmt = db.prepare('INSERT OR IGNORE INTO schedule_task_products (task_id, product_id, created_at) VALUES (?, ?, ?)');
    const t = now();
    const tx = db.transaction((arr) => arr.forEach((pid) => stmt.run(taskId, pid, t)));
    tx(ids);
    return true;
  });
  ipcMain.handle('schedule:products:remove', (_e, taskId, productIds = []) => {
    const ids = [...new Set((productIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
    if (!ids.length) return true;
    const stmt = db.prepare('DELETE FROM schedule_task_products WHERE task_id = ? AND product_id = ?');
    const tx = db.transaction((arr) => arr.forEach((pid) => stmt.run(taskId, pid)));
    tx(ids);
    return true;
  });
  ipcMain.handle('schedule:task:logs:get', (_e, taskId, limit = 300, groupId = null) => {
    const n = Math.max(1, Math.min(1000, Number(limit) || 300));
    if (groupId) {
      return db.prepare('SELECT * FROM schedule_task_logs WHERE task_id = ? AND group_id = ? ORDER BY id DESC LIMIT ?').all(taskId, Number(groupId), n);
    }
    return db.prepare('SELECT * FROM schedule_task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, n);
  });
  ipcMain.handle('schedule:task:log-groups', (_e, taskId) => {
    return db.prepare(`
      SELECT
        g.group_id AS id,
        g.created_at,
        g.count,
        (
          SELECT l.message
          FROM schedule_task_logs l
          WHERE l.task_id = ? AND l.group_id = g.group_id
          ORDER BY l.id ASC
          LIMIT 1
        ) AS sample_message
      FROM (
        SELECT group_id, MAX(created_at) AS created_at, COUNT(1) AS count
        FROM schedule_task_logs
        WHERE task_id = ? AND group_id IS NOT NULL
        GROUP BY group_id
        ORDER BY group_id DESC
        LIMIT 100
      ) g
      ORDER BY g.group_id DESC
    `).all(taskId, taskId);
  });

  ipcMain.handle('logs:groups', (_e, accountId, tab) => {
    const taskType = tab === 'change' ? 'change_batch' : 'products_fetch';
    const rows = db.prepare('SELECT id, task_type, status, created_at, updated_at FROM task_queue WHERE account_id = ? AND task_type = ? ORDER BY id DESC LIMIT 50')
      .all(accountId, taskType);
    return rows.map((r) => ({
      id: Number(r.id),
      status: r.status,
      created_at: Number(r.created_at || 0),
      updated_at: Number(r.updated_at || 0),
    }));
  });
  ipcMain.handle('logs:get', (_e, accountId, tab, taskId = null) => {
    if (taskId) {
      const t = db.prepare('SELECT id, created_at, updated_at FROM task_queue WHERE id = ? AND account_id = ?').get(taskId, accountId);
      if (!t) return [];
      const startAt = Number(t.created_at || 0);
      const endAt = Number(t.updated_at || startAt) + 1;
      return db.prepare('SELECT * FROM logs WHERE account_id = ? AND tab = ? AND created_at >= ? AND created_at <= ? ORDER BY id DESC LIMIT 500')
        .all(accountId, tab, startAt, endAt);
    }
    return db.prepare('SELECT * FROM logs WHERE account_id = ? AND tab = ? ORDER BY id DESC LIMIT 200').all(accountId, tab);
  });
  ipcMain.handle('task:running', (_e, accountId) => running.has(accountId));
  ipcMain.handle('task:stop', (_e, accountId) => {
    if (!running.has(accountId)) return { stopped: false, message: 'No running task' };
    stopRequested.add(accountId);
    markAccountTasksStopped(accountId);
    addLog(accountId, 'products', 'Stop requested by user', 'info');
    addLog(accountId, 'change', 'Stop requested by user', 'info');
    return { stopped: true };
  });

  try {
    cleanupOldLogs();
  } catch (e) {
    console.error('[log-cleanup] startup failed:', e);
  }
  resumeInterruptedTasks();
  startLogCleanupScheduler();
  startScheduleTimer();
}


