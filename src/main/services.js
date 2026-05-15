import { ipcMain } from 'electron';
import { dbApi as db } from './db.js';
import { fetchAllProducts, getProductInfo, getShopInfo, randomSleep, updateDaysToShip } from './shopee-client.js';

const running = new Set();
const stopRequested = new Set();
const now = () => Math.floor(Date.now() / 1000);
const LOG_RETENTION_DAYS = 15;
const DETAIL_WORKERS = 10;
const DETAIL_RETRY = 3;
const CHANGE_WORKERS = 1;
let logCleanupTimer = null;

function addLog(accountId, tab, message, type = 'info') {
  db.prepare('INSERT INTO logs (account_id, tab, message, type, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, tab, message, type, now());
}

function createTask(accountId, taskType, payload = {}) {
  const t = now();
  return db.prepare(`
    INSERT INTO task_queue (account_id, task_type, payload_json, status, created_at, updated_at, last_error)
    VALUES (?, ?, ?, 'running', ?, ?, NULL)
  `).run(accountId, taskType, JSON.stringify(payload || {}), t, t).lastInsertRowid;
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

async function executeFetchProducts(accountId) {
  ensureNotStopped(accountId);
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) throw new Error('Account not found');
  addLog(accountId, 'products', 'Start fetching products');
  const latestIds = new Set();
  const detailQueued = new Set();
  const detailQueue = [];
  let detailDone = 0;
  let detailOk = 0;
  let expectedTotal = 0;
  let listDone = false;
  let fetchedTotal = 0;
  let perfApiMs = 0;
  let perfDbMs = 0;
  let perfTotalMs = 0;
  const detailDeferred429 = [];
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

  const runDetailWorker = async () => {
    while (!listDone || detailQueue.length > 0) {
      ensureNotStopped(accountId);
      const productId = detailQueue.shift();
      if (!productId) {
        await sleepShort();
        continue;
      }
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
        addLog(accountId, 'products', `Detail perf item=${productId} api=${apiMs}ms db=${dbMs}ms total=${totalMs}ms`);
      } catch (e) {
        addLog(accountId, 'products', `Detail failed: ${productId} ${e?.message || e}`, 'error');
      } finally {
        detailDone += 1;
        const base = Math.max(expectedTotal, fetchedTotal, detailDone, 1);
        const listNotFinished = !listDone;
        const displayTotal = listNotFinished && detailDone >= base ? base + 1 : base;
        let percent = Math.min(100, Math.floor((detailDone / displayTotal) * 100));
        const statusSuffix = listNotFinished ? ' list=running' : ' list=done';
        addLog(accountId, 'products', `Progress detail: ${detailDone}/${displayTotal} success=${detailOk} percent=${percent}${statusSuffix}`);
        if (detailDone % 20 === 0) {
          const denom = Math.max(detailOk, 1);
          addLog(
            accountId,
            'products',
            `Detail perf summary done=${detailDone} ok=${detailOk} avg_api=${Math.round(perfApiMs / denom)}ms avg_db=${Math.round(perfDbMs / denom)}ms avg_total=${Math.round(perfTotalMs / denom)}ms`,
          );
        }
      }
      await detailPaceSleep();
    }
  };
  const detailWorkers = Array.from({ length: DETAIL_WORKERS }, () => runDetailWorker());
  try {
    db.prepare('UPDATE products SET exists_in_latest = 0 WHERE account_id = ?').run(accountId);
    await fetchAllProducts(
      acc.cookie_json,
      (m) => {
        ensureNotStopped(accountId);
        addLog(accountId, 'products', m);
      },
      (pageProducts, meta) => {
        ensureNotStopped(accountId);
        expectedTotal = Number(meta?.totalProducts || expectedTotal || 0);
        const t = now();
        for (const p of pageProducts) {
          latestIds.add(p.product_id);
          fetchedTotal += 1;
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
      },
    );
  } catch (e) {
    const msg = e?.message || String(e);
    addLog(accountId, 'products', `Fetch failed: ${msg}`, 'error');
    throw e;
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
  addLog(accountId, 'products', `Progress detail: ${detailDone}/${Math.max(expectedTotal, fetchedTotal, detailDone)} success=${detailOk} percent=100`);
  addLog(accountId, 'products', `Detail phase finished. success=${detailOk}, total=${Math.max(expectedTotal, fetchedTotal, detailDone)}`, 'success');
  addLog(accountId, 'products', `Fetch finished. total=${fetchedTotal}`, 'success');
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
  const queue = latestList.map((x) => x.product_id);
  const worker = async () => {
    while (queue.length > 0) {
      ensureNotStopped(accountId);
      const productId = queue.shift();
      if (!productId) break;
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
        addLog(accountId, 'products', `Detail perf item=${productId} api=${apiMs}ms db=${dbMs}ms total=${totalMs}ms`);
      } catch (e) {
        addLog(accountId, 'products', `Detail failed: ${productId} ${e?.message || e}`, 'error');
      } finally {
        detailDone += 1;
        const percent = latestList.length > 0 ? Math.floor((detailDone / latestList.length) * 100) : 100;
        addLog(accountId, 'products', `Progress detail: ${detailDone}/${latestList.length} success=${detailOk} percent=${percent}`);
        if (detailDone % 20 === 0) {
          const denom = Math.max(detailOk, 1);
          addLog(
            accountId,
            'products',
            `Detail perf summary done=${detailDone} ok=${detailOk} avg_api=${Math.round(perfApiMs / denom)}ms avg_db=${Math.round(perfDbMs / denom)}ms avg_total=${Math.round(perfTotalMs / denom)}ms`,
          );
        }
      }
      await detailPaceSleep();
    }
  };
  await Promise.all(Array.from({ length: DETAIL_WORKERS }, () => worker()));
  addLog(accountId, 'products', `Detail phase finished. success=${detailOk}, total=${latestList.length}`, 'success');
}

async function executeBatchChange(accountId, days) {
  ensureNotStopped(accountId);
  if (days < 0 || days > 30) throw new Error('days must be between 0 and 30');
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) throw new Error('Account not found');
  const list = db.prepare('SELECT * FROM products WHERE account_id = ? AND in_change_list = 1').all(accountId);
  if (list.length === 0) throw new Error('No product in change list');
  let ok = 0; let fail = 0; let skip = 0; let done = 0;
  const deferred429 = [];
  addLog(accountId, 'change', `Batch start. total=${list.length}, days=${days}`);
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
    addLog(
      accountId,
      'change',
      `Progress change: ${done}/${list.length} success=${ok} fail=${fail} skip=${skip} percent=${percent} speed=${speed.toFixed(2)} eta=${etaSec}s`,
    );
  };
  const processOneItem = async (p, phaseLabel) => {
    addLog(accountId, 'change', `Item start(${phaseLabel}): ${p.product_id} ${p.name}`);
    let err = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        addLog(accountId, 'change', `Item ${p.product_id} attempt ${attempt}/3: get_product_info`);
        const info = await getProductInfo(acc.cookie_json, p.product_id, false);
        const currentDays = Number(info?.pre_order_info?.days_to_ship ?? 0);
        if (currentDays === days) {
          skip += 1;
          db.prepare('UPDATE products SET days_to_ship = ?, is_pre_order = ? WHERE account_id = ? AND product_id = ?')
            .run(currentDays, currentDays > 0 ? 1 : 0, accountId, p.product_id);
          addLog(accountId, 'change', `Skipped: ${p.product_id} ${p.name} days_to_ship unchanged (${currentDays})`, 'info');
          done += 1;
          updateProgressLog();
          return 'done';
        }

        addLog(accountId, 'change', `Item ${p.product_id} attempt ${attempt}/3: update days ${currentDays} -> ${days}`);
        await randomSleep();
        await updateDaysToShip(acc.cookie_json, p.product_id, days, info);
        ok += 1;
        db.prepare('UPDATE products SET days_to_ship = ?, is_pre_order = ? WHERE account_id = ? AND product_id = ?')
          .run(days, days > 0 ? 1 : 0, accountId, p.product_id);
        addLog(accountId, 'change', `Success: ${p.product_id} ${p.name} ${currentDays} -> ${days}`, 'success');
        done += 1;
        updateProgressLog();
        return 'done';
      } catch (e) {
        err = e;
        const msg = String(e?.message || e || '');
        addLog(accountId, 'change', `Item ${p.product_id} attempt ${attempt}/3 failed: ${msg}`, 'error');
        if (/HTTP 429/i.test(msg)) {
          const waitSec = attempt * 2;
          addLog(accountId, 'change', `Rate limited (429). wait ${waitSec}s then retry`, 'info');
          await sleepWithStop(waitSec * 1000);
        } else {
          if (attempt < 3) await randomSleep();
        }
      }
    }

    if (/HTTP 429/i.test(String(err?.message || err || ''))) {
      addLog(accountId, 'change', `Defer 429 item to tail queue: ${p.product_id} ${p.name}`, 'info');
      return 'defer429';
    }

    fail += 1;
    done += 1;
    addLog(accountId, 'change', `Failed: ${p.product_id} ${p.name} ${err?.message || err}`, 'error');
    updateProgressLog();
    return 'failed';
  };
  const worker = async () => {
    while (queue.length > 0) {
      ensureNotStopped(accountId);
      const p = queue.shift();
      if (!p) break;
      const status = await processOneItem(p, 'main');
      if (status === 'defer429') {
        deferred429.push(p);
      }
      await randomSleep();
    }
  };
  await Promise.all(Array.from({ length: CHANGE_WORKERS }, () => worker()));
  if (deferred429.length > 0) {
    addLog(accountId, 'change', `Enter deferred-429 phase: pending=${deferred429.length}`, 'info');
  }
  while (deferred429.length > 0) {
    ensureNotStopped(accountId);
    addLog(accountId, 'change', `Deferred-429 round start: pending=${deferred429.length}. wait 30s`, 'info');
    await sleepWithStop(30000);
    const round = deferred429.splice(0, deferred429.length);
    for (const p of round) {
      ensureNotStopped(accountId);
      const status = await processOneItem(p, 'deferred429');
      if (status === 'defer429') deferred429.push(p);
      await randomSleep();
    }
  }
  addLog(accountId, 'change', `Batch finished. success=${ok}, skipped=${skip}, failed=${fail}`, 'success');
  return { ok, fail, skip };
}

