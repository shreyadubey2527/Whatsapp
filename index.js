const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode');
const http = require('http');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname)); // Serve index.html and static assets

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Ensure directories exist
[DATA_DIR, SESSIONS_DIR, CAMPAIGNS_DIR, HISTORY_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}));

// In-memory states
const userSockets = {};
const userQRs = {};
const userStatus = {}; // connected, connecting, disconnected
const activeTimeouts = {}; // Store campaign timeouts to allow stopping

// Utils
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}
function getUsers() {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Spin-tax parser
function parseSpintax(text) {
    const regex = /{([^{}]*)}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const options = match[1].split('|');
        const randomOption = options[Math.floor(Math.random() * options.length)];
        text = text.replace(match[0], randomOption);
        regex.lastIndex = 0;
    }
    return text;
}

// Initialize WhatsApp Session
async function startWhatsApp(username) {
    userStatus[username] = 'connecting';
    const sessionDir = path.join(SESSIONS_DIR, username);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['WhatsApp Agent Pro', 'Desktop', '1.0.0']
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            userQRs[username] = await qrcode.toDataURL(qr);
        }
        
        if (connection === 'close') {
            userQRs[username] = null;
            userStatus[username] = 'disconnected';
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            
            if (shouldReconnect) {
                console.log(`Connection closed for ${username}, reconnecting...`);
                setTimeout(() => startWhatsApp(username), 5000);
            } else {
                console.log(`Connection logged out for ${username}.`);
                delete userSockets[username];
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            }
        } else if (connection === 'open') {
            console.log(`Connected for ${username}`);
            userQRs[username] = null;
            userStatus[username] = 'connected';
            userSockets[username] = sock;
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            const msg = m.messages[0];
            if (!msg.key.fromMe && msg.message) {
                // Store message for chat modal
                const chatHistoryFile = path.join(HISTORY_DIR, `${username}_chats.json`);
                let chats = fs.existsSync(chatHistoryFile) ? JSON.parse(fs.readFileSync(chatHistoryFile, 'utf8')) : [];
                const chatMsg = {
                    from: msg.key.remoteJid,
                    pushName: msg.pushName || 'Unknown',
                    text: msg.message.conversation || msg.message.extendedTextMessage?.text || "",
                    time: new Date().toISOString()
                };
                chats.push(chatMsg);
                if (chats.length > 100) chats.shift(); // Keep last 100
                fs.writeFileSync(chatHistoryFile, JSON.stringify(chats, null, 2));

                const settingsFile = path.join(DATA_DIR, `${username}_settings.json`);
                if (fs.existsSync(settingsFile)) {
                    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
                    if (settings.autoReplyEnabled) {
                        const text = chatMsg.text;
                        let replyText = settings.globalReply;
                        
                        if (settings.keywords && Array.isArray(settings.keywords)) {
                            for (let kw of settings.keywords) {
                                if (text.toLowerCase().includes(kw.word.toLowerCase())) {
                                    replyText = kw.reply;
                                    break;
                                }
                            }
                        }
                        
                        if (replyText) {
                            try {
                                await sock.sendMessage(msg.key.remoteJid, { text: replyText });
                            } catch (err) {
                                console.error(`Auto-reply error for ${username}:`, err.message);
                            }
                        }
                    }
                }
            }
        }
    });

    userSockets[username] = sock;
}

// Auto-resume existing sessions on startup
const existingSessions = fs.readdirSync(SESSIONS_DIR);
existingSessions.forEach(userSession => {
    startWhatsApp(userSession);
});

