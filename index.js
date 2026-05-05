const express = require('express');
const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const crypto = require('crypto');
const qrcode = require('qrcode');
const http = require('http');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://shreyadubey2508:shreyabhi2527@cluster0.tkef1eq.mongodb.net/myDB?retryWrites=true&w=majority";
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB Atlas'))
    .catch(err => console.error('MongoDB connection error:', err));

// Schemas
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, lowercase: true, trim: true },
    password: { type: String },
    token: { type: String }
});
const User = mongoose.model('User', UserSchema);

const CampaignSchema = new mongoose.Schema({
    username: String,
    id: String,
    status: String,
    contacts: Array,
    messageTemplate: String,
    delayMin: Number,
    delayMax: Number,
    currentIndex: Number,
    sent: Number,
    failed: Number,
    total: Number,
    createdAt: { type: Date, default: Date.now }
});
const Campaign = mongoose.model('Campaign', CampaignSchema);

const HistorySchema = new mongoose.Schema({
    username: String,
    to: String,
    status: String,
    reason: String,
    time: { type: Date, default: Date.now },
    campaign: String
});
const History = mongoose.model('History', HistorySchema);

const ChatSchema = new mongoose.Schema({
    username: String,
    from: String,
    pushName: String,
    text: String,
    time: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', ChatSchema);

const SettingsSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    autoReplyEnabled: { type: Boolean, default: false },
    globalReply: String,
    keywords: Array
});
const Settings = mongoose.model('Settings', SettingsSchema);

const SessionSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    data: String // JSON stringified auth state
});
const Session = mongoose.model('Session', SessionSchema);

// In-memory states (Transitory)
const userSockets = {};
const userQRs = {};
const userStatus = {};
const activeTimeouts = {};

// Utils
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

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

// Custom MongoDB Auth State for Baileys
async function useMongoDBAuthState(username) {
    const session = await Session.findOne({ username });
    let state = session ? JSON.parse(session.data) : null;

    // Helper to fix Buffer types after JSON stringify/parse
    const fixBuffers = (obj) => {
        if (!obj) return obj;
        if (typeof obj === 'object') {
            if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
                return Buffer.from(obj.data);
            }
            for (let key in obj) {
                obj[key] = fixBuffers(obj[key]);
            }
        }
        return obj;
    };

    state = fixBuffers(state);

    if (!state) {
        state = {
            creds: {
                signedIn: false,
                registrationId: Math.floor(Math.random() * 10000),
                advSecretKey: crypto.randomBytes(32).toString('base64'),
                nextPreKeyId: 1,
                firstUnuploadedPreKeyId: 1,
                accountSettings: { unarchiveChats: false },
                deviceId: crypto.randomBytes(8).toString('hex'),
                phoneId: crypto.randomBytes(16).toString('hex'),
                identityId: crypto.randomBytes(20),
                registered: false,
                backupToken: crypto.randomBytes(20),
                registration: {},
                pairingEphemeralKeyPair: {
                    public: crypto.randomBytes(32),
                    private: crypto.randomBytes(32)
                }
            },
            keys: {}
        };
    }

    const saveCreds = async () => {
        await Session.findOneAndUpdate(
            { username },
            { data: JSON.stringify(state) },
            { upsert: true }
        );
    };

    return {
        state: {
            creds: state.creds,
            keys: {
                get: (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        let value = state.keys[type]?.[id];
                        if (value) {
                            data[id] = fixBuffers(value);
                        }
                    }
                    return data;
                },
                set: (data) => {
                    for (const type in data) {
                        if (!state.keys[type]) state.keys[type] = {};
                        for (const id in data[type]) {
                            state.keys[type][id] = data[type][id];
                        }
                    }
                    saveCreds();
                }
            }
        },
        saveCreds
    };
}

