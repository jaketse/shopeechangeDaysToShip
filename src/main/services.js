import { ipcMain } from 'electron';
import { dbApi as db } from './db.js';
import { fetchAllProducts, getProductDetail, getShopInfo, randomSleep, updateDaysToShip } from './shopee-client.js';

const running = new Set();
const now = () => Math.floor(Date.now() / 1000);

function addLog(accountId, tab, message, type = 'info') {
  db.prepare('INSERT INTO logs (account_id, tab, message, type, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, tab, message, type, now());
}

async function runExclusive(accountId, fn) {
  if (running.has(accountId)) throw new Error('Task already running');
  running.add(accountId);
  try { return await fn(); } finally { running.delete(accountId); }
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

  ipcMain.handle('products:fetch', (_e, accountId) => runExclusive(accountId, async () => {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acc) throw new Error('Account not found');
    addLog(accountId, 'products', 'Start fetching products');
    const latestIds = new Set();
    let fetchedTotal = 0;
    const upsertBasic = db.prepare(`
      INSERT INTO products (account_id, product_id, name, image, price, stock, days_to_ship, status, is_pre_order, detail_json, fetched_at, exists_in_latest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(account_id, product_id) DO UPDATE SET
        name=excluded.name,image=excluded.image,price=excluded.price,stock=excluded.stock,
        days_to_ship=excluded.days_to_ship,status=excluded.status,is_pre_order=excluded.is_pre_order,
        fetched_at=excluded.fetched_at,exists_in_latest=1
    `);
    try {
      db.prepare('UPDATE products SET exists_in_latest = 0 WHERE account_id = ?').run(accountId);
      await fetchAllProducts(
        acc.cookie_json,
        (m) => addLog(accountId, 'products', m),
        (pageProducts, meta) => {
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
          }
          addLog(accountId, 'products', `Saved page ${meta.page}/${meta.totalPages || '?'} to DB. current=${meta.fetchedCount}`);
        },
      );
    } catch (e) {
      const msg = e?.message || String(e);
      addLog(accountId, 'products', `Fetch failed: ${msg}`, 'error');
      throw e;
    }

    const staleCountRow = db.prepare('SELECT COUNT(1) AS c FROM products WHERE account_id = ? AND exists_in_latest = 0').get(accountId);
    const staleCount = Number(staleCountRow?.c || 0);
    if (staleCount > 0) {
      db.prepare('DELETE FROM products WHERE account_id = ? AND exists_in_latest = 0').run(accountId);
      addLog(accountId, 'products', `Removed stale products: ${staleCount}`, 'success');
    }

    addLog(accountId, 'products', `Fetch finished. total=${fetchedTotal}`, 'success');

    // Detail phase runs after the list is already visible in UI.
    const latestList = db.prepare('SELECT product_id, name FROM products WHERE account_id = ? AND exists_in_latest = 1 ORDER BY product_id DESC').all(accountId);
    addLog(accountId, 'products', `Start detail phase. total=${latestList.length}`);
    const updateDetail = db.prepare('UPDATE products SET detail_json = ?, fetched_at = ? WHERE account_id = ? AND product_id = ?');
    let detailOk = 0;
    for (let i = 0; i < latestList.length; i += 1) {
      const p = latestList[i];
      try {
        const detail = await getProductDetail(acc.cookie_json, p.product_id);
        updateDetail.run(JSON.stringify(detail || {}), now(), accountId, p.product_id);
        detailOk += 1;
      } catch (e) {
        addLog(accountId, 'products', `Detail failed: ${p.product_id} ${e?.message || e}`, 'error');
      }
      const percent = Math.floor(((i + 1) / latestList.length) * 100);
      addLog(accountId, 'products', `Progress detail: ${i + 1}/${latestList.length} success=${detailOk} percent=${percent}`);
      await randomSleep();
    }
    addLog(accountId, 'products', `Detail phase finished. success=${detailOk}, total=${latestList.length}`, 'success');
    return true;
  }));

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

  ipcMain.handle('change:batch', (_e, accountId, days) => runExclusive(accountId, async () => {
    if (days < 0 || days > 30) throw new Error('days must be between 0 and 30');
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acc) throw new Error('Account not found');
    const list = db.prepare('SELECT * FROM products WHERE account_id = ? AND in_change_list = 1').all(accountId);
    if (list.length === 0) throw new Error('No product in change list');
    let ok = 0, fail = 0;
    addLog(accountId, 'change', `Batch start. total=${list.length}, days=${days}`);
    for (let i = 0; i < list.length; i += 1) {
      const p = list[i];
      let err;
      for (let i = 0; i < 3; i += 1) {
        try { await updateDaysToShip(acc.cookie_json, p.product_id, days); err = null; break; }
        catch (e) { err = e; await randomSleep(); }
      }
      if (err) {
        fail += 1;
        addLog(accountId, 'change', `Failed: ${p.product_id} ${p.name} ${err.message}`, 'error');
      } else {
        ok += 1;
        db.prepare('UPDATE products SET days_to_ship = ?, is_pre_order = ? WHERE account_id = ? AND product_id = ?')
          .run(days, days > 0 ? 1 : 0, accountId, p.product_id);
        addLog(accountId, 'change', `Success: ${p.product_id} ${p.name}`, 'success');
      }
      const done = i + 1;
      const percent = Math.floor((done / list.length) * 100);
      addLog(accountId, 'change', `Progress change: ${done}/${list.length} success=${ok} fail=${fail} percent=${percent}`);
      await randomSleep();
    }
    addLog(accountId, 'change', `Batch finished. success=${ok}, failed=${fail}`, 'success');
    return { ok, fail };
  }));

  ipcMain.handle('logs:get', (_e, accountId, tab) => db.prepare('SELECT * FROM logs WHERE account_id = ? AND tab = ? ORDER BY id DESC LIMIT 200').all(accountId, tab));
  ipcMain.handle('task:running', (_e, accountId) => running.has(accountId));
}
