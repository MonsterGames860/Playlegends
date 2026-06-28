// ════════════════════════════════════════════════════════════════════════════
//  PLAY LEGENDS  –  server.js  (Dedicated Server Mimarisi)
//  ─────────────────────────────────────────────────────────────────────────
//  TEMEL FELSEFE:
//    • Odalar "adanmış sunucu" (dedicated server) olarak çalışır.
//    • Hiçbir oyuncuya "host" rolü verilmez; kimse ayrıldığında yetki
//      başkasına devredilmez (lobby:you-are-host / lobby:host-migrated YOK).
//    • Oda kurucusu ayrılsa bile oda YAŞAMAYA DEVAM EDER.
//    • Oda yalnızca şu durumlarda kapanır:
//        – Boş kalma süresi (EMPTY_ROOM_TTL) dolduğunda
//        – Oda sahibi (creator) sunucuyu açıkça kapattığında  (lobby:close)
//        – 2 saatlik mutlak ömür sona erdiğinde
//    • Yetki sistemi: OP listesi sunucuda tutulur; sadece OP'lar sunucu
//      komutlarını (kick, ban, gamemode, cheat, vb.) çalıştırabilir.
//    • Her bağlanan oyuncu eşit "Player" statüsündedir; OP ayrı bir roldür.
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
 *   code          : string       – 4 haneli oda kodu
 *   name          : string       – görünen sunucu adı
 *   creatorName   : string       – kurucu oyuncunun kullanıcı adı (bilgi amaçlı)
 *   creatorSocketId: string|null – kurucunun soket ID'si (sadece lobby:close için)
 *   seed          : string
 *   worldType     : string
 *   gameMode      : string
 *   difficulty    : string
 *   access        : 'public'|'private'
 *   cheats        : boolean
 *   pvp           : boolean
 *   players       : number       – anlık oyuncu sayısı
 *   maxPlayers    : number
 *   status        : 'open'|'closed'
 *   createdAt     : number       – ms timestamp
 *   ops           : Set<string>  – OP olan kullanıcı adları (küçük harf)
 *   bannedPlayers : Set<string>  – banlı kullanıcı adları (küçük harf)
 *   connectedPlayers: Map<socketId, { username, joinedAt }>
 * }
 */
const activeRooms = {};

/**
 * worldStore[code] = worldData  – kayıtlı dünya verisi
 */
const worldStore = {};

/**
 * emptyTimers[code] = timeoutId  – boş oda kapatma zamanlayıcısı
 */
const emptyTimers = {};

// ── Sabitler ──────────────────────────────────────────────────────────────
const EMPTY_ROOM_TTL  = 5  * 60 * 1000;  // 5 dk boş kalırsa kapat
const MAX_ROOM_AGE    = 2  * 60 * 60 * 1000;  // 2 saat mutlak ömür
const CLEANUP_INTERVAL = 30 * 60 * 1000;  // 30 dk'da bir temizlik turu

// ══════════════════════════════════════════════════════════════════════════
//  YARDIMCI FONKSİYONLAR
// ══════════════════════════════════════════════════════════════════════════

/** Boş-oda kapama zamanlayıcısını (yeniden) başlatır. */
function scheduleEmptyClose(code) {
    if (emptyTimers[code]) clearTimeout(emptyTimers[code]);

    emptyTimers[code] = setTimeout(() => {
        delete emptyTimers[code];
        if (!activeRooms[code]) return;

        // Zamanlayıcı tetiklendiğinde gerçekten boş mu kontrol et
        const socketRoom = io.sockets.adapter.rooms.get(code);
        const count = socketRoom ? socketRoom.size : 0;

        if (count === 0) {
            console.log(`[SERVER] Boş oda kapatıldı (${EMPTY_ROOM_TTL / 60000} dk): ${code}`);
            _destroyRoom(code);
        } else {
            // Arada birileri girmiş; zamanlayıcıyı iptal et
            cancelEmptyClose(code);
        }
    }, EMPTY_ROOM_TTL);
}

/** Boş-oda zamanlayıcısını iptal eder. */
function cancelEmptyClose(code) {
    if (emptyTimers[code]) {
        clearTimeout(emptyTimers[code]);
        delete emptyTimers[code];
    }
}

/** Odayı ve ilişkili tüm verileri siler. */
function _destroyRoom(code) {
    cancelEmptyClose(code);
    delete activeRooms[code];
    delete worldStore[code];
}

