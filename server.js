// ════════════════════════════════════════════════════════════════════════════
//  PLAY LEGENDS  –  server.js  (Dedicated Server Mimarisi v2.0.0)
//  ─────────────────────────────────────────────────────────────────────────
//  YENİ ÖZELLİKLER (v2.0.0):
//    A1. Minecraft Tarzı Dünya Kayıt Sistemi (SMP Dünyası Koruma)
//        • Blok değişiklikleri, worldSpawn, oyuncu verileri anlık JSON'a kaydedilir
//        • Dosya: world_data_[roomId].json  (fs modülü ile)
//        • Oda boşalsa bile dosya KALINMAZ; tekrar açılınca kaldığı yerden yüklenir
//        • Auto-save: her 30 saniyede bir + her blok değişiminde
//    A2. Güvenli Bağımsız Sunucu Mantığı
//        • Kurucu/Owner ayrılsa bile oda KAPANMAZ
//        • Sahiplik / dünya silme yetkisi diğer oyunculara DEVREDİLMEZ
//        • Oda yalnızca aktif oyuncu sayısı 0 olunca TTL dolduğunda kapanır
//    A3. Global Sunucu Listesi (Cihazlar Arası Senkronizasyon)
//        • Tüm odalar io.emit('lobby:rooms-broadcast') ile tüm istemcilere anlık yayınlanır
//        • Her create/join/leave/close olayında broadcast tetiklenir
//        • Cihaz/ağ farkı yok: telefon ve PC aynı listeyi görür
//
//  KORUNAN ÖZELLİKLER (v1.6.3'ten):
//    • roomPublicInfo → creatorName/host düzgün gönderilir
//    • /setworldspawn → tüm odaya yayılır
//    • chat:message, skin:sync, rank:sync → server relay
//    • *red* *glow* sunucu adlarına izin verilir (blacklist yaklaşımı)
//    • TAB: playerList / roomPlayerList senkronizasyonu
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');

const app = express();
app.use(cors());

// ── Sağlık / ön-uyandırma endpoint'i ──────────────────────────────────────
app.get('/', (_req, res) => {
    res.send('PLAY LEGENDS Dedicated Server v2.0.0 – Active / Adanmış Sunucu Aktif!');
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
 *   code, name, creatorName, creatorSocketId,
 *   seed, worldType, gameMode, difficulty,
 *   access, cheats, pvp,
 *   players, maxPlayers, status, createdAt,
 *   worldSpawn: {x,y,z}|null,
 *   ops: Set<string>,
 *   bannedPlayers: Set<string>,
 *   connectedPlayers: Map<socketId, {username, rank, rankColor, joinedAt, _chatTs?}>,
 *   blockChanges: Array<{x,y,z,type}>,
 *   playerPositions: {[username]: {x,y,z,ry}},
 *   _saveDirty: boolean,
 *   _saveTimer: NodeJS.Timeout|null
 * }
 */
const activeRooms = {};
const emptyTimers = {};

// Dünya dosyaları için klasör
const WORLD_DIR = path.join(__dirname, 'worlds');
if (!fs.existsSync(WORLD_DIR)) {
    fs.mkdirSync(WORLD_DIR, { recursive: true });
}

// ── Sabitler ──────────────────────────────────────────────────────────────
const EMPTY_ROOM_TTL    = 5  * 60 * 1000;   // 5 dk boş → bellekten düş
const MAX_ROOM_AGE      = 2  * 60 * 60 * 1000;
const CLEANUP_INTERVAL  = 30 * 60 * 1000;
const AUTOSAVE_INTERVAL = 30 * 1000;         // 30 sn otomatik kayıt
const MAX_BLOCK_CHANGES = 50000;             // JSON şişmesini önle

// Sunucu adında yasak pattern'lar (XSS koruması – oyun tag'lerine dokunmaz)
const SERVER_NAME_BLACKLIST = [/<script/i, /javascript:/i, /on\w+\s*=/i];

function sanitizeServerName(name) {
    if (!name || typeof name !== 'string') return 'Server';
    for (const re of SERVER_NAME_BLACKLIST) {
        if (re.test(name)) return 'Server';
    }
    return name.trim().substring(0, 48) || 'Server';
}

// ══════════════════════════════════════════════════════════════════════════
//  DÜNYA KAYIT / YÜKLEME SİSTEMİ  (A1)
// ══════════════════════════════════════════════════════════════════════════

function worldFilePath(code) {
    return path.join(WORLD_DIR, `world_data_${code}.json`);
}

/**
 * Dünya verisini diske yazar.
 * Atomik: önce .tmp dosyasına, ardından asıl dosyaya rename eder.
 */
function saveWorldToDisk(code) {
    const room = activeRooms[code];
    if (!room) return;

    const data = {
        code,
        name:          room.name,
        creatorName:   room.creatorName,
        seed:          room.seed,
        worldType:     room.worldType,
        mode:          room.gameMode,
        difficulty:    room.difficulty,
        access:        room.access,
        cheats:        room.cheats,
        pvp:           room.pvp,
        maxPlayers:    room.maxPlayers,
        worldSpawn:    room.worldSpawn || null,
        admins:        Array.from(room.ops),
        bannedPlayers: Array.from(room.bannedPlayers),
        blockChanges:  room.blockChanges || [],
        playerPositions: room.playerPositions || {},
        savedAt:       Date.now()
    };

    const filePath = worldFilePath(code);
    const tmpPath  = filePath + '.tmp';
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
        fs.renameSync(tmpPath, filePath);
        room._saveDirty = false;
        // console.log(`[SAVE] ${code} → ${filePath}`);
    } catch (err) {
        console.error(`[SAVE ERROR] ${code}:`, err.message);
    }
}

