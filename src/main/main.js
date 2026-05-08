import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import updaterPkg from 'electron-updater';
import './preload.js';
import { initHandlers } from './services.js';
import { initDB } from './db.js';
const { autoUpdater } = updaterPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const remoteDebugPort = process.env.ELECTRON_REMOTE_DEBUGGING_PORT;
let mainWindow = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

if (remoteDebugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebugPort);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'shopeeChangeDTS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (rendererUrl) {
    win.loadURL(rendererUrl);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
  }

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[did-fail-load]', code, desc, url);
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('[renderer]', level, sourceId, line, message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-process-gone]', details);
  });

  // 防止页面更改窗口标题
  win.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  return win;
}

function setupAutoUpdate(win) {
  if (isDev) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('[auto-update] checking for updates');
  });

  autoUpdater.on('update-available', async (info) => {
    console.log('[auto-update] update available:', info?.version);
    const r = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['更新', '稍後'],
      defaultId: 0,
      cancelId: 1,
      title: '發現新版本',
      message: `檢測到新版本 ${info?.version || ''}，是否立即下載更新？`,
    });
    if (r.response === 0) {
      autoUpdater.downloadUpdate().catch((e) => {
        console.error('[auto-update] download failed:', e);
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[auto-update] no update');
  });

  autoUpdater.on('download-progress', (p) => {
    console.log(`[auto-update] downloading ${Math.round(p.percent || 0)}%`);
  });

  autoUpdater.on('update-downloaded', async () => {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['立即重啟更新', '稍後'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已下載',
      message: '更新下載完成，是否現在重啟安裝？',
    });
    if (r.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (e) => {
    console.error('[auto-update] error:', e);
  });

  autoUpdater.checkForUpdates().catch((e) => {
    console.error('[auto-update] check failed:', e);
  });
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '提示',
    message: '應用已經打開了',
    buttons: ['確定'],
  }).catch(() => {});
});

app.whenReady().then(() => {
  return initDB();
}).then(() => {
  initHandlers();
  mainWindow = createWindow();
  setupAutoUpdate(mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('before-quit', () => {
  // 在应用退出前的清理工作
  mainWindow = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
