import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const dbPath = path.join(os.homedir(), '.shopee-days-to-ship-electron.sqlite');
let db;
let txDepth = 0;

function isWriteSql(sql) {
  return /^\s*(insert|update|delete|create|drop|alter|replace|begin|commit|rollback)/i.test(sql);
}

function wrapPrepare(sql) {
  return {
    run: (...params) => {
      const stmt = db.prepare(sql);
      const info = stmt.run(...params);
      const lastInsertRowid = Number(info?.lastInsertRowid || 0);
      return { lastInsertRowid };
    },
    get: (...params) => {
      const stmt = db.prepare(sql);
      return stmt.get(...params);
    },
    all: (...params) => {
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    },
  };
}

export async function initDB() {
  if (db) return;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL UNIQUE,
      shop_name TEXT,
      cookie_json TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name TEXT,
      image TEXT,
      price TEXT,
      stock INTEGER,
      days_to_ship INTEGER,
      status INTEGER,
      is_pre_order INTEGER,
      detail_json TEXT,
      fetched_at INTEGER,
      in_change_list INTEGER DEFAULT 0,
      exists_in_latest INTEGER DEFAULT 1,
      UNIQUE(account_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      tab TEXT,
      message TEXT,
      type TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS task_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS schedule_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      note TEXT DEFAULT '',
      is_active INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      last_run_at INTEGER,
      last_result TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS schedule_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      rule_type TEXT NOT NULL, -- daily / weekly
      daily_time TEXT,          -- HH:mm
      weekly_day INTEGER,       -- 0..6 (Sun..Sat)
      weekly_time TEXT,         -- HH:mm
      days_to_ship INTEGER NOT NULL,
      next_run_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS schedule_task_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      created_at INTEGER,
      UNIQUE(task_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS schedule_task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      group_id INTEGER,
      message TEXT,
      type TEXT,
      created_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_products_account_change_list
      ON products(account_id, in_change_list);
    CREATE INDEX IF NOT EXISTS idx_products_account_latest
      ON products(account_id, exists_in_latest);
    CREATE INDEX IF NOT EXISTS idx_logs_account_tab_created
      ON logs(account_id, tab, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_queue_account_type_status_created
      ON task_queue(account_id, task_type, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_schedule_tasks_account_active
      ON schedule_tasks(account_id, is_active, updated_at);
    CREATE INDEX IF NOT EXISTS idx_schedule_rules_task_next
      ON schedule_rules(task_id, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_schedule_products_task
      ON schedule_task_products(task_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_task_logs_task_created
      ON schedule_task_logs(task_id, created_at);
  `);

  // Migrate old schema: remove schedule_rules.is_active
  const ruleCols = db.prepare("PRAGMA table_info(schedule_rules)").all();
  const hasRuleActive = ruleCols.some((c) => String(c.name) === 'is_active');
  if (hasRuleActive) {
    db.exec(`
      DROP INDEX IF EXISTS idx_schedule_rules_task_active_next;
      CREATE TABLE IF NOT EXISTS schedule_rules_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        rule_type TEXT NOT NULL,
        daily_time TEXT,
        weekly_day INTEGER,
        weekly_time TEXT,
        days_to_ship INTEGER NOT NULL,
        next_run_at INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      );
      INSERT INTO schedule_rules_new (
        id, task_id, rule_type, daily_time, weekly_day, weekly_time, days_to_ship, next_run_at, created_at, updated_at
      )
      SELECT
        id, task_id, rule_type, daily_time, weekly_day, weekly_time, days_to_ship, next_run_at, created_at, updated_at
      FROM schedule_rules;
      DROP TABLE schedule_rules;
      ALTER TABLE schedule_rules_new RENAME TO schedule_rules;
      CREATE INDEX IF NOT EXISTS idx_schedule_rules_task_next
        ON schedule_rules(task_id, next_run_at);
    `);
  }

  const taskCols = db.prepare("PRAGMA table_info(schedule_tasks)").all();
  const colSet = new Set(taskCols.map((c) => String(c.name)));
  const ensureTaskCol = (name, ddl) => {
    if (!colSet.has(name)) db.exec(`ALTER TABLE schedule_tasks ADD COLUMN ${ddl};`);
  };
  ensureTaskCol('run_status', 'run_status TEXT');
  ensureTaskCol('run_total', 'run_total INTEGER DEFAULT 0');
  ensureTaskCol('run_done', 'run_done INTEGER DEFAULT 0');
  ensureTaskCol('run_success', 'run_success INTEGER DEFAULT 0');
  ensureTaskCol('run_fail', 'run_fail INTEGER DEFAULT 0');
  ensureTaskCol('run_skip', 'run_skip INTEGER DEFAULT 0');
  ensureTaskCol('run_started_at', 'run_started_at INTEGER');
  ensureTaskCol('run_updated_at', 'run_updated_at INTEGER');

  const taskLogCols = db.prepare("PRAGMA table_info(schedule_task_logs)").all();
  const hasTaskLogGroup = taskLogCols.some((c) => String(c.name) === 'group_id');
  if (!hasTaskLogGroup) {
    db.exec('ALTER TABLE schedule_task_logs ADD COLUMN group_id INTEGER;');
  }
}

export const dbApi = {
  prepare: (sql) => wrapPrepare(sql),
  exec: (sql) => {
    db.exec(sql);
  },
  transaction: (fn) => (...args) => {
    txDepth += 1;
    try {
      const wrapped = db.transaction(() => fn(...args));
      wrapped();
      txDepth -= 1;
    } catch (e) {
      txDepth = Math.max(0, txDepth - 1);
      throw e;
    }
  },
};