// Initialize WhatsApp Session
async function startWhatsApp(username) {
    if (userSockets[username]) return; // Already running

    userStatus[username] = 'connecting';
    const { state, saveCreds } = await useMongoDBAuthState(username);
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
                await Session.deleteOne({ username });
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
                const chatMsg = {
                    username,
                    from: msg.key.remoteJid,
                    pushName: msg.pushName || 'Unknown',
                    text: msg.message.conversation || msg.message.extendedTextMessage?.text || "",
                };
                await new Chat(chatMsg).save();

                const settings = await Settings.findOne({ username });
                if (settings && settings.autoReplyEnabled) {
                    let replyText = settings.globalReply;
                    if (settings.keywords) {
                        for (let kw of settings.keywords) {
                            if (chatMsg.text.toLowerCase().includes(kw.word.toLowerCase())) {
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
    });

    userSockets[username] = sock;
}

// Middleware: Authentication
async function auth(req, res, next) {
    const token = req.headers['authorization'];
    const username = req.headers['x-username'] ? req.headers['x-username'].toLowerCase() : null;
    if (!username) return res.status(401).json({ error: 'Unauthorized' });

    const user = await User.findOne({ username, token });
    if (user) {
        req.user = username;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// API: Auth
app.post('/api/auth/register', async (req, res) => {
    let { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    username = username.toLowerCase().trim();

    try {
        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: 'User exists' });

        const newUser = new User({
            username,
            password: hashPassword(password),
            token: crypto.randomBytes(16).toString('hex')
        });
        await newUser.save();
        res.json({ token: newUser.token, username });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    let { username, password } = req.body;
    if (!username || !password) return res.status(401).json({ error: 'Invalid credentials' });
    username = username.toLowerCase().trim();

    try {
        const user = await User.findOne({ username });
        if (!user || user.password !== hashPassword(password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        user.token = crypto.randomBytes(16).toString('hex');
        await user.save();
        res.json({ token: user.token, username });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: WhatsApp Connection
app.get('/api/wa/status', auth, (req, res) => {
    res.json({
        status: userStatus[req.user] || 'disconnected',
        qr: userQRs[req.user] || null
    });
});

app.post('/api/wa/connect', auth, (req, res) => {
    if (userStatus[req.user] !== 'connected') {
        startWhatsApp(req.user);
    }
    res.json({ success: true });
});

app.post('/api/wa/logout', auth, async (req, res) => {
    if (userSockets[req.user]) {
        await userSockets[req.user].logout();
        delete userSockets[req.user];
    }
    await Session.deleteOne({ username: req.user });
    userStatus[req.user] = 'disconnected';
    userQRs[req.user] = null;
    res.json({ success: true });
});

// API: Validator
app.post('/api/wa/validate', auth, async (req, res) => {
    const { numbers } = req.body;
    const sock = userSockets[req.user];
    if (!sock || userStatus[req.user] !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp not connected' });
    }
    const BATCH_SIZE = 5;
    const results = [];
    for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
        const batch = numbers.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (num) => {
            try {
                const jid = num.includes('@s.whatsapp.net') ? num : `${num}@s.whatsapp.net`;
                const [result] = await sock.onWhatsApp(jid);
                return { number: num, valid: result?.exists || false, jid: result?.jid || null };
            } catch (e) { return { number: num, valid: false, error: e.message }; }
        }));
        results.push(...batchResults);
    }
    res.json(results);
});

// API: Auto-reply
app.get('/api/wa/auto-reply', auth, async (req, res) => {
    const settings = await Settings.findOne({ username: req.user });
    res.json(settings || { autoReplyEnabled: false, globalReply: '', keywords: [] });
});

app.post('/api/wa/auto-reply', auth, async (req, res) => {
    await Settings.findOneAndUpdate(
        { username: req.user },
        { ...req.body, username: req.user },
        { upsert: true }
    );
    res.json({ success: true });
});

// Campaign Executor
async function runCampaign(username, campaignId) {
    const campaign = await Campaign.findOne({ username, id: campaignId });
    if (!campaign || campaign.status !== 'running') return;

    const sock = userSockets[username];
    if (!sock || userStatus[username] !== 'connected') {
        campaign.status = 'paused';
        await campaign.save();
        return;
    }

    const processNext = async () => {
        const currentData = await Campaign.findOne({ username, id: campaignId });
        if (!currentData || currentData.status !== 'running') return;

        if (currentData.currentIndex >= currentData.contacts.length) {
            currentData.status = 'completed';
            await currentData.save();
            return;
        }

        const contact = currentData.contacts[currentData.currentIndex];
        let message = currentData.messageTemplate;
        for (let key in contact) {
            message = message.replace(new RegExp(`{{${key}}}`, 'gi'), contact[key] || '');
        }
        message = parseSpintax(message);

        const jid = `${contact.phone.toString().replace(/\D/g, '')}@s.whatsapp.net`;
        const currentSock = userSockets[username];
        if (!currentSock || userStatus[username] !== 'connected') {
            currentData.status = 'paused';
            await currentData.save();
            return;
        }

        try {
            await currentSock.sendMessage(jid, { text: message });
            currentData.sent++;
            await new History({ username, to: contact.phone, status: 'sent', campaign: campaignId }).save();
        } catch (err) {
            currentData.failed++;
            const errReason = err.message || "Failed";
            const isBanned = errReason.toLowerCase().includes('403') || errReason.toLowerCase().includes('forbidden');
            await new History({
                username, to: contact.phone,
                status: isBanned ? 'BANNED' : 'failed',
                reason: errReason, campaign: campaignId
            }).save();
        }

        currentData.currentIndex++;
        await currentData.save();

        if (currentData.currentIndex < currentData.contacts.length) {
            const delayMs = Math.floor(Math.random() * (currentData.delayMax - currentData.delayMin + 1)) + currentData.delayMin;
            activeTimeouts[`${username}_${campaignId}`] = setTimeout(processNext, delayMs * 1000);
        } else {
            currentData.status = 'completed';
            await currentData.save();
        }
    };
    processNext();
}

app.post('/api/campaign/start', auth, async (req, res) => {
    const campaignId = Date.now().toString();
    const campaign = new Campaign({
        username: req.user,
        id: campaignId,
        status: 'running',
        ...req.body,
        currentIndex: 0, sent: 0, failed: 0,
        total: req.body.contacts.length
    });
    await campaign.save();
    runCampaign(req.user, campaignId);
    res.json({ success: true, campaignId });
});

app.post('/api/campaign/action', auth, async (req, res) => {
    const { campaignId, action } = req.body;
    const campaign = await Campaign.findOne({ username: req.user, id: campaignId });
    if (campaign) {
        if (action === 'resume') {
            campaign.status = 'running';
            await campaign.save();
            runCampaign(req.user, campaignId);
        } else {
            campaign.status = action === 'stop' ? 'stopped' : 'paused';
            await campaign.save();
            if (activeTimeouts[`${req.user}_${campaignId}`]) clearTimeout(activeTimeouts[`${req.user}_${campaignId}`]);
        }
        res.json({ success: true, status: campaign.status });
    } else { res.status(404).json({ error: 'Campaign not found' }); }
});

app.get('/api/campaigns', auth, async (req, res) => {
    const campaigns = await Campaign.find({ username: req.user }).sort({ createdAt: -1 });
    res.json(campaigns);
});

app.get('/api/analytics', auth, async (req, res) => {
    const history = await History.find({ username: req.user });
    const stats = {
        totalSent: history.filter(h => h.status === 'sent').length,
        totalFailed: history.filter(h => h.status === 'failed' || h.status === 'BANNED').length,
        totalBanned: history.filter(h => h.status === 'BANNED').length,
        history: history.slice(-100)
    };
    res.json(stats);
});

app.get('/api/wa/chats', auth, async (req, res) => {
    const chats = await Chat.find({ username: req.user }).sort({ time: -1 }).limit(100);
    res.json(chats);
});

// Self-ping
setInterval(() => { http.get(`http://localhost:${process.env.PORT || 3000}`); }, 14 * 60 * 1000);

// Auto-resume on startup
mongoose.connection.once('open', async () => {
    console.log('Auto-resuming campaigns and sessions...');
    const campaigns = await Campaign.find({ status: 'running' });
    for (const c of campaigns) {
        startWhatsApp(c.username);
        setTimeout(() => runCampaign(c.username, c.id), 15000);
    }
    const sessions = await Session.find({});
    for (const s of sessions) {
        startWhatsApp(s.username);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
