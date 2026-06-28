// ════════════════════════════════════════════════════════════════════════════
//  PLAY LEGENDS  –  server.js  (Dedicated Server Mimarisi v1.6.3)
//  ─────────────────────────────────────────────────────────────────────────
//  TEMEL FELSEFE:
//    • Odalar "adanmış sunucu" (dedicated server) olarak çalışır.
//    • Hiçbir oyuncuya "host" rolü verilmez; lobby:you-are-host / host-migrated YOK.
//    • Oda kurucusu ayrılsa bile oda YAŞAMAYA DEVAM EDER.
//    • Oda yalnızca şu durumlarda kapanır:
//        – Boş kalma süresi (EMPTY_ROOM_TTL) dolduğunda
//        – Oda sahibi (creator) sunucuyu açıkça kapattığında (lobby:close)
//        – 2 saatlik mutlak ömür sona erdiğinde
//    • Yetki sistemi: OP listesi sunucuda tutulur.
//
//  v1.6.3 EK ÖZELLİKLER:
//    • roomPublicInfo → creatorName düzgün gönderilir ("Unknown" yazma hatası giderildi)
//    • /setworldspawn → server.js üzerinden tüm odaya yayılır
//    • chat:message → server relay ile tüm odaya iletilir, rank/skin de taşınır
//    • skin:sync   → server relay (Socket.io üzerinden P2P'siz skin senkronizasyonu)
//    • rank:sync   → server relay (oyuncu rank/color bilgisi tüm odaya)
//    • Sunucu adı: *red* *glow* gibi etiketlere izin verilir (whitelist değil blacklist)
//    • Host alanı browse listesinde doğru creatorName ile gönderilir
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');

const app = express();
app.use(cors());