// Middleware: Authentication
function auth(req, res, next) {
    const token = req.headers['authorization'];
    const username = req.headers['x-username'];
    const users = getUsers();
    if (users[username] && users[username].token === token) {
        req.user = username;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// API: Auth
app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const users = getUsers();
    if (users[username]) return res.status(400).json({ error: 'User exists' });
    users[username] = { password: hashPassword(password), token: crypto.randomBytes(16).toString('hex') };
    saveUsers(users);
    res.json({ token: users[username].token, username });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    if (!users[username] || users[username].password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Refresh token on login
    users[username].token = crypto.randomBytes(16).toString('hex');
    saveUsers(users);
    res.json({ token: users[username].token, username });
});

// API: WhatsApp Connection
app.get('/api/wa/status', auth, (req, res) => {
    const username = req.user;
    res.json({
        status: userStatus[username] || 'disconnected',
        qr: userQRs[username] || null
    });
});

app.post('/api/wa/connect', auth, (req, res) => {
    const username = req.user;
    if (userStatus[username] !== 'connected') {
        startWhatsApp(username);
    }
    res.json({ success: true });
});

app.post('/api/wa/logout', auth, async (req, res) => {
    const username = req.user;
    if (userSockets[username]) {
        await userSockets[username].logout();
        delete userSockets[username];
    }
    const sessionDir = path.join(SESSIONS_DIR, username);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    userStatus[username] = 'disconnected';
    userQRs[username] = null;
    res.json({ success: true });
});

// API: Validator
app.post('/api/wa/validate', auth, async (req, res) => {
    const { numbers } = req.body;
    const sock = userSockets[req.user];
    if (!sock || userStatus[req.user] !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp not connected' });
    }
    
    // Batch validation for speed
    const BATCH_SIZE = 5;
    const results = [];
    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
        const batch = numbers.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (num) => {
            try {
                const jid = num.includes('@s.whatsapp.net') ? num : `${num}@s.whatsapp.net`;
                const [result] = await sock.onWhatsApp(jid);
                return { number: num, valid: result?.exists || false, jid: result?.jid || null };
            } catch (e) {
                return { number: num, valid: false, error: e.message };
            }
        }));
        results.push(...batchResults);
    }
    res.json(results);
});

// API: Auto-reply Settings
app.get('/api/wa/auto-reply', auth, (req, res) => {
    const settingsFile = path.join(DATA_DIR, `${req.user}_settings.json`);
    if (fs.existsSync(settingsFile)) {
        res.json(JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
    } else {
        res.json({ autoReplyEnabled: false, globalReply: '', keywords: [] });
    }
});

app.post('/api/wa/auto-reply', auth, (req, res) => {
    const settingsFile = path.join(DATA_DIR, `${req.user}_settings.json`);
    fs.writeFileSync(settingsFile, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});

// Campaign Executor
async function runCampaign(username, campaignId) {
    const campaignFile = path.join(CAMPAIGNS_DIR, `${username}_${campaignId}.json`);
    if (!fs.existsSync(campaignFile)) return;
    
    const campaign = JSON.parse(fs.readFileSync(campaignFile, 'utf8'));
    if (campaign.status !== 'running') return;
    
    const sock = userSockets[username];
    if (!sock || userStatus[username] !== 'connected') {
        campaign.status = 'paused';
        fs.writeFileSync(campaignFile, JSON.stringify(campaign, null, 2));
        return;
    }
    
    const historyFile = path.join(HISTORY_DIR, `${username}_history.json`);
    let history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
    
    // Resume from current index
    const processNext = async () => {
        const currentData = JSON.parse(fs.readFileSync(campaignFile, 'utf8'));
        if (currentData.status !== 'running') return; // Stopped by user
        
        if (currentData.currentIndex >= currentData.contacts.length) {
            currentData.status = 'completed';
            fs.writeFileSync(campaignFile, JSON.stringify(currentData, null, 2));
            return;
        }
        
        const contact = currentData.contacts[currentData.currentIndex];
        let message = currentData.messageTemplate;
        
        // Template replacement
        for (let key in contact) {
            message = message.replace(new RegExp(`{{${key}}}`, 'gi'), contact[key] || '');
        }
        message = parseSpintax(message);

        // Ensure phone is clean (only digits)
        const cleanPhone = contact.phone.toString().replace(/\D/g, '');
        const jid = `${cleanPhone}@s.whatsapp.net`;
        
        // Re-verify socket for every message
        const currentSock = userSockets[username];
        if (!currentSock || userStatus[username] !== 'connected') {
            console.log(`Socket disconnected for ${username}, pausing campaign ${campaignId}`);
            currentData.status = 'paused';
            fs.writeFileSync(campaignFile, JSON.stringify(currentData, null, 2));
            return;
        }

        try {
            console.log(`[Campaign ${campaignId}] Sending to ${jid}...`);
            await currentSock.sendMessage(jid, { text: message });
            currentData.sent++;
            history.push({ to: contact.phone, status: 'sent', time: new Date().toISOString(), campaign: campaignId });
        } catch (err) {
            console.error(`[Campaign ${campaignId}] Send failed to ${jid}:`, err.message);
            currentData.failed++;
            const errReason = err.message || "Failed";
            const isBanned = errReason.toLowerCase().includes('403') || errReason.toLowerCase().includes('forbidden') || errReason.toLowerCase().includes('not-authorized') || errReason.toLowerCase().includes('closed');
            history.push({ 
                to: contact.phone, 
                status: isBanned ? 'BANNED' : 'failed', 
                reason: errReason,
                time: new Date().toISOString(), 
                campaign: campaignId 
            });
        }
        
        currentData.currentIndex++;
        fs.writeFileSync(campaignFile, JSON.stringify(currentData, null, 2));
        fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
        
        if (currentData.currentIndex < currentData.contacts.length) {
            const delayMs = Math.floor(Math.random() * (currentData.delayMax - currentData.delayMin + 1)) + currentData.delayMin;
            activeTimeouts[`${username}_${campaignId}`] = setTimeout(processNext, delayMs * 1000);
        } else {
            currentData.status = 'completed';
            fs.writeFileSync(campaignFile, JSON.stringify(currentData, null, 2));
        }
    };
    
    processNext();
}

// API: Campaign
app.post('/api/campaign/start', auth, (req, res) => {
    const username = req.user;
    const { contacts, messageTemplate, delayMin, delayMax } = req.body;
    
    const campaignId = Date.now().toString();
    const campaign = {
        id: campaignId,
        status: 'running', // running, paused, completed, stopped
        contacts,
        messageTemplate,
        delayMin: parseInt(delayMin) || 2,
        delayMax: parseInt(delayMax) || 5,
        currentIndex: 0,
        sent: 0,
        failed: 0,
        total: contacts.length,
        createdAt: new Date().toISOString()
    };
    
    const campaignFile = path.join(CAMPAIGNS_DIR, `${username}_${campaignId}.json`);
    fs.writeFileSync(campaignFile, JSON.stringify(campaign, null, 2));
    
    runCampaign(username, campaignId);
    res.json({ success: true, campaignId });
});

app.post('/api/campaign/action', auth, (req, res) => {
    const { campaignId, action } = req.body; // action: pause, resume, stop
    const username = req.user;
    const campaignFile = path.join(CAMPAIGNS_DIR, `${username}_${campaignId}.json`);
    
    if (fs.existsSync(campaignFile)) {
        const campaign = JSON.parse(fs.readFileSync(campaignFile, 'utf8'));
        if (action === 'resume') {
            campaign.status = 'running';
            fs.writeFileSync(campaignFile, JSON.stringify(campaign, null, 2));
            runCampaign(username, campaignId);
        } else {
            campaign.status = action === 'stop' ? 'stopped' : 'paused';
            fs.writeFileSync(campaignFile, JSON.stringify(campaign, null, 2));
            if (activeTimeouts[`${username}_${campaignId}`]) {
                clearTimeout(activeTimeouts[`${username}_${campaignId}`]);
            }
        }
        res.json({ success: true, status: campaign.status });
    } else {
        res.status(404).json({ error: 'Campaign not found' });
    }
});

app.get('/api/campaigns', auth, (req, res) => {
    const username = req.user;
    const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.startsWith(`${username}_`));
    const campaigns = files.map(f => {
        return JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, f), 'utf8'));
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(campaigns);
});

