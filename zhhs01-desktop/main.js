'use strict';

/**
 * zhhs01-desktop · Electron 主进程
 *
 * 渲染进程（renderer/index.html）即改造后的 Web 工作台，
 * 对话仍走云端代理 zhhs01-agent（/chat SSE），保持不变。
 *
 * 本地能力（需求：操作访问本地电脑）由主进程经 ipcMain 安全暴露，
 * 渲染进程通过 preload 的 window.electronAPI 调用。
 * 所有写操作 / 命令执行均需用户二次确认，文件读取带大小上限，避免 UI 卡死。
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// —— 安全上限 ——
const MAX_TEXT = 2 * 1024 * 1024;    // 文本文件 2MB
const MAX_BINARY = 8 * 1024 * 1024;  // 二进制文件 8MB

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.jsonl', '.log',
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.xml', '.yaml', '.yml', '.html', '.htm', '.css', '.scss',
  '.sql', '.ini', '.toml', '.sh', '.bat', '.ps1', '.env',
  '.gitignore', '.lock', '.svg', '.vue', '.lua', '.r', '.php'
]);

const INITIAL_DIR = os.homedir();

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#F7F7F8',
    title: 'zhhs_01 工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 隔离渲染进程与预加载脚本
      nodeIntegration: false,   // 渲染进程无 Node 集成（安全）
      sandbox: false            // 允许 preload 使用 require
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 调试时取消下一行注释即可打开 DevTools
  // win.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ============================================================
// 本地能力 API（ipcMain）
// ============================================================

ipcMain.handle('local:pickFiles', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('local:pickFolder', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('local:readFile', async (e, filePath, opts) => {
  opts = opts || {};
  let stat;
  try { stat = fs.statSync(filePath); } catch (err) { throw new Error('文件不存在或无法访问'); }
  const ext = path.extname(filePath).toLowerCase();
  const isText = TEXT_EXT.has(ext);
  if (isText) {
    if (stat.size > MAX_TEXT) throw new Error('文本文件过大（>2MB），请在对话中分段提供');
    const content = fs.readFileSync(filePath, 'utf-8');
    return { name: path.basename(filePath), size: stat.size, type: 'text', content, mime: 'text/plain' };
  }
  if (stat.size > MAX_BINARY) throw new Error('二进制文件过大（>8MB），暂不支持读取');
  const buf = fs.readFileSync(filePath);
  return { name: path.basename(filePath), size: stat.size, type: 'binary', content: buf.toString('base64'), mime: 'application/octet-stream' };
});

ipcMain.handle('local:readDir', async (e, dirPath) => {
  const abs = path.resolve(dirPath || INITIAL_DIR);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch (err) { throw new Error('无法读取目录：' + err.message); }
  const items = entries
    .filter(en => !en.name.startsWith('.'))
    .map(en => {
      let size = null;
      try { const s = fs.statSync(path.join(abs, en.name)); size = s.isFile() ? s.size : null; } catch (e) {}
      return { name: en.name, path: path.join(abs, en.name), isDir: en.isDirectory(), size };
    })
    .sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name, 'zh') : (a.isDir ? -1 : 1));
  const parent = path.dirname(abs) !== abs ? path.dirname(abs) : null;
  return { items, parent };
});

ipcMain.handle('local:openPath', async (e, target) => {
  await shell.openPath(target);
  return true;
});

ipcMain.handle('local:showInFolder', async (e, target) => {
  shell.showItemInFolder(target);
  return true;
});

ipcMain.handle('local:writeFile', async (e, filePath, content) => {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['取消', '确认写入'],
    defaultId: 1,
    cancelId: 0,
    title: '确认写入文件',
    message: '即将写入文件：\n' + filePath + '\n\n内容长度：' + (content ? content.length : 0) + ' 字符。是否继续？'
  });
  if (response !== 1) throw new Error('用户取消写入');
  fs.writeFileSync(filePath, content || '', 'utf-8');
  return true;
});

ipcMain.handle('local:dirParent', async (e, dirPath) => {
  const abs = path.resolve(dirPath || INITIAL_DIR);
  const parent = path.dirname(abs);
  return parent !== abs ? parent : null;
});

ipcMain.handle('local:runCommand', async (e, cmd, cwd) => {
  if (!cmd || !cmd.trim()) throw new Error('命令为空');
  const workDir = cwd || INITIAL_DIR;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['取消', '确认执行'],
    defaultId: 1,
    cancelId: 0,
    title: '确认执行命令',
    message: '即将在本地真实执行命令：\n\n  ' + cmd + '\n\n目录：' + workDir + '\n\n注意：此操作会真实改动你的电脑，请确认无误。'
  });
  if (response !== 1) throw new Error('用户取消执行');
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.COMSPEC || 'cmd.exe', ['/c', cmd], {
      cwd: workDir,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err && err.killed) return reject(new Error('命令超时（30s）已被终止'));
      if (err && err.code && !stdout && !stderr) return reject(new Error(stderr || err.message));
      resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? err.code : 0 });
    });
  });
});

ipcMain.handle('local:osInfo', async () => {
  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    release: os.release(),
    homedir: os.homedir(),
    cpus: os.cpus().length,
    totalmem: os.totalmem(),
    initialDir: INITIAL_DIR
  };
});