// ── Sağlık / ön-uyandırma endpoint'i ──────────────────────────────────────
app.get('/', (_req, res) => {
    res.send('PLAY LEGENDS Dedicated Server is Active! / Adanmış Sunucu Aktif!');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

// ══════════════════════════════════════════════════════════════════════════
//  VERİ YAPILARI
// ══════════════════════════════════════════════════════════════════════════

/**
 * activeRooms[code] = {
 *   code             : string
 *   name             : string       – görünen sunucu adı (*red* *glow* gibi tag'lere izin verilir)
 *   creatorName      : string       – kurucu oyuncu adı
 *   creatorSocketId  : string|null
 *   seed             : string
 *   worldType        : string
 *   gameMode         : string
 *   difficulty       : string
 *   access           : 'public'|'private'|'registered'
 *   cheats           : boolean
 *   pvp              : boolean
 *   players          : number
 *   maxPlayers       : number
 *   status           : 'open'|'closed'
 *   createdAt        : number
 *   worldSpawn       : {x,y,z}|null
 *   ops              : Set<string>
 *   bannedPlayers    : Set<string>
 *   connectedPlayers : Map<socketId, {username, rank, rankColor, joinedAt, skinB64?}>
 * }
 */
const activeRooms = {};
const worldStore  = {};
const emptyTimers = {};

// ── Sabitler ──────────────────────────────────────────────────────────────
const EMPTY_ROOM_TTL   = 5  * 60 * 1000;   // 5 dk boş → kapat
const MAX_ROOM_AGE     = 2  * 60 * 60 * 1000; // 2 saat mutlak ömür
const CLEANUP_INTERVAL = 30 * 60 * 1000;   // 30 dk'da bir temizlik

// Sunucu adında yasak kelimeler (kötüye kullanımı engelle – minimal liste)
const SERVER_NAME_BLACKLIST = [/<script/i, /javascript:/i, /on\w+\s*=/i];

function sanitizeServerName(name) {
    if (!name || typeof name !== 'string') return 'Server';
    // XSS koruma: script tag'leri engelle ama *red* *glow* gibi game tag'lerine dokunma
    for (const re of SERVER_NAME_BLACKLIST) {
        if (re.test(name)) return 'Server';
    }
    return name.trim().substring(0, 48) || 'Server';
}

// ══════════════════════════════════════════════════════════════════════════
//  YARDIMCI FONKSİYONLAR
// ══════════════════════════════════════════════════════════════════════════

function scheduleEmptyClose(code) {
    if (emptyTimers[code]) clearTimeout(emptyTimers[code]);
    emptyTimers[code] = setTimeout(() => {
        delete emptyTimers[code];
        if (!activeRooms[code]) return;
        const socketRoom = io.sockets.adapter.rooms.get(code);
        const count = socketRoom ? socketRoom.size : 0;
        if (count === 0) {
            console.log(`[SERVER] Boş oda kapatıldı (${EMPTY_ROOM_TTL / 60000} dk): ${code}`);
            _destroyRoom(code);
        } else {
            cancelEmptyClose(code);
        }
    }, EMPTY_ROOM_TTL);
}

function cancelEmptyClose(code) {
    if (emptyTimers[code]) { clearTimeout(emptyTimers[code]); delete emptyTimers[code]; }
}

function _destroyRoom(code) {
    cancelEmptyClose(code);
    delete activeRooms[code];
    delete worldStore[code];
}

function syncPlayerCount(code) {
    const room = activeRooms[code];
    if (!room) return 0;
    const socketRoom = io.sockets.adapter.rooms.get(code);
    const count = socketRoom ? socketRoom.size : 0;
    room.players = count;
    return count;
}

function isOp(code, username) {
    const room = activeRooms[code];
    if (!room || !username) return false;
    return room.ops.has(username.trim().toLowerCase());
}

function isBanned(code, username) {
    const room = activeRooms[code];
    if (!room || !username) return false;
    return room.bannedPlayers.has(username.trim().toLowerCase());
}

/**
 * FIX: Host alanı creatorName ile doldurulur — "Unknown" yazılmaz.
 */
function roomPublicInfo(room) {
    return {
        code:        room.code,
        name:        room.name,
        creatorName: room.creatorName,
        host:        room.creatorName,   // ← FIX: browse listesi "Host: creatorName" gösterir
        seed:        room.seed,
        worldType:   room.worldType,
        gameMode:    room.gameMode,
        difficulty:  room.difficulty,
        access:      room.access,
        cheats:      room.cheats,
        pvp:         room.pvp,
        players:     room.players,
        maxPlayers:  room.maxPlayers,
        status:      room.status,
        createdAt:   room.createdAt,
        worldSpawn:  room.worldSpawn || null
    };
}

/** Odadaki tüm oyuncuların basit listesini döndürür (TAB senkronizasyonu için) */
function roomPlayerList(room) {
    const list = [];
    for (const [sid, data] of room.connectedPlayers) {
        list.push({
            socketId:  sid,
            username:  data.username,
            rank:      data.rank      || null,
            rankColor: data.rankColor || null,
            isOp:      room.ops.has((data.username || '').toLowerCase()),
            joinedAt:  data.joinedAt
        });
    }
    return list;
}

// ══════════════════════════════════════════════════════════════════════════
//  SOCKET.IO BAĞLANTI MANTIĞI
// ══════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
    console.log(`[+] Bağlandı: ${socket.id}`);

    socket.data.roomCode = null;
    socket.data.username = null;

    // ─────────────────────────────────────────────────────────────────────
    // 1. lobby:list  →  Açık odaları listele
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:list', () => {
        const rooms = Object.values(activeRooms)
            .filter(r => r.status === 'open' && r.access === 'public')
            .map(roomPublicInfo);
        socket.emit('lobby:list:response', rooms);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 2. lobby:create  →  Yeni dedicated sunucu oluştur
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:create', (cfg) => {
        if (!cfg || !cfg.code) {
            return socket.emit('lobby:create:response', { success: false, error: 'Geçersiz yapılandırma.' });
        }
        if (activeRooms[cfg.code]) {
            return socket.emit('lobby:create:response', { success: false, error: 'Bu kod zaten kullanımda.' });
        }

        const creatorName = (cfg.host || cfg.creatorName || 'Player').trim();
        const serverName  = sanitizeServerName(cfg.name || ('Server_' + cfg.code));

        activeRooms[cfg.code] = {
            code:             cfg.code,
            name:             serverName,
            creatorName,
            creatorSocketId:  socket.id,
            seed:             cfg.seed        || '0',
            worldType:        cfg.worldType   || 'infinite',
            gameMode:         cfg.gameMode    || 'survival',
            difficulty:       cfg.difficulty  || 'normal',
            access:           cfg.access      || 'public',
            cheats:           cfg.cheats      || false,
            pvp:              cfg.pvp !== undefined ? cfg.pvp : true,
            players:          1,
            maxPlayers:       cfg.maxPlayers  || 20,
            status:           'open',
            createdAt:        Date.now(),
            worldSpawn:       null,
            ops:              new Set(),
            bannedPlayers:    new Set(),
            connectedPlayers: new Map()
        };

        socket.join(cfg.code);
        socket.data.roomCode = cfg.code;
        socket.data.username = creatorName;

        activeRooms[cfg.code].connectedPlayers.set(socket.id, {
            username:  creatorName,
            rank:      cfg.rank      || null,
            rankColor: cfg.rankColor || null,
            joinedAt:  Date.now()
        });

        console.log(`[SERVER] Oda oluşturuldu: ${cfg.code} — "${serverName}" (kurucu: ${creatorName})`);
        socket.emit('lobby:create:response', { success: true, code: cfg.code });
        scheduleEmptyClose(cfg.code);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 3. lobby:update  →  Oda meta verisini güncelle
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:update', ({ code, players, status, name, maxPlayers, access, pvp, cheats, gameMode }) => {
        const room = activeRooms[code];
        if (!room) return;

        if (players    !== undefined) room.players    = players;
        if (status     !== undefined) room.status     = status;
        if (name       !== undefined) room.name       = sanitizeServerName(name);
        if (maxPlayers !== undefined) room.maxPlayers = maxPlayers;
        if (access     !== undefined) room.access     = access;
        if (pvp        !== undefined) room.pvp        = pvp;
        if (cheats     !== undefined) room.cheats     = cheats;
        if (gameMode   !== undefined) room.gameMode   = gameMode;

        const liveCount = syncPlayerCount(code);
        if (liveCount > 0) cancelEmptyClose(code);

        console.log(`[SERVER] Güncellendi: ${code} — oyuncu=${room.players}, durum=${room.status}`);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 4. lobby:load-world  →  Kayıtlı dünyayı yükleyerek sunucu aç
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:load-world', ({ code, host, worldData, gameMode, worldType, name, maxPlayers }) => {
        if (!code || !worldData) {
            return socket.emit('lobby:load-world:response', { success: false, error: 'Eksik veri.' });
        }
        if (activeRooms[code]) {
            return socket.emit('lobby:load-world:response', { success: false, error: 'Bu kod zaten kullanımda.' });
        }

        worldStore[code] = worldData;
        const creatorName = (host || 'Player').trim();
        const serverName  = sanitizeServerName(name || worldData.name || creatorName + "'s World");

        activeRooms[code] = {
            code,
            name:             serverName,
            creatorName,
            creatorSocketId:  socket.id,
            seed:             worldData.seed      || '0',
            worldType:        worldType || worldData.worldType || 'infinite',
            gameMode:         gameMode  || worldData.mode      || 'survival',
            difficulty:       worldData.difficulty || 'normal',
            access:           worldData.access     || 'public',
            cheats:           worldData.cheats     || false,
            pvp:              worldData.pvp !== undefined ? worldData.pvp : true,
            players:          1,
            maxPlayers:       maxPlayers || worldData.maxPlayers || 20,
            status:           'open',
            createdAt:        Date.now(),
            worldSpawn:       worldData.worldSpawn || null,
            ops:              new Set(Array.isArray(worldData.admins) ? worldData.admins.map(n => n.toLowerCase()) : []),
            bannedPlayers:    new Set(Array.isArray(worldData.bannedPlayers) ? worldData.bannedPlayers.map(n => n.toLowerCase()) : []),
            connectedPlayers: new Map()
        };

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.username = creatorName;

        activeRooms[code].connectedPlayers.set(socket.id, {
            username:  creatorName,
            rank:      null,
            rankColor: null,
            joinedAt:  Date.now()
        });

        console.log(`[SERVER] Dünya yüklendi: ${code} — kurucu: ${creatorName} — isim: "${serverName}"`);
        socket.emit('lobby:load-world:response', { success: true, code });
        scheduleEmptyClose(code);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 5. lobby:join  →  Oyuncu odaya katılıyor
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:join', ({ code, username, rank, rankColor }) => {
        const room = activeRooms[code];
        if (!room) {
            return socket.emit('lobby:join:response', { success: false, error: 'Oda bulunamadı.' });
        }
        if (room.status !== 'open') {
            return socket.emit('lobby:join:response', { success: false, error: 'Sunucu kapalı.' });
        }

        const uname = (username || 'Player').trim();

        if (isBanned(code, uname)) {
            return socket.emit('lobby:join:response', { success: false, error: 'Bu sunucudan banlandınız.' });
        }

        const liveCount = syncPlayerCount(code);
        if (liveCount >= room.maxPlayers) {
            return socket.emit('lobby:join:response', { success: false, error: 'Sunucu dolu.' });
        }

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.username = uname;

        const playerEntry = {
            username:  uname,
            rank:      rank      || null,
            rankColor: rankColor || null,
            joinedAt:  Date.now()
        };
        room.connectedPlayers.set(socket.id, playerEntry);
        syncPlayerCount(code);
        cancelEmptyClose(code);

        const opStatus = isOp(code, uname);
        console.log(`[SERVER] Oyuncu katıldı: ${uname} → oda ${code} (OP: ${opStatus})`);

        socket.emit('lobby:join:response', {
            success:    true,
            code,
            isOp:       opStatus,
            worldSpawn: room.worldSpawn || null,
            roomInfo:   roomPublicInfo(room),
            playerList: roomPlayerList(room)
        });

        // Odadaki herkese yeni oyuncu bildir
        socket.to(code).emit('server:player-joined', {
            username:  uname,
            socketId:  socket.id,
            rank:      rank      || null,
            rankColor: rankColor || null,
            isOp:      opStatus,
            players:   room.players
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 6. lobby:register-player  →  Mevcut flow uyumluluğu
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:register-player', ({ code, username }) => {
        const room = activeRooms[code];
        if (!room) return;

        const uname = (username || socket.data.username || 'Player').trim();
        socket.data.username = uname;

        if (!room.connectedPlayers.has(socket.id)) {
            room.connectedPlayers.set(socket.id, { username: uname, rank: null, rankColor: null, joinedAt: Date.now() });
        }

        syncPlayerCount(code);
        cancelEmptyClose(code);

        socket.emit('server:your-status', { isOp: isOp(code, uname), username: uname });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 7. server:op-add
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:op-add', ({ code, targetUsername, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const isCreator     = room.creatorSocketId === socket.id;
        const requesterIsOp = isOp(code, requestedBy || socket.data.username);

        if (!isCreator && !requesterIsOp) {
            return socket.emit('server:op-add:response', { success: false, error: 'Yetkiniz yok.' });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        if (!target) return;
        room.ops.add(target);
        console.log(`[OP] ${target} → oda ${code} OP yapıldı`);
        socket.emit('server:op-add:response', { success: true, username: target });

        for (const [sid, data] of room.connectedPlayers) {
            if (data.username.trim().toLowerCase() === target) {
                const ts = io.sockets.sockets.get(sid);
                if (ts) {
                    ts.emit('server:your-status', { isOp: true, username: data.username });
                    ts.emit('server:system-message', { msgTR: '⭐ OP yetkiniz aktifleştirildi.', msgEN: '⭐ You have been granted OP.' });
                }
            }
        }
        io.to(code).emit('server:op-granted', { username: targetUsername, msgTR: `⭐ ${targetUsername} OP yapıldı.`, msgEN: `⭐ ${targetUsername} granted OP.` });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 8. server:op-remove
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:op-remove', ({ code, targetUsername, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const isCreator     = room.creatorSocketId === socket.id;
        const requesterIsOp = isOp(code, requestedBy || socket.data.username);

        if (!isCreator && !requesterIsOp) {
            return socket.emit('server:op-remove:response', { success: false, error: 'Yetkiniz yok.' });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        room.ops.delete(target);
        console.log(`[OP] ${target} → oda ${code} OP yetkisi alındı`);
        socket.emit('server:op-remove:response', { success: true, username: target });

        for (const [sid, data] of room.connectedPlayers) {
            if (data.username.trim().toLowerCase() === target) {
                const ts = io.sockets.sockets.get(sid);
                if (ts) {
                    ts.emit('server:your-status', { isOp: false, username: data.username });
                    ts.emit('server:system-message', { msgTR: '❌ OP yetkiniz alındı.', msgEN: '❌ Your OP status was removed.' });
                }
            }
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    // 9. server:kick
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:kick', ({ code, targetUsername, reason, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        if (!isOp(code, requester) && room.creatorSocketId !== socket.id) {
            return socket.emit('server:action:response', { success: false, error: 'OP yetkisi gerekli.' });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        let kicked = false;

        for (const [sid, data] of room.connectedPlayers) {
            if (data.username.trim().toLowerCase() === target) {
                const ts = io.sockets.sockets.get(sid);
                if (ts) {
                    ts.emit('server:kicked', { reason: reason || '', msgTR: `Sunucudan atıldınız. Sebep: ${reason || 'Belirtilmedi'}`, msgEN: `Kicked. Reason: ${reason || 'Not specified'}` });
                    ts.leave(code);
                    room.connectedPlayers.delete(sid);
                    kicked = true;
                }
                break;
            }
        }

        if (kicked) {
            syncPlayerCount(code);
            console.log(`[KICK] ${target} → oda ${code}`);
            io.to(code).emit('server:system-message', { msgTR: `🥾 ${targetUsername} atıldı.`, msgEN: `🥾 ${targetUsername} was kicked.` });
        }
        socket.emit('server:action:response', { success: kicked, action: 'kick', target: targetUsername });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 10. server:ban
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:ban', ({ code, targetUsername, reason, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        if (!isOp(code, requester) && room.creatorSocketId !== socket.id) {
            return socket.emit('server:action:response', { success: false, error: 'OP yetkisi gerekli.' });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        room.bannedPlayers.add(target);

        for (const [sid, data] of room.connectedPlayers) {
            if (data.username.trim().toLowerCase() === target) {
                const ts = io.sockets.sockets.get(sid);
                if (ts) {
                    ts.emit('server:banned', { reason: reason || '', msgTR: `Banlandınız. Sebep: ${reason || 'Belirtilmedi'}`, msgEN: `Banned. Reason: ${reason || 'Not specified'}` });
                    ts.leave(code);
                    room.connectedPlayers.delete(sid);
                }
                break;
            }
        }

        syncPlayerCount(code);
        console.log(`[BAN] ${target} → oda ${code}`);
        io.to(code).emit('server:system-message', { msgTR: `🔨 ${targetUsername} banlandı.`, msgEN: `🔨 ${targetUsername} was banned.` });
        socket.emit('server:action:response', { success: true, action: 'ban', target: targetUsername });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 11. server:unban
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:unban', ({ code, targetUsername, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        if (!isOp(code, requester) && room.creatorSocketId !== socket.id) {
            return socket.emit('server:action:response', { success: false, error: 'OP yetkisi gerekli.' });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        room.bannedPlayers.delete(target);
        console.log(`[UNBAN] ${target} → oda ${code}`);
        socket.emit('server:action:response', { success: true, action: 'unban', target: targetUsername });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 12. server:command  →  Genel sunucu komutu
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:command', ({ code, command, args, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        const isCreator = room.creatorSocketId === socket.id;
        const hasOp     = isOp(code, requester);

        if (!isCreator && !hasOp) {
            return socket.emit('server:command:response', { success: false, error: 'OP yetkisi gerekli.' });
        }

        switch ((command || '').toLowerCase()) {
            case 'gamemode': {
                const mode = (args && args[0]) || 'survival';
                room.gameMode = mode;
                io.to(code).emit('server:setting-changed', { key: 'gameMode', value: mode });
                console.log(`[CMD] ${code} → gameMode = ${mode}`);
                break;
            }
            case 'difficulty': {
                const diff = (args && args[0]) || 'normal';
                room.difficulty = diff;
                io.to(code).emit('server:setting-changed', { key: 'difficulty', value: diff });
                console.log(`[CMD] ${code} → difficulty = ${diff}`);
                break;
            }
            case 'pvp': {
                const pvpVal = args && args[0] !== undefined ? Boolean(args[0]) : !room.pvp;
                room.pvp = pvpVal;
                io.to(code).emit('server:setting-changed', { key: 'pvp', value: pvpVal });
                break;
            }
            case 'cheats': {
                const cheatVal = args && args[0] !== undefined ? Boolean(args[0]) : !room.cheats;
                room.cheats = cheatVal;
                io.to(code).emit('server:setting-changed', { key: 'cheats', value: cheatVal });
                break;
            }
            case 'close': {
                if (!isCreator) {
                    return socket.emit('server:command:response', { success: false, error: 'Sadece oda kurucusu kapatabilir.' });
                }
                room.status = 'closed';
                io.to(code).emit('server:closed', { msgTR: '🔴 Sunucu kapatıldı.', msgEN: '🔴 Server has been closed.' });
                console.log(`[CMD] ${code} → sunucu kapatıldı`);
                _destroyRoom(code);
                return socket.emit('server:command:response', { success: true, command: 'close' });
            }
            default:
                return socket.emit('server:command:response', { success: false, error: `Bilinmeyen komut: ${command}` });
        }
        socket.emit('server:command:response', { success: true, command, args });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 13. server:setworldspawn  →  Dünya doğum noktasını kaydet ve yay
    //     FIX: Sunucu oda nesnesinde tutar, ölen/yeni giren herkes bu koordinatta doğar.
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:setworldspawn', ({ code, x, y, z, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        const isCreator = room.creatorSocketId === socket.id;
        const hasOp     = isOp(code, requester);

        if (!isCreator && !hasOp) {
            return socket.emit('server:setworldspawn:response', { success: false, error: 'OP yetkisi gerekli.' });
        }

        const spawnX = parseFloat(x) || 8;
        const spawnY = parseFloat(y) || 10;
        const spawnZ = parseFloat(z) || 8;

        room.worldSpawn = { x: spawnX, y: spawnY, z: spawnZ };
        console.log(`[SPAWN] ${code} → worldSpawn: ${JSON.stringify(room.worldSpawn)} (${requester})`);

        const msgTR = `✅ Dünya doğum noktası ayarlandı: [${Math.round(spawnX)}, ${Math.round(spawnY)}, ${Math.round(spawnZ)}]`;
        const msgEN = `✅ World spawn set: [${Math.round(spawnX)}, ${Math.round(spawnY)}, ${Math.round(spawnZ)}]`;

        // TÜM odaya yay: hem spawn güncellemesi hem chat bildirimi
        io.to(code).emit('server:worldspawn-updated', { x: spawnX, y: spawnY, z: spawnZ, msgTR, msgEN });
        socket.emit('server:setworldspawn:response', { success: true, x: spawnX, y: spawnY, z: spawnZ });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 14. chat:message  →  Sunucu üzerinden chat iletimi (Socket.io relay)
    //     FIX: P2P yerine sunucu relay — tüm odaya dağıtılır.
    // ─────────────────────────────────────────────────────────────────────
    socket.on('chat:message', ({ code, username, rank, rankColor, message }) => {
        const room = activeRooms[code];
        if (!room) return;

        const uname   = (username  || socket.data.username || 'Player').trim().substring(0, 24);
        const safeMsg = (message   || '').substring(0, 256);
        const safeRnk = (rank      || null);
        const safeClr = (rankColor || null);

        // Rate limit: basit - bağlı oyuncu başına 1 saniyede max 5 mesaj
        const playerData = room.connectedPlayers.get(socket.id);
        if (playerData) {
            const now = Date.now();
            if (!playerData._chatTs) playerData._chatTs = [];
            playerData._chatTs = playerData._chatTs.filter(t => now - t < 1000);
            if (playerData._chatTs.length >= 5) return; // rate limit
            playerData._chatTs.push(now);
        }

        // Odadaki herkese (gönderen dahil) yay
        io.to(code).emit('chat:message', {
            username:  uname,
            rank:      safeRnk,
            rankColor: safeClr,
            message:   safeMsg
        });

        console.log(`[CHAT] ${code} / ${uname}: ${safeMsg.substring(0, 60)}`);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 15. skin:sync  →  Sunucu üzerinden skin senkronizasyonu
    //     FIX: P2P yerine Socket.io relay — tüm odaya dağıtılır.
    //     Büyük yük: sadece ilgili oyunculara gönderilir (broadcast hariç gönderen)
    // ─────────────────────────────────────────────────────────────────────
    socket.on('skin:sync', ({ code, skinB64 }) => {
        const room = activeRooms[code];
        if (!room) return;

        const playerData = room.connectedPlayers.get(socket.id);
        if (playerData && skinB64) {
            // Sadece başlık (64KB) üst sınır
            if (typeof skinB64 === 'string' && skinB64.length < 80000) {
                playerData.skinB64 = skinB64;
            }
        }

        // Gönderen hariç odadaki diğer oyunculara ilet
        socket.to(code).emit('skin:sync', {
            socketId: socket.id,
            username: socket.data.username || (playerData && playerData.username) || 'Player',
            skinB64
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 16. rank:sync  →  Sunucu üzerinden rank/renk senkronizasyonu
    // ─────────────────────────────────────────────────────────────────────
    socket.on('rank:sync', ({ code, rank, rankColor }) => {
        const room = activeRooms[code];
        if (!room) return;

        const playerData = room.connectedPlayers.get(socket.id);
        if (playerData) {
            playerData.rank      = rank      || null;
            playerData.rankColor = rankColor || null;
        }

        socket.to(code).emit('rank:sync', {
            socketId:  socket.id,
            username:  socket.data.username || (playerData && playerData.username) || 'Player',
            rank:      rank      || null,
            rankColor: rankColor || null
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 17. player:pos  →  Pozisyon senkronizasyonu (Server relay)
    //     P2P'ye alternatif: opsiyonel — istemci P2P bağlantı kuramazsa kullanır.
    // ─────────────────────────────────────────────────────────────────────
    socket.on('player:pos', ({ code, x, y, z, ry, mode }) => {
        const room = activeRooms[code];
        if (!room) return;
        // Gönderen hariç odaya yay
        socket.to(code).emit('player:pos', {
            socketId: socket.id,
            username: socket.data.username || 'Player',
            x, y, z, ry, mode
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 18. lobby:close  →  Kurucunun sunucuyu açıkça kapatması
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:close', ({ code }) => {
        const room = activeRooms[code];
        if (!room) return;

        if (room.creatorSocketId !== socket.id) {
            return socket.emit('lobby:close:response', { success: false, error: 'Sadece sunucuyu kuran kişi kapatabilir.' });
        }

        room.status = 'closed';
        io.to(code).emit('server:closed', { msgTR: '🔴 Sunucu sahibi kapattı.', msgEN: '🔴 Server owner closed the server.' });
        console.log(`[SERVER] Oda kapatıldı: ${code} (kurucu: ${room.creatorName})`);
        _destroyRoom(code);
        socket.emit('lobby:close:response', { success: true });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 19. disconnect  →  Oyuncu ayrıldı (oda KAPATILMAZ)
    // ─────────────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[-] Ayrıldı: ${socket.id}`);

        const code = socket.data.roomCode;
        if (!code || !activeRooms[code]) return;

        const room = activeRooms[code];
        const playerData = room.connectedPlayers.get(socket.id);
        room.connectedPlayers.delete(socket.id);

        const liveCount = syncPlayerCount(code);
        console.log(`[SERVER] Oyuncu ayrıldı: ${playerData?.username || socket.id} ← oda ${code} (kalan: ${liveCount})`);

        if (playerData) {
            io.to(code).emit('server:player-left', {
                username: playerData.username,
                socketId: socket.id,
                players:  liveCount
            });
        }

        if (liveCount === 0) {
            console.log(`[SERVER] Oda boşaldı, ${EMPTY_ROOM_TTL / 60000} dk sonra kapanacak: ${code}`);
            scheduleEmptyClose(code);
        }
        // NOT: P2P host devri (lobby:you-are-host / lobby:host-migrated) YOKTUR.
    });
});

// ══════════════════════════════════════════════════════════════════════════
//  PERİYODİK TEMİZLİK  –  2 saatten eski odaları zorla kapat
// ══════════════════════════════════════════════════════════════════════════

setInterval(() => {
    const now = Date.now();
    for (const code of Object.keys(activeRooms)) {
        const room = activeRooms[code];
        if (!room) continue;
        if (now - room.createdAt >= MAX_ROOM_AGE) {
            console.log(`[CLEANUP] 2 saatlik ömür doldu: ${code} ("${room.name}")`);
            io.to(code).emit('server:closed', { msgTR: '⏳ Sunucu 2 saatlik ömrünü tamamladı.', msgEN: '⏳ Server reached its 2-hour limit.' });
            _destroyRoom(code);
        }
    }
}, CLEANUP_INTERVAL);

// ══════════════════════════════════════════════════════════════════════════
//  SUNUCU BAŞLATMA
// ══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════════════════════╗`);
    console.log(`║  PLAY LEGENDS  –  Dedicated Server Backend v1.6.3  ║`);
    console.log(`║  Port: ${String(PORT).padEnd(44)}║`);
    console.log(`║  Özellikler:                                        ║`);
    console.log(`║   ✅ Host alanı düzeltildi (creatorName)            ║`);
    console.log(`║   ✅ /setworldspawn → tüm odaya yayılır             ║`);
    console.log(`║   ✅ chat:message → server relay                    ║`);
    console.log(`║   ✅ skin:sync → server relay                       ║`);
    console.log(`║   ✅ rank:sync → server relay                       ║`);
    console.log(`║   ✅ *red* *glow* sunucu adlarına izin verildi      ║`);
    console.log(`╚══════════════════════════════════════════════════════╝`);
});
