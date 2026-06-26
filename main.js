const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { spawn, exec } = require('node:child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    frame: false, // Frameless for a premium, custom UI
    transparent: false,
    backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  // Open developer tools in dev mode if needed
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Helper to run scanner.ps1 functions
function runPowerShell(action, params = {}) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scanner.ps1');
    const paramsJson = JSON.stringify(params);
    const paramsBase64 = Buffer.from(paramsJson, 'utf8').toString('base64');

    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Action', action,
      '-ParamsBase64', paramsBase64
    ];

    const ps = spawn('powershell.exe', args);
    let stdout = '';
    let stderr = '';

    ps.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ps.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ps.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell exited with code ${code}. Error: ${stderr}`));
        return;
      }
      try {
        const json = JSON.parse(stdout);
        resolve(json);
      } catch (err) {
        reject(new Error(`Failed to parse PowerShell JSON: ${err.message}. Output was: ${stdout}`));
      }
    });
  });
}

// IPC Handlers
ipcMain.handle('get-desktop-apps', async () => {
  try {
    return await runPowerShell('list-desktop');
  } catch (error) {
    console.error('Error fetching desktop apps:', error);
    return [];
  }
});

ipcMain.handle('get-uwp-apps', async () => {
  try {
    return await runPowerShell('list-uwp');
  } catch (error) {
    console.error('Error fetching UWP apps:', error);
    return [];
  }
});

ipcMain.handle('create-restore-point', async () => {
  try {
    return await runPowerShell('restore-point');
  } catch (error) {
    console.error('Error creating restore point:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('scan-leftovers', async (event, { appName, publisher, installLocation, mode }) => {
  try {
    return await runPowerShell('scan-leftovers', { appName, publisher, installLocation, mode });
  } catch (error) {
    console.error('Error scanning leftovers:', error);
    return { files: [], registry: [] };
  }
});

ipcMain.handle('purge-remnants', async (event, remnants) => {
  try {
    return await runPowerShell('purge', remnants);
  } catch (error) {
    console.error('Error purging remnants:', error);
    return { success: false, error: error.message };
  }
});

// Run native uninstaller
ipcMain.handle('uninstall-native', async (event, uninstallString) => {
  return new Promise((resolve) => {
    if (!uninstallString) {
      resolve({ success: false, error: 'No uninstall command found for this app.' });
      return;
    }

    exec(uninstallString, (error, stdout, stderr) => {
      if (error) {
        // Some uninstallers exit with codes or complain, but they might still run
        resolve({ success: false, error: error.message });
      } else {
        resolve({ success: true });
      }
    });
  });
});

// Check Admin Status
ipcMain.handle('check-admin', async () => {
  return new Promise((resolve) => {
    exec('net session', (error) => {
      // 'net session' returns error code 1 if not running elevated
      resolve(!error);
    });
  });
});

// Frameless Window Control Handlers
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// Open link in external browser
ipcMain.on('open-external-link', (event, url) => {
  shell.openExternal(url);
});
