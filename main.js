'use strict';

const { app, BrowserWindow, nativeImage, ipcMain, globalShortcut, session, dialog, shell } = require('electron');
const { spawn, execFile }    = require('child_process');
const path                   = require('path');

const ICON_PATH = path.join(__dirname, 'icon.png');

let mainWindow    = null;
let pythonProcess = null;
let backendRestarting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:    1160,
    height:   800,
    minWidth: 860,
    minHeight: 620,
    icon: ICON_PATH,
    title: 'Project Beatrice – AI Voice Changer',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 13 } } : {}),
    backgroundColor: '#05050b',
    show: false,           // avoid white flash on load
    webPreferences: {
      nodeIntegration:  true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.maximize();
    ensureVirtualMic();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startBackend() {
  const appDir = app.isPackaged
    ? app.getAppPath().replace('app.asar', 'app.asar.unpacked')
    : __dirname;
  const scriptPath = path.join(appDir, 'beatrice_audio.py');
  console.log('[Beatrice] Spawning Python audio backend:', scriptPath);

  // Writable user data folder setup
  const userDataPath = app.getPath('userData');
  const customModelsPath = path.join(userDataPath, 'custom_models');
  const fs = require('fs');
  if (!fs.existsSync(customModelsPath)) {
    try {
      fs.mkdirSync(customModelsPath, { recursive: true });
    } catch (e) {
      console.error('[Beatrice] Failed to create custom_models directory:', e);
    }
  }

  // Migrate legacy custom models from project root to userData during development/startup
  const legacyCustomModelsPath = path.join(appDir, 'custom_models');
  if (fs.existsSync(legacyCustomModelsPath) && legacyCustomModelsPath !== customModelsPath) {
    try {
      const folders = fs.readdirSync(legacyCustomModelsPath);
      for (const folder of folders) {
        const srcFolder = path.join(legacyCustomModelsPath, folder);
        const destFolder = path.join(customModelsPath, folder);
        if (fs.statSync(srcFolder).isDirectory()) {
          if (!fs.existsSync(destFolder)) {
            console.log(`[Beatrice] Migrating custom model: ${folder}`);
            fs.cpSync(srcFolder, destFolder, { recursive: true });
          }
        }
      }
    } catch (err) {
      console.error('[Beatrice] Migration of legacy custom models failed:', err);
    }
  }

  // Pass writable custom models base path to Python backend
  const env = Object.assign({}, process.env, {
    BEATRICE_CUSTOM_MODELS_DIR: customModelsPath
  });

  let spawnCmd;
  let spawnArgs = [];

  if (app.isPackaged) {
    const fs = require('fs');
    const exePath = path.join(appDir, 'beatrice_audio.exe');
    if (fs.existsSync(exePath)) {
      spawnCmd = exePath;
    } else {
      spawnCmd = process.platform === 'win32' ? 'python' : 'python3';
      spawnArgs = ['-u', scriptPath];
    }
  } else {
    spawnCmd = process.platform === 'win32' ? 'python' : 'python3';
    spawnArgs = ['-u', scriptPath];

    if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        const isArm = execSync('sysctl -in hw.optional.arm64').toString().trim() === '1';
        if (isArm) {
          spawnCmd = 'arch';
          spawnArgs = ['-arm64', 'python3', '-u', scriptPath];
        }
      } catch (e) {
        console.error('[Beatrice] Failed to check for Apple Silicon:', e);
      }
    }
  }

  pythonProcess = spawn(spawnCmd, spawnArgs, {
    cwd: appDir,
    env: env
  });

  pythonProcess.stdout.on('data', data =>
    console.log('[Python]', data.toString().trimEnd()));

  pythonProcess.stderr.on('data', data =>
    console.error('[Python ERR]', data.toString().trimEnd()));

  pythonProcess.on('error', err =>
    console.error('[Beatrice] Failed to start Python backend:', err.message));

  pythonProcess.on('close', code => {
    console.log('[Beatrice] Python backend exited with code', code);
    pythonProcess = null;
    if (backendRestarting) { backendRestarting = false; startBackend(); }
  });
}