async function runTaskWithRecord(accountId, taskType, payload, runner) {
  const taskId = createTask(accountId, taskType, payload);
  try {
    const ret = await runner();
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
  const isRetriableError = (msg) => {
    const s = String(msg || '').toLowerCase();
    if (!s) return false;
    if (/task stopped by user/i.test(s)) return false;
    return (
      /http 429/.test(s)
      || /rate limit/.test(s)
      || /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up/.test(s)
      || /network|failed to fetch|fetch failed/.test(s)
      || /request failed|gateway|bad gateway|service unavailable/.test(s)
    );
  };

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
          if (latestCount > 0 && pendingCount > 0) {
            addLog(accountId, 'products', `Resume strategy: continue detail phase only. pending=${pendingCount}/${latestCount}`, 'info');
            await executeDetailPhase(accountId, acc.cookie_json, true);
          } else {
            addLog(accountId, 'products', 'Resume strategy: rerun full fetch flow', 'info');
            await executeFetchProducts(accountId);
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
          await executeBatchChange(accountId, days);
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
    runTaskWithRecord(accountId, 'products_fetch', {}, async () => executeFetchProducts(accountId))
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

  ipcMain.handle('change:batch', (_e, accountId, days) => runExclusive(accountId, async () => (
    runTaskWithRecord(accountId, 'change_batch', { days }, async () => executeBatchChange(accountId, days))
  )));

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
}

