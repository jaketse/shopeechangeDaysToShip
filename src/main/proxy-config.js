import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const proxyConfigPath = path.join(os.homedir(), '.shopee-days-to-ship-proxy.json');
let config = { enabled: false, url: '' };

export function loadProxyConfig() {
  try {
    if (fs.existsSync(proxyConfigPath)) {
      const raw = fs.readFileSync(proxyConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      config = {
        enabled: Boolean(parsed?.enabled),
        url: String(parsed?.url || '').trim(),
      };
    }
  } catch {
    config = { enabled: false, url: '' };
  }
  return { ...config };
}

export function getProxyConfig() {
  return { ...config };
}

export function setProxyConfig(next = {}) {
  const enabled = Boolean(next?.enabled);
  const url = String(next?.url || '').trim();
  if (enabled && !url) {
    throw new Error('代理已啟用時，代理地址不能為空');
  }
  if (url) {
    try {
      // validate format
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      throw new Error('代理地址格式無效，示例：http://127.0.0.1:7890');
    }
  }
  config = { enabled, url };
  fs.writeFileSync(proxyConfigPath, JSON.stringify(config, null, 2), 'utf8');
  return { ...config };
}
