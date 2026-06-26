const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Dil Paketleri (Language Packs)
const translations = {
    tr: {
        welcome: 'PLAY LEGENDS Sunucusu Aktif!',
        roomCreated: 'Yeni oda oluşturuldu: ',
        serverNotFound: 'Bu sunucu artık aktif değil veya kapanmış.',
        hostLeft: 'Sunucu kurucusu oyundan ayrıldı.',
        defaultRoomName: ' oyuncusunun Dünyası',
        guest: 'Misafir'
    },
    en: {
        welcome: 'PLAY LEGENDS Server is Active!',
        roomCreated: 'New room created: ',
        serverNotFound: 'This server is no longer active or has been closed.',
        hostLeft: 'The server host has left the game.',
        defaultRoomName: "s World",
        guest: 'Guest'
    }
};

// Sağlık kontrolü (Render için)
app.get('/', (req, res) => {
    res.send(translations.en.welcome + " / " + translations.tr.welcome);
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let activeRooms = {};

io.on('connection', (socket) => {
    console.log(`Bir oyuncu bağlandı / Player connected: ${socket.id}`);

    // Oyuncunun tercih ettiği dil (Varsayılan: tr)
    let playerLang = 'tr';

    // 1. "Göz At" listesini isteyen oyuncuya güncel listeyi gönder
    socket.on('get-rooms', ({ lang }) => {
        playerLang = lang === 'en' ? 'en' : 'tr';
        socket.emit('rooms-list', Object.values(activeRooms));
    });

    // 2. "Oluştur" veya "Yükle" ile gelen yeni oda kurma isteği
    socket.on('create-room', (roomSettings) => {
        const roomId = socket.id;
        const hostLang = roomSettings.lang === 'en' ? 'en' : 'tr';
        const defaultGuest = translations[hostLang].guest;
        
        const hostName = roomSettings.hostName || defaultGuest;
        const defaultName = hostLang === 'en' ? `${hostName}${translations[hostLang].defaultRoomName}` : `${hostName}${translations[hostLang].defaultRoomName}`;

        activeRooms[roomId] = {
            id: roomId,
            roomName: roomSettings.roomName || defaultName,
            hostName: hostName,
            worldType: roomSettings.worldType || 'Default',
            gameMode: roomSettings.gameMode || 'Survival',
            accessLevel: roomSettings.accessLevel || 'Public',
            cheats: roomSettings.cheats || 'Off',
            difficulty: roomSettings.difficulty || 'Normal',
            pvp: roomSettings.pvp || 'On',
            seed: roomSettings.seed || '',
            worldData: roomSettings.worldData || null,
            playerCount: 1,
            maxPlayers: 10,
            players: [{ id: socket.id, name: hostName }]
        };

        socket.join(roomId);
        console.log(`${translations[hostLang].roomCreated} ${activeRooms[roomId].roomName} (Mode: ${activeRooms[roomId].gameMode})`);
        
        io.emit('rooms-list', Object.values(activeRooms));
        socket.emit('room-created', roomId);
    });

    // 3. Bir odaya "Göz At" listesinden katılan oyuncu
    socket.on('join-room', ({ roomId, playerName, lang }) => {
        const currentLang = lang === 'en' ? 'en' : 'tr';
        
        if (activeRooms[roomId]) {
            socket.join(roomId);
            
            activeRooms[roomId].players.push({ id: socket.id, name: playerName });
            activeRooms[roomId].playerCount = activeRooms[roomId].players.length;
            
            console.log(`${playerName} joined ${activeRooms[roomId].roomName}`);
            
            io.to(roomId).emit('player-joined', { 
                id: socket.id, 
                name: playerName,
                settings: activeRooms[roomId]
            });
            
            io.emit('rooms-list', Object.values(activeRooms));
        } else {
            socket.emit('error-msg', translations[currentLang].serverNotFound);
        }
    });

    // 4. Bağlantı kesildiğinde (Oyuncu oyundan çıkarsa)
    socket.on('disconnect', () => {
        if (activeRooms[socket.id]) {
            console.log(`Host left, closing room: ${activeRooms[socket.id].roomName}`);
            
            // Odadaki diğer oyunculara kendi dillerinde kapanma mesajı gönderilir
            socket.to(socket.id).emit('room-closed', {
                tr: translations.tr.hostLeft,
                en: translations.en.hostLeft
            });
            
            delete activeRooms[socket.id];
            io.emit('rooms-list', Object.values(activeRooms));
        } else {
            Object.keys(activeRooms).forEach(roomId => {
                let room = activeRooms[roomId];
                let index = room.players.findIndex(p => p.id === socket.id);
                if (index !== -1) {
                    let pName = room.players[index].name;
                    room.players.splice(index, 1);
                    room.playerCount = room.players.length;
                    
                    io.to(roomId).emit('player-left', { id: socket.id, name: pName });
                    io.emit('rooms-list', Object.values(activeRooms));
                }
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`PLAY LEGENDS Backend is running on port ${PORT}`);
});