// ── Virtual microphone (VB-CABLE) ─────────────────────────────────────────────
// Apps like Discord and Zoom can only hear Beatrice through a virtual audio
// device. VB-CABLE's licence does not allow bundling it inside another app's
// installer, so on a launch where it is missing we offer a one-click install:
// download the official package from vb-audio.com and open VB-Audio's own
// setup, where the user accepts their licence.
const VBCABLE_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip';

function powershell(script, timeout) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}

async function ensureVirtualMic() {
  if (process.platform !== 'win32') return;
  try {
    const count = await powershell(
      "@(Get-CimInstance Win32_SoundDevice | Where-Object { $_.Name -like '*VB-Audio*' }).Count", 30000);
    if (Number(count) > 0) return;
  } catch (err) {
    console.log('[Beatrice] Could not check for VB-CABLE:', err.message);
    return;
  }

  const { response } = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    message: 'Install the virtual microphone?',
    detail: 'Beatrice uses VB-CABLE, a free virtual audio cable, so Discord, Zoom and games can hear your converted voice. '
      + 'Beatrice will download it from vb-audio.com and open its installer: click "Install Driver" and allow the Windows prompt.',
    buttons: ['Install VB-CABLE', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  const dir = path.join(app.getPath('temp'), 'beatrice-vbcable');
  const ps = s => "'" + s.replace(/'/g, "''") + "'";
  try {
    await powershell([
      "$ErrorActionPreference = 'Stop'",
      '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
      `New-Item -ItemType Directory -Force -Path ${ps(dir)} | Out-Null`,
      `Invoke-WebRequest -UseBasicParsing -Uri ${ps(VBCABLE_URL)} -OutFile ${ps(path.join(dir, 'vbcable.zip'))}`,
      `Expand-Archive -Force -Path ${ps(path.join(dir, 'vbcable.zip'))} -DestinationPath ${ps(dir)}`,
      `Start-Process -FilePath ${ps(path.join(dir, 'VBCABLE_Setup_x64.exe'))} -Verb RunAs -Wait`,
    ].join('; '), 15 * 60 * 1000);
  } catch (err) {
    console.log('[Beatrice] VB-CABLE was not installed:', err.message);
    const { response: open } = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      message: 'VB-CABLE was not installed',
      detail: 'You can install it yourself from vb-audio.com, then restart Beatrice.',
      buttons: ['Open vb-audio.com', 'OK'],
      defaultId: 1,
    });
    if (open === 0) shell.openExternal('https://vb-audio.com/Cable/');
    return;
  }

  // The audio engine lists devices once at start, so restart it to see the
  // cable, then let the window pick it as the output.
  console.log('[Beatrice] VB-CABLE setup finished');
  if (pythonProcess) { backendRestarting = true; pythonProcess.kill(); }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('virtual-mic-installed');
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// Only one copy may run: a second one could not open the audio engine's port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(ICON_PATH);
    app.dock.setIcon(icon);
  }

  // Strip Referer and Origin headers for MyInstants requests to bypass CORS/access restrictions
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://*.myinstants.com/*'] },
    (details, callback) => {
      delete details.requestHeaders['Referer'];
      delete details.requestHeaders['Origin'];
      details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  startBackend();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (pythonProcess) {
    console.log('[Beatrice] Terminating Python backend…');
    pythonProcess.kill('SIGKILL');
    pythonProcess = null;
  }
});

// IPC Handler for soundboard global keybinds
ipcMain.on('register-sound-shortcuts', (event, shortcuts) => {
  globalShortcut.unregisterAll();

  shortcuts.forEach(s => {
    try {
      const ok = globalShortcut.register(s.keybind, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('play-sound-slot', s.index);
        }
      });
      if (!ok) {
        console.warn(`[Keybind] Failed to register global shortcut: ${s.keybind}`);
      }
    } catch (err) {
      console.error(`[Keybind] Error registering shortcut ${s.keybind}:`, err);
    }
  });
});

// IPC Handler to get the app userData path synchronously
ipcMain.on('get-user-data-path', (event) => {
  event.returnValue = app.getPath('userData');
});

// Window control IPC handlers
ipcMain.on('win-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('win-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('win-close', () => {
  if (mainWindow) mainWindow.close();
});