/**
 * Diskten dünya verisini yükler.
 * Oda kodu ile çağrılır. Dosya yoksa null döner.
 */
function loadWorldFromDisk(code) {
    const filePath = worldFilePath(code);
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw  = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        console.log(`[LOAD] Dünya diskten yüklendi: ${code} (${data.blockChanges?.length || 0} blok değişimi)`);
        return data;
    } catch (err) {
        console.error(`[LOAD ERROR] ${code}:`, err.message);
        return null;
    }
}

/**
 * Oda için otomatik kayıt zamanlayıcısını başlatır.
 */
function startAutoSave(code) {
    const room = activeRooms[code];
    if (!room) return;
    if (room._saveTimer) clearInterval(room._saveTimer);
    room._saveTimer = setInterval(() => {
        if (!activeRooms[code]) return;
        if (activeRooms[code]._saveDirty) saveWorldToDisk(code);
    }, AUTOSAVE_INTERVAL);
}

function stopAutoSave(code) {
    const room = activeRooms[code];
    if (!room || !room._saveTimer) return;
    clearInterval(room._saveTimer);
    room._saveTimer = null;
}

/**
 * Blok değişimini odaya kaydeder + dirty flag.
 */
function recordBlockChange(code, blockData) {
    const room = activeRooms[code];
    if (!room) return;
    if (!room.blockChanges) room.blockChanges = [];

    // Aynı koordinattaki eski değişimi bul ve güncelle (deduplication)
    const key = `${blockData.x},${blockData.y},${blockData.z}`;
    const existing = room.blockChanges.findIndex(b => `${b.x},${b.y},${b.z}` === key);
    if (existing !== -1) {
        if (blockData.type === null || blockData.type === undefined) {
            room.blockChanges.splice(existing, 1); // silme işlemi
        } else {
            room.blockChanges[existing] = blockData;
        }
    } else if (blockData.type !== null && blockData.type !== undefined) {
        // Limit aşımını önle
        if (room.blockChanges.length >= MAX_BLOCK_CHANGES) {
            room.blockChanges.shift();
        }
        room.blockChanges.push(blockData);
    }
    room._saveDirty = true;
}

// ══════════════════════════════════════════════════════════════════════════
//  GLOBAL BROADCAST  (A3)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Tüm bağlı istemcilere anlık oda listesini yayınlar.
 * lobby:rooms-broadcast eventi: cihaz/ağ fark etmeksizin tüm istemciler dinler.
 */
