const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app = express();
app.use(cors());

// Sağlık / ön-uyandırma endpoint'i
app.get('/', (req, res) => {
    res.send('PLAY LEGENDS Server is Active! / PLAY LEGENDS Sunucusu Aktif!');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

// Aktif lobi odaları: { [code]: roomObject }
let activeRooms = {};

// Lobi dünyası geçici deposu: { [code]: worldData }
let worldStore = {};

// Boş oda zamanlayıcıları: { [code]: timeoutId }
let emptyTimers = {};

const EMPTY_ROOM_TTL = 5 * 60 * 1000; // 5 dakika kimse yoksa kapat

function scheduleEmptyClose(code) {
    if (emptyTimers[code]) clearTimeout(emptyTimers[code]);

    emptyTimers[code] = setTimeout(() => {
        if (activeRooms[code]) {
            const connected = io.sockets.adapter.rooms.get(code);
            const count = connected ? connected.size : 0;
            if (count === 0) {
                console.log(`[LOBBY] Boş oda kapatıldı (5 dakika kimse girmedi): ${code}`);
                delete activeRooms[code];
                delete worldStore[code];
            }
        }
        delete emptyTimers[code];
    }, EMPTY_ROOM_TTL);
}

function cancelEmptyClose(code) {
    if (emptyTimers[code]) {
        clearTimeout(emptyTimers[code]);
        delete emptyTimers[code];
    }
}

io.on('connection', (socket) => {
    console.log(`[+] Bağlandı: ${socket.id}`);

    // 1. lobby:list → tüm açık odaları döner
    socket.on('lobby:list', () => {
        const rooms = Object.values(activeRooms).filter(r => r.status === 'open');
        socket.emit('lobby:list:response', rooms);
    });

    // 2. lobby:create → yeni sunucu kaydı oluştur
    socket.on('lobby:create', (cfg) => {
        if (!cfg || !cfg.code) {
            return socket.emit('lobby:create:response', { success: false, error: 'Geçersiz yapılandırma.' });
        }

        activeRooms[cfg.code] = {
            code:         cfg.code,
            name:         cfg.name       || ('Server_' + cfg.code),
            host:         cfg.host       || 'Unknown',
            hostSocketId: socket.id,
            seed:         cfg.seed       || '0',
            worldType:    cfg.worldType  || 'infinite',
            gameMode:     cfg.gameMode   || 'survival',
            difficulty:   cfg.difficulty || 'normal',
            access:       cfg.access     || 'public',
            cheats:       cfg.cheats     || false,
            pvp:          cfg.pvp        || true,
            players:      cfg.players    || 1,
            maxPlayers:   cfg.maxPlayers || 20,
            status:       'open',
            createdAt:    Date.now()
        };

        socket.join(cfg.code);
        console.log(`[LOBBY] Oda oluşturuldu: ${cfg.code} — ${activeRooms[cfg.code].name}`);
        socket.emit('lobby:create:response', { success: true, code: cfg.code });

        // Hiç kimse girmezse 5 dakika sonra kapat
        scheduleEmptyClose(cfg.code);
    });

    // 3. lobby:update → oyuncu sayısı / durum güncelle
    socket.on('lobby:update', ({ code, players, status }) => {
        if (activeRooms[code]) {
            if (players !== undefined) activeRooms[code].players = players;
            if (status  !== undefined) activeRooms[code].status  = status;

            // Odada artık oyuncu var → zamanlayıcıyı iptal et
            const connected = io.sockets.adapter.rooms.get(code);
            const count = connected ? connected.size : 0;
            if (count > 0) cancelEmptyClose(code);

            console.log(`[LOBBY] Güncellendi: ${code} → oyuncular=${players}, durum=${status}`);
        }
    });

    // 4. lobby:load-world → kayıtlı dünya ile sunucu aç
    socket.on('lobby:load-world', ({ code, host, worldData, gameMode, worldType }) => {
        if (!code || !worldData) {
            return socket.emit('lobby:load-world:response', { success: false, error: 'Eksik veri.' });
        }

        worldStore[code] = worldData;

        activeRooms[code] = {
            code,
            name:         (host || 'Host') + "'s World",
            host:         host || 'Unknown',
            hostSocketId: socket.id,
            worldType:    worldType || 'infinite',
            gameMode:     gameMode  || 'survival',
            difficulty:   'normal',
            access:       'public',
            cheats:       false,
            pvp:          true,
            players:      1,
            maxPlayers:   20,
            status:       'open',
            createdAt:    Date.now()
        };

        socket.join(code);
        console.log(`[LOBBY] Dünya yüklendi: ${code} — host: ${host}`);
        socket.emit('lobby:load-world:response', { success: true, code });

        // Hiç kimse girmezse 5 dakika sonra kapat
        scheduleEmptyClose(code);
    });

    // 5. Bağlantı kopunca odayı temizle
    socket.on('disconnect', () => {
        console.log(`[-] Ayrıldı: ${socket.id}`);

        Object.keys(activeRooms).forEach(code => {
            if (activeRooms[code].hostSocketId === socket.id) {
                // Host ayrıldı → odayı hemen kapat
                console.log(`[LOBBY] Host ayrıldı, oda kapatıldı: ${code}`);
                cancelEmptyClose(code);
                delete activeRooms[code];
                delete worldStore[code];
            } else {
                // Normal oyuncu ayrıldı → oda boş kaldıysa sayaç başlat
                const connected = io.sockets.adapter.rooms.get(code);
                const count = connected ? connected.size : 0;
                if (count === 0) {
                    console.log(`[LOBBY] Oda boşaldı, 5dk sonra kapanacak: ${code}`);
                    scheduleEmptyClose(code);
                }
            }
        });
    });
});

// Eski/atık odaları temizle (2 saatten eski)
setInterval(() => {
    const now = Date.now();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    Object.keys(activeRooms).forEach(code => {
        if (now - activeRooms[code].createdAt > TWO_HOURS) {
            console.log(`[LOBBY] 2 saat doldu, temizlendi: ${code}`);
            cancelEmptyClose(code);
            delete activeRooms[code];
            delete worldStore[code];
        }
    });
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`PLAY LEGENDS Backend — port ${PORT} üzerinde çalışıyor`);
});
