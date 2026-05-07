const mongoose = require('mongoose');
const { makeWASocket, fetchLatestBaileysVersion, initAuthCreds } = require('@whiskeysockets/baileys');
const crypto = require('crypto');

const SessionSchema = new mongoose.Schema({ username: String, data: String });
const Session = mongoose.model('SessionTest2', SessionSchema);

async function useMongoDBAuthState(username) {
    const session = await Session.findOne({ username });
    let state = session ? JSON.parse(session.data) : null;

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
            creds: initAuthCreds(),
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

async function run() {
    await mongoose.connect("mongodb+srv://shreyadubey2508:shreyabhi2527@cluster0.tkef1eq.mongodb.net/myDB?retryWrites=true&w=majority");
    await Session.deleteMany({}); // clear past tests
    const { state, saveCreds } = await useMongoDBAuthState('testqruser');
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true
    });
    
    sock.ev.on('connection.update', (update) => {
        console.log('Update:', update);
        if (update.qr) {
            console.log('SUCCESS: QR Code generated!');
            process.exit(0);
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