function broadcastRoomList() {
    const rooms = Object.values(activeRooms)
        .filter(r => r.status === 'open' && r.access === 'public')
        .map(roomPublicInfo);
    io.emit('lobby:rooms-broadcast', rooms);
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
            console.log(`[SERVER] Boş oda bellekten düşürüldü (${EMPTY_ROOM_TTL / 60000} dk): ${code}`);
            // ÖNEMLİ: Dosyayı SİLMEZ – bir sonraki açılışta kaldığı yerden yüklenir (A1)
            _unloadRoom(code);
        } else {
            cancelEmptyClose(code);
        }
    }, EMPTY_ROOM_TTL);
}

function cancelEmptyClose(code) {
    if (emptyTimers[code]) { clearTimeout(emptyTimers[code]); delete emptyTimers[code]; }
}

/**
 * Odayı bellekten düşürür – DOSYAYI SİLMEZ.
 * Dosya diskten silinmesi için ayrı bir lobby:delete-world eventi kullanılmalı.
 */
function _unloadRoom(code) {
    cancelEmptyClose(code);
    stopAutoSave(code);
    // Son kayıt
    if (activeRooms[code] && activeRooms[code]._saveDirty) {
        saveWorldToDisk(code);
    }
    delete activeRooms[code];
    broadcastRoomList();
}

/**
 * Odayı hem bellekten düşürür hem de dosyayı siler (lobby:close gibi kalıcı kapanmalarda).
 */
function _destroyRoom(code) {
    cancelEmptyClose(code);
    stopAutoSave(code);
    delete activeRooms[code];
    // Dosyayı sil (kalıcı kapatma)
    const filePath = worldFilePath(code);
    if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch(e) {}
    }
    broadcastRoomList();
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

// [FIX] room.creatorSocketId, oda kurulduğu anki socket.id'yi tutar. Ancak bir
// oyuncunun bağlantısı (tarayıcı arka plana alınması, ağ kopması, sayfa yenileme vb.)
// yeniden kurulduğunda socket.io YENİ bir socket.id atar — bu da host'un kendi
// odasında "kurucu" olarak tanınmamasına, dolayısıyla /setworldspawn, /op, /kick,
// /ban gibi komutların host için bile sessizce başarısız olmasına yol açıyordu.
// Çözüm: socket.id eşleşmesi birincil kontrol, ama eşleşmezse kullanıcı adı
// (creatorName) üzerinden de kurucu olup olmadığını doğrula.
function isRoomCreator(room, socket, requesterName) {
    if (!room) return false;
    if (room.creatorSocketId === socket.id) return true;
    const uname = (requesterName || socket.data?.username || '').trim().toLowerCase();
    if (!uname || !room.creatorName) return false;
    if (uname !== room.creatorName.trim().toLowerCase()) return false;
    // İsim eşleşiyor: bu artık host'un yeni socket'i, kaydı güncelle
    room.creatorSocketId = socket.id;
    return true;
}

