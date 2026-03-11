const makeWASocket = require("@whiskeysockets/baileys").default;
const {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers,
    downloadMediaMessage,
    getContentType
} = require("@whiskeysockets/baileys");
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');

let sock;
let reconnecting = false;
let cachedHistory = []; 
let groupMetadataCache = {}; 
let contactCache = {}; // Global store for JID -> Name mapping

/**
 * DEBUG LOG HELPER
 */
function debugLog(context, message, data = "") {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [DEBUG-${context}] ${message}`, data);
}

/**
 * Helper to clean JIDs (handles @s.whatsapp.net, @g.us, and @lid)
 */
function cleanJidToNumber(jid) {
    if (!jid) return "Unknown";
    const id = jid.split('@')[0].split(':')[0];
    return /^\d+$/.test(id) ? `+${id}` : id;
}

async function getGroupName(jid) {
    if (!jid.endsWith('@g.us')) return null;
    if (groupMetadataCache[jid]) return groupMetadataCache[jid];

    if (sock && !reconnecting) {
        try {
            await new Promise(r => setTimeout(r, 300));
            const metadata = await sock.groupMetadata(jid);
            if (metadata && metadata.subject) {
                groupMetadataCache[jid] = metadata.subject;
                return metadata.subject;
            }
        } catch (e) {
            debugLog("Groups", `Failed to fetch metadata for ${jid}`);
        }
    }
    return "Group Chat";
}

/**
 * MAIN SOCKET INITIALIZATION
 */
async function startSock(manualNumber = null, browserWindow = null) {
    if (manualNumber && sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end(); 
        } catch (e) {}
        sock = null;
    }

    try {
        const authPath = path.join(app.getPath('userData'), 'auth_session');
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'), 
            logger: pino({ level: 'error' }),
            syncFullHistory: true, 
            connectTimeoutMs: 120000,
            getMessage: async (key) => {
                const found = cachedHistory.find(m => m.key.id === key.id);
                return found ? found.message : { conversation: '' };
            }
        });

        // Handle Pairing Code Request
        if (!state.creds.registered && manualNumber) {
            const cleanedNumber = manualNumber.replace(/\D/g, '');
            sock.ev.on('connection.update', async (update) => {
                const { connection } = update;
                if (connection === 'connecting') {
                    debugLog("Pairing", `Requesting code for ${cleanedNumber}`);
                    await new Promise(r => setTimeout(r, 6000));
                    try {
                        const code = await sock.requestPairingCode(cleanedNumber);
                        if (browserWindow) browserWindow.webContents.send('pairing-code', code);
                    } catch (err) {
                        if (browserWindow) browserWindow.webContents.send('pairing-error', err.message);
                    }
                }
            });
        }

        sock.ev.on("creds.update", saveCreds);

        /**
         * CONTACT DISCOVERY LOGIC
         * This captures every contact WhatsApp sends during the initial sync.
         */
        const updateContacts = (contacts) => {
            let newDiscoveries = 0;
            for (const contact of contacts) {
                const jid = contact.id;
                // Priority: Saved Name > Verified Biz Name > Notify (Push) Name
                const resolvedName = contact.name || contact.verifiedName || contact.notify;
                
                if (resolvedName && jid) {
                    if (!contactCache[jid] || contactCache[jid] !== resolvedName) {
                        contactCache[jid] = resolvedName;
                        newDiscoveries++;
                    }
                }
            }
            if (newDiscoveries > 0) {
                debugLog("Contacts", `Discovered/Updated ${newDiscoveries} contacts. Total in cache: ${Object.keys(contactCache).length}`);
            }
        };

        sock.ev.on('contacts.upsert', updateContacts);
        sock.ev.on('contacts.update', updateContacts);

        // Capture initial history and contact list
        sock.ev.on('messaging-history.set', async ({ messages, contacts, isLatest }) => {
            debugLog("Sync", `Received history set. Contacts: ${contacts?.length || 0}, Messages: ${messages?.length || 0}`);
            if (contacts) updateContacts(contacts);
            
            const existingIds = new Set(cachedHistory.map(m => m.key.id));
            const newMessages = messages.filter(m => !existingIds.has(m.key.id));
            cachedHistory = [...cachedHistory, ...newMessages];
        });

        // IPC: History Request (from UI)
        ipcMain.removeAllListeners('request-history-sync');
        ipcMain.on('request-history-sync', async (event, daysRequested) => {
            debugLog("Sync", `UI requested ${daysRequested} days of history.`);
            const timeframeMs = daysRequested * 24 * 60 * 60 * 1000;
            const now = Date.now();
            const processed = [];
            
            const filtered = [...cachedHistory]
                .sort((a, b) => (a.messageTimestamp?.low || a.messageTimestamp || 0) - (b.messageTimestamp?.low || b.messageTimestamp || 0))
                .filter(m => {
                    const msgTime = (m.messageTimestamp?.low || m.messageTimestamp || 0) * 1000;
                    return (now - msgTime) < timeframeMs;
                });

            debugLog("Sync", `Processing ${filtered.length} messages for UI...`);

            for (let i = 0; i < filtered.length; i++) {
                const m = filtered[i];
                const data = await processMessageData(m);
                if (data) {
                    if (data.isMedia) data.mediaPath = await downloadMedia(m);
                    processed.push(data);
                }
                
                // Send progress to UI
                if (i % 10 === 0 || i === filtered.length - 1) {
                    const percent = Math.round(((i + 1) / filtered.length) * 100);
                    if (browserWindow) browserWindow.webContents.send('sync-progress', { percent, current: i + 1, total: filtered.length });
                }
            }
            if (browserWindow) browserWindow.webContents.send('history-dump', processed);
        });

        // Handle Incoming Messages
        sock.ev.on("messages.upsert", async (m) => {
            if (m.type !== 'notify') return;
            for (const msg of m.messages) {
                const remoteJid = msg.key.remoteJid;
                if (remoteJid === 'status@broadcast') continue;

                // Auto-learn contact from incoming message pushName
                const senderJid = msg.key.participant || remoteJid;
                if (msg.pushName && !contactCache[senderJid]) {
                    contactCache[senderJid] = msg.pushName;
                    debugLog("Contacts", `Learned new contact from message: ${msg.pushName} (${senderJid})`);
                }

                const formattedMsg = await processMessageData(msg);
                if (!formattedMsg) continue;

                if (formattedMsg.isMedia) formattedMsg.mediaPath = await downloadMedia(msg);
                if (browserWindow) browserWindow.webContents.send('incoming-message', formattedMsg);
            }
        });

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "open") {
                debugLog("Connection", "WhatsApp Web is Ready.");
                if (browserWindow) browserWindow.webContents.send('connection-status', 'connected');
                reconnecting = false;
            }
            if (connection === "close") {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                debugLog("Connection", `Closed. Reconnecting: ${shouldReconnect}`);
                if (browserWindow) browserWindow.webContents.send('connection-status', 'disconnected');
                if (shouldReconnect && !reconnecting) {
                    reconnecting = true;
                    setTimeout(() => startSock(null, browserWindow), 5000);
                }
            }
        });

    } catch (error) {
        debugLog("Critical", "Socket Crash:", error.message);
    }
}

/**
 * MESSAGE PROCESSOR
 * Resolves JIDs to real names using the contactCache populated during sync.
 */
async function processMessageData(msg) {
    const remoteJid = msg.key.remoteJid;
    if (!remoteJid) return null;

    const isGroup = remoteJid.endsWith('@g.us');
    const fromMe = msg.key.fromMe;
    let rawSender = isGroup ? (msg.key.participant || "") : remoteJid;

    const cleanSenderNumber = cleanJidToNumber(rawSender);
    const cleanChatId = cleanJidToNumber(remoteJid);

    // NAME RESOLUTION
    let chatName;
    if (isGroup) {
        chatName = await getGroupName(remoteJid);
    } else {
        // Step 1: Check cache, Step 2: Check msg properties, Step 3: Use Number
        chatName = contactCache[remoteJid] || msg.pushName || msg.verifiedName || cleanChatId;
    }

    const senderName = isGroup 
        ? (contactCache[rawSender] || msg.pushName || cleanSenderNumber) 
        : chatName;

    const rawTs = (msg.messageTimestamp?.low || msg.messageTimestamp || Date.now() / 1000) * 1000;
    const localTime = new Date(rawTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let message = msg.message;
    if (!message) return null;

    let type = getContentType(message);
    if (['viewOnceMessage', 'viewOnceMessageV2', 'ephemeralMessage', 'documentWithCaptionMessage'].includes(type)) {
        message = message[type].message;
        type = getContentType(message);
    }

    if (type === 'protocolMessage' || type === 'senderKeyDistributionMessage') return null;

    const content = message[type];
    const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'].includes(type);

    let textContent = "";
    if (type === 'conversation') textContent = content;
    else if (type === 'extendedTextMessage') textContent = content.text;
    else if (content?.caption) textContent = content.caption;

    return {
        msgId: msg.key.id,
        chatId: remoteJid, 
        displayId: cleanChatId, 
        chatName: chatName,
        senderNumber: cleanSenderNumber,
        senderName: senderName, 
        fromMe: fromMe,
        text: textContent || (isMedia ? "" : `📝 ${type}`),
        timestamp: localTime,
        rawTimestamp: rawTs,
        status: msg.status || 2,
        isMedia: isMedia,
        mediaType: type,
        isGroup: isGroup
    };
}

/**
 * MEDIA DOWNLOADER
 */
async function downloadMedia(msg) {
    try {
        const buffer = await downloadMediaMessage(
            msg, 
            'buffer', 
            {}, 
            { logger: pino({ level: 'error' }), reuploadRequest: sock.updateMediaMessage }
        );

        if (!buffer || buffer.length < 100) return null;

        const tempDir = path.join(app.getPath('userData'), 'messenger_previews');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        let message = msg.message;
        let type = getContentType(message);
        if (['viewOnceMessage', 'viewOnceMessageV2', 'ephemeralMessage', 'documentWithCaptionMessage'].includes(type)) {
            message = message[type].message;
            type = getContentType(message);
        }
        
        const extMap = { 'imageMessage': 'jpg', 'videoMessage': 'mp4', 'audioMessage': 'ogg', 'stickerMessage': 'webp' };
        let ext = extMap[type] || 'bin';
        if (type === 'documentMessage') ext = (message.documentMessage.fileName || "").split('.').pop() || 'pdf';

        const fileName = `wa_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.${ext}`;
        const fullPath = path.join(tempDir, fileName);
        
        fs.writeFileSync(fullPath, buffer);
        return `media://${fullPath.replace(/\\/g, '/')}`;

    } catch (e) { 
        return null; 
    }
}

async function sendMessage(target, message) {
    try {
        if (!sock?.user) return { success: false, error: "Not Connected" };
        let jid = target.includes('@') ? target : (target.includes('-') ? `${target}@g.us` : `${target.replace(/\D/g, '')}@s.whatsapp.net`);
        const sent = await sock.sendMessage(jid, { text: message });
        return { 
            success: true, 
            msgId: sent.key.id, 
            rawTimestamp: (sent.messageTimestamp?.low || sent.messageTimestamp) * 1000 
        };
    } catch (error) { return { success: false, error: error.message }; }
}

module.exports = { startSock, sendMessage };