// API: Analytics
app.get('/api/analytics', auth, (req, res) => {
    const username = req.user;
    const historyFile = path.join(HISTORY_DIR, `${username}_history.json`);
    let history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8')) : [];
    
    const stats = {
        totalSent: history.filter(h => h.status === 'sent').length,
        totalFailed: history.filter(h => h.status === 'failed' || h.status === 'BANNED').length,
        totalBanned: history.filter(h => h.status === 'BANNED').length,
        history: history.slice(-100) // latest 100
    };
    res.json(stats);
});

// API: Chat History
app.get('/api/wa/chats', auth, (req, res) => {
    const chatHistoryFile = path.join(HISTORY_DIR, `${req.user}_chats.json`);
    if (fs.existsSync(chatHistoryFile)) {
        res.json(JSON.parse(fs.readFileSync(chatHistoryFile, 'utf8')));
    } else {
        res.json([]);
    }
});

// Self-ping for Render.com to keep alive
setInterval(() => {
    http.get(`http://localhost:${process.env.PORT || 3000}`);
}, 14 * 60 * 1000);

// Auto-resume Campaigns on startup after a delay to let sockets connect
setTimeout(() => {
    const campaignFiles = fs.readdirSync(CAMPAIGNS_DIR);
    campaignFiles.forEach(file => {
        try {
            const campaign = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, file), 'utf8'));
            if (campaign.status === 'running') {
                const username = file.split('_')[0];
                console.log(`Auto-resuming campaign ${campaign.id} for ${username}`);
                runCampaign(username, campaign.id);
            }
        } catch(e) {}
    });
}, 15000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