function roomPublicInfo(room) {
    return {
        code:        room.code,
        name:        room.name,
        creatorName: room.creatorName,
        host:        room.creatorName,   // browse listesi uyumluluğu
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

/** TAB listesi için tüm oyuncu bilgilerini döndürür */
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

/**
 * Bir oda nesnesini başlangıç değerleriyle oluşturur (disk verisi opsiyonel).
 */
function buildRoom(cfg, creatorSocketId, diskData) {
    const d = diskData || {};
    return {
        code:             cfg.code,
        name:             sanitizeServerName(cfg.name || d.name || ('Server_' + cfg.code)),
        creatorName:      cfg.creatorName,
        creatorSocketId,
        seed:             cfg.seed          || d.seed        || '0',
        worldType:        cfg.worldType     || d.worldType   || 'infinite',
        gameMode:         cfg.gameMode      || d.mode        || 'survival',
        difficulty:       cfg.difficulty    || d.difficulty  || 'normal',
        access:           cfg.access        || d.access      || 'public',
        cheats:           cfg.cheats        !== undefined ? cfg.cheats : (d.cheats || false),
        pvp:              cfg.pvp           !== undefined ? cfg.pvp   : (d.pvp !== undefined ? d.pvp : true),
        players:          1,
        maxPlayers:       cfg.maxPlayers    || d.maxPlayers  || 20,
        status:           'open',
        createdAt:        Date.now(),
        worldSpawn:       cfg.worldSpawn    || d.worldSpawn  || null,
        ops:              new Set(Array.isArray(d.admins)        ? d.admins.map(n => n.toLowerCase())        : []),
        bannedPlayers:    new Set(Array.isArray(d.bannedPlayers) ? d.bannedPlayers.map(n => n.toLowerCase()) : []),
        connectedPlayers: new Map(),
        blockChanges:     Array.isArray(d.blockChanges) ? d.blockChanges : [],
        playerPositions:  d.playerPositions || {},
        _saveDirty:       false,
        _saveTimer:       null
    };
}

// ══════════════════════════════════════════════════════════════════════════
//  SOCKET.IO BAĞLANTI MANTIĞI
// ══════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
    console.log(`[+] Bağlandı: ${socket.id}`);
    socket.data.roomCode = null;
    socket.data.username = null;

    // ─────────────────────────────────────────────────────────────────────
    // 1. lobby:list  →  İstek üzerine oda listesi gönder
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

        // Diskte kayıtlı dünya var mı? Varsa yükle (A1: kaldığı yerden devam)
        const diskData = loadWorldFromDisk(cfg.code);

        const roomCfg = { ...cfg, creatorName };
        activeRooms[cfg.code] = buildRoom(roomCfg, socket.id, diskData);

        socket.join(cfg.code);
        socket.data.roomCode = cfg.code;
        socket.data.username = creatorName;

        activeRooms[cfg.code].connectedPlayers.set(socket.id, {
            username:  creatorName,
            rank:      cfg.rank      || null,
            rankColor: cfg.rankColor || null,
            joinedAt:  Date.now()
        });

        startAutoSave(cfg.code);
        console.log(`[SERVER] Oda oluşturuldu: ${cfg.code} — kurucu: ${creatorName}${diskData ? ' (disk\'ten yüklendi)' : ''}`);
        socket.emit('lobby:create:response', { success: true, code: cfg.code, diskData: diskData || null });
        scheduleEmptyClose(cfg.code);
        broadcastRoomList();
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

        room._saveDirty = true;
        broadcastRoomList();
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

        const creatorName = (host || 'Player').trim();

        // Önce diskte dosya var mı? Varsa disk verisini üst veri olarak kullan (A1)
        const diskData = loadWorldFromDisk(code) || worldData;

        const roomCfg = {
            code,
            name:       name || worldData.name || creatorName + "'s World",
            creatorName,
            seed:       worldData.seed     || diskData.seed       || '0',
            worldType:  worldType          || worldData.worldType || diskData.worldType || 'infinite',
            gameMode:   gameMode           || worldData.mode      || diskData.mode      || 'survival',
            difficulty: worldData.difficulty || diskData.difficulty || 'normal',
            access:     worldData.access   || diskData.access     || 'public',
            cheats:     worldData.cheats   !== undefined ? worldData.cheats : (diskData.cheats || false),
            pvp:        worldData.pvp      !== undefined ? worldData.pvp   : (diskData.pvp !== undefined ? diskData.pvp : true),
            maxPlayers: maxPlayers || worldData.maxPlayers || diskData.maxPlayers || 20,
            worldSpawn: worldData.worldSpawn || diskData.worldSpawn || null
        };
        activeRooms[code] = buildRoom(roomCfg, socket.id, diskData);

        socket.join(code);
        socket.data.roomCode = code;
        socket.data.username = creatorName;

        activeRooms[code].connectedPlayers.set(socket.id, {
            username:  creatorName,
            rank:      null,
            rankColor: null,
            joinedAt:  Date.now()
        });

        startAutoSave(code);
        console.log(`[SERVER] Dünya yüklendi: ${code} — kurucu: ${creatorName}`);
        socket.emit('lobby:load-world:response', { success: true, code, diskData: diskData || null });
        scheduleEmptyClose(code);
        broadcastRoomList();
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

        room.connectedPlayers.set(socket.id, {
            username:  uname,
            rank:      rank      || null,
            rankColor: rankColor || null,
            joinedAt:  Date.now()
        });
        syncPlayerCount(code);
        cancelEmptyClose(code);

        const opStatus = isOp(code, uname);
        console.log(`[SERVER] Oyuncu katıldı: ${uname} → oda ${code} (OP: ${opStatus})`);

        socket.emit('lobby:join:response', {
            success:      true,
            code,
            isOp:         opStatus,
            worldSpawn:   room.worldSpawn || null,
            roomInfo:     roomPublicInfo(room),
            playerList:   roomPlayerList(room),
            blockChanges: room.blockChanges || []  // A1: geçmiş blok değişimleri
        });

        socket.to(code).emit('server:player-joined', {
            username:  uname,
            socketId:  socket.id,
            rank:      rank      || null,
            rankColor: rankColor || null,
            isOp:      opStatus,
            players:   room.players
        });

        // TAB listesi güncelle
        io.to(code).emit('server:playerlist-update', { playerList: roomPlayerList(room) });
        broadcastRoomList();
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

        const isCreator     = isRoomCreator(room, socket, requestedBy);
        const requesterIsOp = isOp(code, requestedBy || socket.data.username);
        if (!isCreator && !requesterIsOp) {
            return socket.emit('server:op-add:response', { success: false, error: 'Yetkiniz yok.' });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        if (!target) return;
        room.ops.add(target);
        room._saveDirty = true;
        saveWorldToDisk(code); // hemen kaydet
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
        io.to(code).emit('server:playerlist-update', { playerList: roomPlayerList(room) });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 8. server:op-remove
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:op-remove', ({ code, targetUsername, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const isCreator     = isRoomCreator(room, socket, requestedBy);
        const requesterIsOp = isOp(code, requestedBy || socket.data.username);
        if (!isCreator && !requesterIsOp) {
            return socket.emit('server:op-remove:response', { success: false, error: 'Yetkiniz yok.' });
        }

        const target = (targetUsername || '').trim().toLowerCase();
        room.ops.delete(target);
        room._saveDirty = true;
        saveWorldToDisk(code);
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
        io.to(code).emit('server:playerlist-update', { playerList: roomPlayerList(room) });
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
            io.to(code).emit('server:playerlist-update', { playerList: roomPlayerList(room) });
        }
        socket.emit('server:action:response', { success: kicked, action: 'kick', target: targetUsername });
        broadcastRoomList();
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
        room._saveDirty = true;
        saveWorldToDisk(code);

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
        io.to(code).emit('server:playerlist-update', { playerList: roomPlayerList(room) });
        socket.emit('server:action:response', { success: true, action: 'ban', target: targetUsername });
        broadcastRoomList();
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
        room._saveDirty = true;
        saveWorldToDisk(code);
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
        const isCreator = isRoomCreator(room, socket, requester);
        const hasOp     = isOp(code, requester);
        if (!isCreator && !hasOp) {
            return socket.emit('server:command:response', { success: false, error: 'OP yetkisi gerekli.' });
        }

        switch ((command || '').toLowerCase()) {
            case 'gamemode': {
                const mode = (args && args[0]) || 'survival';
                room.gameMode = mode;
                room._saveDirty = true;
                io.to(code).emit('server:setting-changed', { key: 'gameMode', value: mode });
                break;
            }
            case 'difficulty': {
                const diff = (args && args[0]) || 'normal';
                room.difficulty = diff;
                room._saveDirty = true;
                io.to(code).emit('server:setting-changed', { key: 'difficulty', value: diff });
                break;
            }
            case 'pvp': {
                const pvpVal = args && args[0] !== undefined ? Boolean(args[0]) : !room.pvp;
                room.pvp = pvpVal;
                room._saveDirty = true;
                io.to(code).emit('server:setting-changed', { key: 'pvp', value: pvpVal });
                break;
            }
            case 'cheats': {
                const cheatVal = args && args[0] !== undefined ? Boolean(args[0]) : !room.cheats;
                room.cheats = cheatVal;
                room._saveDirty = true;
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
        broadcastRoomList();
    });

    // ─────────────────────────────────────────────────────────────────────
    // 13. server:setworldspawn  →  Dünya doğum noktası (A1: kaydedilir)
    // ─────────────────────────────────────────────────────────────────────
    socket.on('server:setworldspawn', ({ code, x, y, z, requestedBy }) => {
        const room = activeRooms[code];
        if (!room) return;

        const requester = requestedBy || socket.data.username || '';
        const isCreator = isRoomCreator(room, socket, requester);
        const hasOp     = isOp(code, requester);
        if (!isCreator && !hasOp) {
            return socket.emit('server:setworldspawn:response', { success: false, error: 'OP yetkisi gerekli.' });
        }

        const spawnX = parseFloat(x) || 8;
        const spawnY = parseFloat(y) || 10;
        const spawnZ = parseFloat(z) || 8;

        room.worldSpawn = { x: spawnX, y: spawnY, z: spawnZ };
        room._saveDirty = true;
        saveWorldToDisk(code); // spawn değişimi → hemen kaydet

        console.log(`[SPAWN] ${code} → worldSpawn: ${JSON.stringify(room.worldSpawn)} (${requester})`);

        const msgTR = `✅ Dünya doğum noktası ayarlandı: [${Math.round(spawnX)}, ${Math.round(spawnY)}, ${Math.round(spawnZ)}]`;
        const msgEN = `✅ World spawn set: [${Math.round(spawnX)}, ${Math.round(spawnY)}, ${Math.round(spawnZ)}]`;

        io.to(code).emit('server:worldspawn-updated', { x: spawnX, y: spawnY, z: spawnZ, msgTR, msgEN });
        socket.emit('server:setworldspawn:response', { success: true, x: spawnX, y: spawnY, z: spawnZ });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 14. chat:message  →  Server relay (tüm odaya)
    // ─────────────────────────────────────────────────────────────────────
    socket.on('chat:message', ({ code, username, rank, rankColor, message }) => {
        const room = activeRooms[code];
        if (!room) return;

        const uname   = (username  || socket.data.username || 'Player').trim().substring(0, 24);
        const safeMsg = (message   || '').substring(0, 256);
        const safeRnk = (rank      || null);
        const safeClr = (rankColor || null);

        const playerData = room.connectedPlayers.get(socket.id);
        if (playerData) {
            const now = Date.now();
            if (!playerData._chatTs) playerData._chatTs = [];
            playerData._chatTs = playerData._chatTs.filter(t => now - t < 1000);
            if (playerData._chatTs.length >= 5) return;
            playerData._chatTs.push(now);
        }

        io.to(code).emit('chat:message', { username: uname, rank: safeRnk, rankColor: safeClr, message: safeMsg });
        console.log(`[CHAT] ${code} / ${uname}: ${safeMsg.substring(0, 60)}`);
    });

    // ─────────────────────────────────────────────────────────────────────
    // 15. skin:sync  →  Server relay
    // ─────────────────────────────────────────────────────────────────────
    socket.on('skin:sync', ({ code, skinB64 }) => {
        const room = activeRooms[code];
        if (!room) return;

        const playerData = room.connectedPlayers.get(socket.id);
        if (playerData && skinB64 && typeof skinB64 === 'string' && skinB64.length < 80000) {
            playerData.skinB64 = skinB64;
        }

        socket.to(code).emit('skin:sync', {
            socketId: socket.id,
            username: socket.data.username || (playerData && playerData.username) || 'Player',
            skinB64
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 16. rank:sync  →  Server relay
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
    // 17. player:pos  →  Pozisyon relay + kaydı (A1)
    // ─────────────────────────────────────────────────────────────────────
    socket.on('player:pos', ({ code, x, y, z, ry, mode }) => {
        const room = activeRooms[code];
        if (!room) return;

        // Pozisyonu bellekte tut (kayıt için)
        const uname = socket.data.username || 'Player';
        if (!room.playerPositions) room.playerPositions = {};
        room.playerPositions[uname] = { x, y, z, ry };
        room._saveDirty = true;

        socket.to(code).emit('player:pos', {
            socketId: socket.id,
            username: uname,
            x, y, z, ry, mode
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 18. world:block-change  →  Blok değişimini kaydet ve relay et (A1)
    //     İstemci her blok koy/kır işleminde bunu emit etmeli.
    // ─────────────────────────────────────────────────────────────────────
    socket.on('world:block-change', ({ code, x, y, z, type }) => {
        const room = activeRooms[code];
        if (!room) return;

        // Kaydet
        recordBlockChange(code, { x, y, z, type: type !== undefined ? type : null });

        // Odadaki diğer oyunculara relay
        socket.to(code).emit('world:block-change', { x, y, z, type, socketId: socket.id });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 19. world:save  →  İstemcinin tetiklediği anlık kayıt (A1)
    // ─────────────────────────────────────────────────────────────────────
    socket.on('world:save', ({ code }) => {
        const room = activeRooms[code];
        if (!room) return;
        // Sadece kurucu veya OP kayıt tetikleyebilir
        const isCreator = isRoomCreator(room, socket, socket.data.username);
        const hasOp     = isOp(code, socket.data.username || '');
        if (!isCreator && !hasOp) return;

        room._saveDirty = true;
        saveWorldToDisk(code);
        socket.emit('world:save:response', { success: true, savedAt: Date.now() });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 20. lobby:close  →  Kurucunun sunucuyu açıkça kapatması + dosya silme
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
        _destroyRoom(code); // dosyayı da sil
        socket.emit('lobby:close:response', { success: true });
    });

    // ─────────────────────────────────────────────────────────────────────
    // 21. disconnect  →  Oyuncu ayrıldı (oda KAPANMAZ – A2)
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
            // TAB güncelle
            io.to(code).emit('server:playerlist-update', { playerList: roomPlayerList(room) });
        }

        // A2: Kurucu ayrılsa bile oda DEVAM EDER – sahiplik devredilmez
        if (liveCount === 0) {
            console.log(`[SERVER] Oda boşaldı, ${EMPTY_ROOM_TTL / 60000} dk sonra bellekten düşecek: ${code}`);
            // Son kaydı hemen al
            if (room._saveDirty) saveWorldToDisk(code);
            scheduleEmptyClose(code);
        }

        broadcastRoomList();
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
            console.log(`[CLEANUP] 2 saatlik ömür doldu: ${code} ("${room.name}")`);
            io.to(code).emit('server:closed', { msgTR: '⏳ Sunucu 2 saatlik ömrünü tamamladı.', msgEN: '⏳ Server reached its 2-hour limit.' });
            _unloadRoom(code); // Dosyayı SİLMEZ, sadece bellekten düşürür
        }
    }
}, CLEANUP_INTERVAL);

// ══════════════════════════════════════════════════════════════════════════
//  SUNUCU BAŞLATMA
// ══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`╔═══════════════════════════════════════════════════════════╗`);
    console.log(`║  PLAY LEGENDS  –  Dedicated Server Backend v2.0.0       ║`);
    console.log(`║  Port: ${String(PORT).padEnd(50)}║`);
    console.log(`║  YENİ ÖZELLİKLER:                                       ║`);
    console.log(`║   ✅ A1: Minecraft tarzı dünya kayıt sistemi (fs JSON)   ║`);
    console.log(`║   ✅ A1: Auto-save 30sn + blok değişimi anında kayıt     ║`);
    console.log(`║   ✅ A1: Oda boşalsa bile dünya dosyası korunur          ║`);
    console.log(`║   ✅ A2: Kurucu çıkınca oda kapanmaz, yetki devredilmez  ║`);
    console.log(`║   ✅ A3: io.emit lobby:rooms-broadcast (global liste)    ║`);
    console.log(`║   ✅ world:block-change → kayıt + relay                  ║`);
    console.log(`║   ✅ server:playerlist-update → TAB sync                 ║`);
    console.log(`╚═══════════════════════════════════════════════════════════╝`);
    console.log(`   Dünya dosya klasörü: ${WORLD_DIR}`);
});