/**
 * Anlık oyuncu sayısını socket adapter'dan okur ve oda kaydını günceller.
 * @returns {number} Güncel oyuncu sayısı
 */
function syncPlayerCount(code) {
    const room = activeRooms[code];
    if (!room) return 0;
    const socketRoom = io.sockets.adapter.rooms.get(code);
    const count = socketRoom ? socketRoom.size : 0;
    room.players = count;
    return count;
}

/**
 * Bir oyuncunun OP olup olmadığını kontrol eder.
 * @param {string} code      Oda kodu
 * @param {string} username  Kullanıcı adı
 */
function isOp(code, username) {
    const room = activeRooms[code];
    if (!room || !username) return false;
    return room.ops.has(username.trim().toLowerCase());
}

/**
 * Bir oyuncunun banlı olup olmadığını kontrol eder.
 */
function isBanned(code, username) {
    const room = activeRooms[code];
    if (!room || !username) return false;
    return room.bannedPlayers.has(username.trim().toLowerCase());
}

/**
 * Odanın genel bilgi nesnesini (lobby listesi için) döndürür.
 * ops ve connectedPlayers gibi hassas alanlar çıkarılır.
 */
function roomPublicInfo(room) {
    return {
        code:        room.code,
        name:        room.name,
        creatorName: room.creatorName,
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
        createdAt:   room.createdAt
    };
}

