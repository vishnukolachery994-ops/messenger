const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require("electron");
const { startSock, sendMessage } = require("./whatsapp");
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let mainWindow; 
const TEMP_MEDIA_DIR = path.join(app.getPath('userData'), 'messenger_previews');

/**
 * Enhanced Log Helper
 */
function debugLog(context, message, data = "") {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${context}] ${message}`, data);
}

/**
 * Clean media cache on startup
 */
function cleanMediaCache() {
    try {
        if (fs.existsSync(TEMP_MEDIA_DIR)) {
            fs.rmSync(TEMP_MEDIA_DIR, { recursive: true, force: true });
        }
        fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });
        debugLog("Cache", `Temp directory verified at: ${TEMP_MEDIA_DIR}`);
    } catch (err) {
        debugLog("Cache", "Cleanup failed:", err.message);
    }
}

/**
 * Modern Protocol Handler (Electron 25+)
 * Handles 'media://' requests to bypass webSecurity while supporting streaming.
 */
function registerMediaProtocol() {
    protocol.handle('media', (request) => {
        const url = request.url.replace('media://', '');
        let decodedPath = decodeURIComponent(url);

        // Windows Path Repair: Converts /C:/path to C:/path
        if (process.platform === 'win32') {
            if (/^\/[a-zA-Z]\//.test(decodedPath)) {
                decodedPath = decodedPath.slice(1, 2) + ':' + decodedPath.slice(2);
            } else if (/^[a-zA-Z]\//.test(decodedPath)) {
                decodedPath = decodedPath[0] + ':' + decodedPath.slice(1);
            }
        }

        const finalPath = path.normalize(decodedPath);
        const isAudio = finalPath.toLowerCase().endsWith('.ogg');

        if (isAudio) {
            if (fs.existsSync(finalPath)) {
                const stats = fs.statSync(finalPath);
                debugLog("DEBUG-AUDIO", `Serving: ${path.basename(finalPath)} (${stats.size} bytes)`);
            } else {
                debugLog("DEBUG-AUDIO", `❌ File Missing: ${finalPath}`);
            }
        }

        // net.fetch handles 'Range' headers for us, enabling audio/video seeking
        return net.fetch(pathToFileURL(finalPath).toString());
    });
}

/**
 * Main Window Configuration
 */
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 850,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            // While we use a custom protocol, these are kept for flexibility with local assets
            webSecurity: false, 
            allowRunningInsecureContent: true
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile("index.html");

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        debugLog("Window", "Main window displayed and ready.");
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// --- APP INITIALIZATION ---

app.whenReady().then(async () => {
    debugLog("App", "Initializing Application Components...");
    
    cleanMediaCache();
    registerMediaProtocol();
    createWindow();
    
    try {
        debugLog("WhatsApp", "Starting socket connection...");
        // Initialize the Baileys socket
        await startSock(null, mainWindow);
    } catch (err) {
        debugLog("WhatsApp", "❌ Initialization Error:", err.message);
    }
});

// --- IPC LISTENERS ---

// Triggered when the user enters a phone number for pairing
ipcMain.on("request-pairing", async (event, phone) => {
    debugLog("Pairing", `User requested pairing for: ${phone}`);
    const cleanPhone = phone.replace(/\D/g, ''); 
    await startSock(cleanPhone, mainWindow); 
});

// Triggered from the UI to send a text message
ipcMain.on("send-message", async (event, number, message) => {
    debugLog("Message", `Attempting to send to ${number}...`);
    try {
        const result = await sendMessage(number, message);
        if (result && result.success) {
            mainWindow.webContents.send('message-sent-confirmation', { 
                number, 
                text: message, 
                msgId: result.msgId, 
                rawTimestamp: result.rawTimestamp 
            });
        }
    } catch (err) {
        debugLog("Message", "❌ IPC Crash:", err.message);
    }
});

// Triggered to save a media file from the temp cache to the user's Downloads
ipcMain.on('download-media-manually', async (event, tempPath) => {
    let cleanPath = tempPath.replace('media://', '').replace('file://', '');
    let finalSourcePath = decodeURIComponent(cleanPath);
    
    // Path correction for Windows during manual download
    if (process.platform === 'win32' && /^[a-zA-Z]\//.test(finalSourcePath)) {
        finalSourcePath = finalSourcePath[0] + ':' + finalSourcePath.slice(1);
    }
    finalSourcePath = path.normalize(finalSourcePath);

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Media',
        defaultPath: path.join(app.getPath('downloads'), `WA_Media_${Date.now()}${path.extname(finalSourcePath)}`)
    });

    if (filePath) {
        try {
            fs.copyFileSync(finalSourcePath, filePath);
            shell.showItemInFolder(filePath);
        } catch (err) {
            debugLog("IO", "Download failed:", err.message);
        }
    }
});

// Resets the application session (logs out)
ipcMain.on("reset-app", () => {
    const authPath = path.join(app.getPath('userData'), 'auth_session');
    try {
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
        app.relaunch();
        app.exit(0);
    } catch (err) { 
        debugLog("App", "Reset Failed"); 
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});