// ══════════════════════════════════════════════════════════════════════════
//  SOCKET.IO BAĞLANTI MANTIĞI
// ══════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
    console.log(`[+] Bağlandı: ${socket.id}`);

    // ── Soket meta verisi (hangi oda/kullanıcı adı) ──────────────────────
    // socket.data.roomCode   : string | null
    // socket.data.username   : string | null
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
    //    cfg: { code, name, host (=creatorName), seed, worldType, gameMode,
    //           difficulty, access, cheats, pvp, maxPlayers }
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:create', (cfg) => {
        if (!cfg || !cfg.code) {
            return socket.emit('lobby:create:response', {
                success: false,
                error: 'Geçersiz yapılandırma. / Invalid configuration.'
            });
        }

        // Aynı kod zaten açıksa reddet
        if (activeRooms[cfg.code]) {
            return socket.emit('lobby:create:response', {
                success: false,
                error: 'Bu kod zaten kullanımda. / Code already in use.'
            });
        }

        const creatorName = cfg.host || cfg.creatorName || 'Unknown';

        activeRooms[cfg.code] = {
            code:             cfg.code,
            name:             cfg.name        || ('Server_' + cfg.code),
            creatorName,
            creatorSocketId:  socket.id,       // sadece lobby:close kontrolü için
            seed:             cfg.seed         || '0',
            worldType:        cfg.worldType    || 'infinite',
            gameMode:         cfg.gameMode     || 'survival',
            difficulty:       cfg.difficulty   || 'normal',
            access:           cfg.access       || 'public',
            cheats:           cfg.cheats       || false,
            pvp:              cfg.pvp !== undefined ? cfg.pvp : true,
            players:          1,
            maxPlayers:       cfg.maxPlayers   || 20,
            status:           'open',
            createdAt:        Date.now(),
            ops:              new Set(),        // OP kullanıcı adları
            bannedPlayers:    new Set(),        // banlı kullanıcı adları
            connectedPlayers: new Map(),        // socketId → { username, joinedAt }
            worldSpawn:       null              // { x, y, z } – /setworldspawn ile ayarlanan nokta
        };

        socket.join(cfg.code);
        socket.data.roomCode = cfg.code;
        socket.data.username = creatorName;

        activeRooms[cfg.code].connectedPlayers.set(socket.id, {
            username:  creatorName,
            joinedAt:  Date.now()
        });

        console.log(`[SERVER] Oda oluşturuldu: ${cfg.code} — "${activeRooms[cfg.code].name}" (kurucu: ${creatorName})`);
        socket.emit('lobby:create:response', { success: true, code: cfg.code });

        // Oda boş kalırsa 5 dk sonra kapat
        scheduleEmptyClose(cfg.code);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 3. lobby:update  →  Oda meta verisini güncelle (oyuncu sayısı, isim…)
    //    Sadece odanın kurucusu veya OP çağırabilir (isteğe bağlı doğrulama).
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:update', ({ code, players, status, name, maxPlayers, access, pvp, cheats, gameMode }) => {
        const room = activeRooms[code];
        if (!room) return;

        if (players    !== undefined) room.players    = players;
        if (status     !== undefined) room.status     = status;
        if (name       !== undefined) room.name       = name;
        if (maxPlayers !== undefined) room.maxPlayers = maxPlayers;
        if (access     !== undefined) room.access     = access;
        if (pvp        !== undefined) room.pvp        = pvp;
        if (cheats     !== undefined) room.cheats     = cheats;
        if (gameMode   !== undefined) room.gameMode   = gameMode;

        // Güncel socket sayısını senkronize et
        const liveCount = syncPlayerCount(code);
        if (liveCount > 0) cancelEmptyClose(code);

        console.log(`[SERVER] Güncellendi: ${code} — oyuncu=${room.players}, durum=${room.status}, isim="${room.name}"`);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 4. lobby:load-world  →  Kayıtlı dünyayı yükleyerek sunucu aç
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:load-world', ({ code, host, worldData, gameMode, worldType, name, maxPlayers }) => {
        if (!code || !worldData) {
            return socket.emit('lobby:load-world:response', {
                success: false,
                error: 'Eksik veri. / Missing data.'
            });
        }

        if (activeRooms[code]) {
            return socket.emit('lobby:load-world:response', {
                success: false,
                error: 'Bu kod zaten kullanımda. / Code already in use.'
            });
        }

        worldStore[code] = worldData;

        const creatorName = host || 'Unknown';

        activeRooms[code] = {
            code,
            name:             name || worldData.name || creatorName + "'s World",
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
            ops:              new Set(),
            bannedPlayers:    new Set(),
            connectedPlayers: new Map(),
            worldSpawn:       null              // { x, y, z } – /setworldspawn ile ayarlanan nokta
        };

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.username = creatorName;

        activeRooms[code].connectedPlayers.set(socket.id, {
            username: creatorName,
            joinedAt: Date.now()
        });

        console.log(`[SERVER] Dünya yüklendi: ${code} — kurucu: ${creatorName} — isim: "${activeRooms[code].name}"`);
        socket.emit('lobby:load-world:response', { success: true, code });

        scheduleEmptyClose(code);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 5. lobby:join  →  Oyuncu odaya katılıyor (player kaydı)
    //    { code, username }
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:join', ({ code, username }) => {
        const room = activeRooms[code];
        if (!room) {
            return socket.emit('lobby:join:response', {
                success: false,
                error: 'Oda bulunamadı. / Room not found.'
            });
        }
        if (room.status !== 'open') {
            return socket.emit('lobby:join:response', {
                success: false,
                error: 'Sunucu kapalı. / Server is closed.'
            });
        }

        const uname = (username || 'Player').trim();

        // Ban kontrolü
        if (isBanned(code, uname)) {
            return socket.emit('lobby:join:response', {
                success: false,
                error: 'Bu sunucudan banlandınız. / You are banned from this server.'
            });
        }

        // Kapasite kontrolü
        const liveCount = syncPlayerCount(code);
        if (liveCount >= room.maxPlayers) {
            return socket.emit('lobby:join:response', {
                success: false,
                error: 'Sunucu dolu. / Server is full.'
            });
        }

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.username = uname;

        room.connectedPlayers.set(socket.id, { username: uname, joinedAt: Date.now() });
        syncPlayerCount(code);
        cancelEmptyClose(code);  // biri girdi, boş-oda sayacını durdur

        const opStatus = isOp(code, uname);

        console.log(`[SERVER] Oyuncu katıldı: ${uname} → oda ${code} (OP: ${opStatus})`);
        socket.emit('lobby:join:response', {
            success:  true,
            code,
            isOp:     opStatus,
            worldSpawn: room.worldSpawn || null,
            roomInfo: roomPublicInfo(room)
        });

        // Odadaki herkese yeni oyuncu bildir
        socket.to(code).emit('server:player-joined', {
            username:  uname,
            socketId:  socket.id,
            isOp:      opStatus,
            players:   room.players
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 6. lobby:register-player  →  Mevcut flow ile uyumluluk için korundu
    //    (istemci kodu hâlâ bu eventi kullanıyorsa çalışır)
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:register-player', ({ code, username }) => {
        const room = activeRooms[code];
        if (!room) return;

        const uname = (username || socket.data.username || 'Player').trim();
        socket.data.username = uname;

        if (!room.connectedPlayers.has(socket.id)) {
            room.connectedPlayers.set(socket.id, { username: uname, joinedAt: Date.now() });
        }

        syncPlayerCount(code);
        cancelEmptyClose(code);

        // OP durumunu geri bildir
        socket.emit('server:your-status', {
            isOp:     isOp(code, uname),
            username: uname
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 7. server:op-add  →  OP ekle
    //    Sadece odanın kurucusu VEYA mevcut OP yapabilir.
    //    { code, targetUsername, requestedBy }
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:op-add', ({ code, targetUsername, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        // Yetki: oda kurucusu soket mi, yoksa OP olan biri mi?
        const isCreator = room.creatorSocketId === socket.id;
        const requesterIsOp = isOp(code, requestedBy || socket.data.username);

        if (!isCreator && !requesterIsOp) {
            return socket.emit('server:op-add:response', {
                success: false,
                error:   'Yetkiniz yok. / No permission.'
            });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        if (!target) return;

        room.ops.add(target);
        console.log(`[OP] ${target} → oda ${code} OP yapıldı`);

        socket.emit('server:op-add:response', { success: true, username: target });

        // Odada bağlı oyuncuya OP durumunu bildir
        for (const [sid, data] of room.connectedPlayers) {
            if (data.username.trim().toLowerCase() === target) {
                const targetSocket = io.sockets.sockets.get(sid);
                if (targetSocket) {
                    targetSocket.emit('server:your-status', { isOp: true, username: data.username });
                    targetSocket.emit('server:system-message', {
                        msgTR: '⭐ Operatör (OP) yetkiniz aktifleştirildi.',
                        msgEN: '⭐ You have been granted Operator (OP) status.'
                    });
                }
            }
        }

        // Tüm odaya duyur
        io.to(code).emit('server:op-granted', {
            username: targetUsername,
            msgTR:   `⭐ ${targetUsername} OP yapıldı.`,
            msgEN:   `⭐ ${targetUsername} has been granted OP.`
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 8. server:op-remove  →  OP al
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:op-remove', ({ code, targetUsername, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const isCreator    = room.creatorSocketId === socket.id;
        const requesterIsOp = isOp(code, requestedBy || socket.data.username);

        if (!isCreator && !requesterIsOp) {
            return socket.emit('server:op-remove:response', {
                success: false,
                error:   'Yetkiniz yok. / No permission.'
            });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        room.ops.delete(target);
        console.log(`[OP] ${target} → oda ${code} OP yetkisi alındı`);

        socket.emit('server:op-remove:response', { success: true, username: target });

        for (const [sid, data] of room.connectedPlayers) {
            if (data.username.trim().toLowerCase() === target) {
                const targetSocket = io.sockets.sockets.get(sid);
                if (targetSocket) {
                    targetSocket.emit('server:your-status', { isOp: false, username: data.username });
                    targetSocket.emit('server:system-message', {
                        msgTR: '❌ Operatör yetkiniz alındı.',
                        msgEN: '❌ Your Operator status has been removed.'
                    });
                }
            }
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    // 9. server:kick  →  Oyuncuyu at (OP yetkisi gerekli)
    //    { code, targetUsername, reason, requestedBy }
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:kick', ({ code, targetUsername, reason, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        if (!isOp(code, requester) && room.creatorSocketId !== socket.id) {
            return socket.emit('server:action:response', {
                success: false,
                error:   'OP yetkisi gerekli. / OP permission required.'
            });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        let kicked = false;

        for (const [sid, data] of room.connectedPlayers) {
            if (data.username.trim().toLowerCase() === target) {
                const targetSocket = io.sockets.sockets.get(sid);
                if (targetSocket) {
                    targetSocket.emit('server:kicked', {
                        reason:  reason || '',
                        msgTR:   `Sunucudan atıldınız. Sebep: ${reason || 'Belirtilmedi'}`,
                        msgEN:   `You were kicked. Reason: ${reason || 'Not specified'}`
                    });
                    targetSocket.leave(code);
                    room.connectedPlayers.delete(sid);
                    kicked = true;
                }
                break;
            }
        }

        if (kicked) {
            syncPlayerCount(code);
            console.log(`[KICK] ${target} → oda ${code} atıldı. Sebep: ${reason || '-'}`);
            io.to(code).emit('server:system-message', {
                msgTR: `🥾 ${targetUsername} sunucudan atıldı.`,
                msgEN: `🥾 ${targetUsername} was kicked from the server.`
            });
        }

        socket.emit('server:action:response', { success: kicked, action: 'kick', target: targetUsername });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 10. server:ban  →  Oyuncuyu banla (OP yetkisi gerekli)
    //     { code, targetUsername, reason, requestedBy }
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:ban', ({ code, targetUsername, reason, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        if (!isOp(code, requester) && room.creatorSocketId !== socket.id) {
            return socket.emit('server:action:response', {
                success: false,
                error:   'OP yetkisi gerekli. / OP permission required.'
            });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        room.bannedPlayers.add(target);

        // Banlı oyuncu hâlâ bağlıysa at
        for (const [sid, data] of room.connectedPlayers) {
            if (data.username.trim().toLowerCase() === target) {
                const targetSocket = io.sockets.sockets.get(sid);
                if (targetSocket) {
                    targetSocket.emit('server:banned', {
                        reason: reason || '',
                        msgTR:  `Sunucudan banlandınız. Sebep: ${reason || 'Belirtilmedi'}`,
                        msgEN:  `You are banned. Reason: ${reason || 'Not specified'}`
                    });
                    targetSocket.leave(code);
                    room.connectedPlayers.delete(sid);
                }
                break;
            }
        }

        syncPlayerCount(code);
        console.log(`[BAN] ${target} → oda ${code} banlı`);
        io.to(code).emit('server:system-message', {
            msgTR: `🔨 ${targetUsername} banlandı.`,
            msgEN: `🔨 ${targetUsername} has been banned.`
        });

        socket.emit('server:action:response', { success: true, action: 'ban', target: targetUsername });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 11. server:unban  →  Ban kaldır (OP yetkisi gerekli)
    //     { code, targetUsername, requestedBy }
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:unban', ({ code, targetUsername, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        if (!isOp(code, requester) && room.creatorSocketId !== socket.id) {
            return socket.emit('server:action:response', {
                success: false,
                error:   'OP yetkisi gerekli. / OP permission required.'
            });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        room.bannedPlayers.delete(target);
        console.log(`[UNBAN] ${target} → oda ${code} ban kaldırıldı`);

        socket.emit('server:action:response', { success: true, action: 'unban', target: targetUsername });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 12. server:command  →  Genel sunucu komutu (OP yetkisi gerekli)
    //     { code, command, args, requestedBy }
    //     Komutlar: 'gamemode', 'difficulty', 'pvp', 'cheats', 'close'
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:command', ({ code, command, args, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        const isCreator  = room.creatorSocketId === socket.id;
        const hasOp      = isOp(code, requester);

        if (!isCreator && !hasOp) {
            return socket.emit('server:command:response', {
                success: false,
                error:   'OP yetkisi gerekli. / OP permission required.'
            });
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
                console.log(`[CMD] ${code} → pvp = ${pvpVal}`);
                break;
            }
            case 'cheats': {
                const cheatVal = args && args[0] !== undefined ? Boolean(args[0]) : !room.cheats;
                room.cheats = cheatVal;
                io.to(code).emit('server:setting-changed', { key: 'cheats', value: cheatVal });
                console.log(`[CMD] ${code} → cheats = ${cheatVal}`);
                break;
            }
            case 'close': {
                // Sadece oda kurucusu kapatabilir
                if (!isCreator) {
                    return socket.emit('server:command:response', {
                        success: false,
                        error:   'Sadece oda kurucusu sunucuyu kapatabilir. / Only the creator can close.'
                    });
                }
                room.status = 'closed';
                io.to(code).emit('server:closed', {
                    msgTR: '🔴 Sunucu kapatıldı.',
                    msgEN: '🔴 Server has been closed.'
                });
                console.log(`[CMD] ${code} → sunucu kapatıldı (kurucu: ${room.creatorName})`);
                _destroyRoom(code);
                return socket.emit('server:command:response', { success: true, command: 'close' });
            }
            default:
                return socket.emit('server:command:response', {
                    success: false,
                    error:   `Bilinmeyen komut: ${command}`
                });
        }

        socket.emit('server:command:response', { success: true, command, args });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 13. server:setworldspawn  →  Dünya doğum noktasını kaydet (OP/kurucu)
    //     { code, x, y, z, requestedBy }
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:setworldspawn', ({ code, x, y, z, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        const isCreator  = room.creatorSocketId === socket.id;
        const hasOp      = isOp(code, requester);

        if (!isCreator && !hasOp) {
            return socket.emit('server:setworldspawn:response', {
                success: false,
                error:   'OP yetkisi gerekli. / OP permission required.'
            });
        }

        const spawnX = parseFloat(x) || 8;
        const spawnY = parseFloat(y) || 10;
        const spawnZ = parseFloat(z) || 8;

        room.worldSpawn = { x: spawnX, y: spawnY, z: spawnZ };
        console.log(`[SPAWN] ${code} → worldSpawn ayarlandı: ${JSON.stringify(room.worldSpawn)} (${requester})`);

        // Odadaki tüm oyunculara bildir
        const msgTR = `✅ Dünya doğum noktası ayarlandı: [${Math.round(spawnX)}, ${Math.round(spawnY)}, ${Math.round(spawnZ)}]`;
        const msgEN = `✅ World spawn point set: [${Math.round(spawnX)}, ${Math.round(spawnY)}, ${Math.round(spawnZ)}]`;

        io.to(code).emit('server:worldspawn-updated', {
            x: spawnX, y: spawnY, z: spawnZ,
            msgTR, msgEN
        });

        socket.emit('server:setworldspawn:response', { success: true, x: spawnX, y: spawnY, z: spawnZ });
    });

    // ─────────────────────────────────────────────────────────────────────
    // lobby:close  →  Kurucunun sunucuyu açıkça kapatması
    //     { code }  –  Sadece creatorSocketId eşleşirse kabul edilir.
    // ─────────────────────────────────────────────────────────────────────
    socket.on('lobby:close', ({ code }) => {
        const room = activeRooms[code];
        if (!room) return;

        if (room.creatorSocketId !== socket.id) {
            return socket.emit('lobby:close:response', {
                success: false,
                error:   'Sadece sunucuyu kuran kişi kapatabilir. / Only the creator can close.'
            });
        }

        room.status = 'closed';
        io.to(code).emit('server:closed', {
            msgTR: '🔴 Sunucu sahibi sunucuyu kapattı.',
            msgEN: '🔴 The server owner has closed the server.'
        });

        console.log(`[SERVER] Oda kapatıldı: ${code} (kurucu: ${room.creatorName})`);
        _destroyRoom(code);
        socket.emit('lobby:close:response', { success: true });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 14. disconnect  →  Oyuncu ayrıldı (oda KAPATILMAZ)
    // ─────────────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[-] Ayrıldı: ${socket.id}`);

        const code = socket.data.roomCode;
        if (!code || !activeRooms[code]) return;

        const room = activeRooms[code];

        // Oyuncuyu connected listesinden çıkar
        const playerData = room.connectedPlayers.get(socket.id);
        room.connectedPlayers.delete(socket.id);

        const liveCount = syncPlayerCount(code);

        console.log(`[SERVER] Oyuncu ayrıldı: ${playerData?.username || socket.id} ← oda ${code} (kalan: ${liveCount})`);

        // Odadaki herkese bildir
        if (playerData) {
            io.to(code).emit('server:player-left', {
                username: playerData.username,
                socketId: socket.id,
                players:  liveCount
            });
        }

        if (liveCount === 0) {
            // Oda boşaldı → 5 dakika sayacını başlat; oda SİLİNMEZ
            // Kurucu bile ayrılmış olsa oda listede kalır, yeni oyuncular girebilir
            console.log(`[SERVER] Oda boşaldı, ${EMPTY_ROOM_TTL / 60000} dk sonra kapanacak: ${code}`);
            scheduleEmptyClose(code);
        }
        // NOT: liveCount > 0 ise hiçbir şey yapma; oda sağlıklı çalışmaya devam eder.
        // P2P host devri (lobby:you-are-host / lobby:host-migrated) YOKTUR.
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
            console.log(`[CLEANUP] 2 saatlik ömür doldu, temizlendi: ${code} ("${room.name}")`);
            io.to(code).emit('server:closed', {
                msgTR: '⏳ Sunucu 2 saatlik ömrünü tamamladı ve kapatıldı.',
                msgEN: '⏳ Server reached its 2-hour limit and was closed.'
            });
            _destroyRoom(code);
        }
    }
}, CLEANUP_INTERVAL);

// ══════════════════════════════════════════════════════════════════════════
//  SUNUCU BAŞLATMA
// ══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════════════════╗`);
    console.log(`║  PLAY LEGENDS  –  Dedicated Server Backend      ║`);
    console.log(`║  Port: ${String(PORT).padEnd(42)}║`);
    console.log(`╚══════════════════════════════════════════════════╝`);
});
