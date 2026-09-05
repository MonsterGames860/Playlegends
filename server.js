/**
 * Legends CE Launcher - Backend Server (Node.js + Express)
 * 
 * Kullanım:
 * 1. npm install express cors
 * 2. node server.js
 * 3. http://localhost:3000 adresinden erişin
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Launcher HTML'lerini serve et

// ============= VERSION PARSING REGEX =============
const VERSION_PATTERNS = {
  final: [
    { regex: /^game-([ib])-(\d+\.\d+\.\d+)\.html$/i, type: 'final', phase: (m) => `${m[1].toUpperCase()}-` },
    { regex: /^game-([ia])-(\d+\.\d+\.\d+)\.html$/i, type: 'final', phase: (m) => `${m[1].toUpperCase()}-` },
    { regex: /^game-([ab])-(\d+\.\d+\.\d+)\.html$/i, type: 'final', phase: (m) => `${m[1].toUpperCase()}-` },
    { regex: /^game-(\d+\.\d+\.\d+)\.html$/i, type: 'final', phase: () => '', version: (m) => m[1] },
    { regex: /^game\.html$/i, type: 'final', phase: () => '', version: () => '1.0.0' }
  ],
  preview: [
    { regex: /^game-(\d+\.\d+)([VIAB])p(\d+)\.html$/i, type: 'preview' },
    { regex: /^game-(\d+\.\d+)p(\d+)\.html$/i, type: 'preview' },
    { regex: /^gameexp\.html$/i, type: 'preview', version: () => '0.1.0p1' }
  ]
};

/**
 * HTML dosyasından version'u parse et
 */
function parseGameFile(filename) {
  // Try final versions first
  for (const pattern of VERSION_PATTERNS.final) {
    const match = filename.match(pattern.regex);
    if (match) {
      const version = pattern.version ? pattern.version(match) : match[2] || '1.0.0';
      const phase = pattern.phase ? pattern.phase(match) : '';
      return {
        filename,
        type: 'final',
        version,
        phase: phase,
        displayName: `Legends ${phase}${version}`,
        icon: 'ce-launcher-logo-192.png'
      };
    }
  }

  // Try preview versions
  for (const pattern of VERSION_PATTERNS.preview) {
    const match = filename.match(pattern.regex);
    if (match) {
      let version = pattern.version ? pattern.version(match) : '';
      let phase = '';
      
      if (!version) {
        if (match[2]) {
          // Has phase letter (V/I/A/B)
          phase = `${match[2]}-Preview `;
          version = `${match[1]}p${match[3]}`;
        } else {
          version = `${match[1]}p${match[2]}`;
        }
      }
      
      return {
        filename,
        type: 'preview',
        version,
        phase: phase,
        displayName: `Legends ${phase}${version}`,
        icon: 'ce-launcher-logo-512.png'
      };
    }
  }

  return null;
}

/**
 * Version string'ini parse et
 */
function parseVersion(versionStr) {
  if (!versionStr) return [0, 0, 0];
  const parts = versionStr.split('.').map(p => parseInt(p) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * İki version'u karşılaştır
 */
function compareVersions(versionA, versionB) {
  const [majA, minA, patchA] = parseVersion(versionA);
  const [majB, minB, patchB] = parseVersion(versionB);

  if (majA !== majB) return majB - majA;
  if (minA !== minB) return minB - minA;
  return patchB - patchA;
}

/**
 * Game dosyalarını tarayıp sıralı array döndür
 */
function detectGameVersions() {
  try {
    const files = fs.readdirSync(__dirname);
    const gameFiles = files.filter(f => f.startsWith('game') && f.endsWith('.html'));
    
    const parsed = gameFiles
      .map(parseGameFile)
      .filter(v => v !== null);

    // En yeni versiyonlar ilk sıraya
    parsed.sort((a, b) => compareVersions(a.version, b.version));

    return parsed;
  } catch (error) {
    console.error('Error detecting game versions:', error);
    return [];
  }
}

// ============= API ENDPOINTS =============

/**
 * GET /api/game-versions
 * Tüm mevcut oyun sürümlerini döndür
 */
app.get('/api/game-versions', (req, res) => {
  try {
    const versions = detectGameVersions();
    res.json({
      success: true,
      data: versions,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/game-versions/:type
 * Belirli tipte sürümleri döndür (final|preview)
 */
app.get('/api/game-versions/:type', (req, res) => {
  try {
    const type = req.params.type.toLowerCase();
    if (!['final', 'preview'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid type. Use "final" or "preview"'
      });
    }

    const versions = detectGameVersions().filter(v => v.type === type);
    res.json({
      success: true,
      type: type,
      data: versions,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/latest-version
 * En yeni sürümü döndür
 */
app.get('/api/latest-version', (req, res) => {
  try {
    const versions = detectGameVersions();
    if (versions.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No game versions found'
      });
    }
    res.json({
      success: true,
      data: versions[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/version-check
 * Belirli bir sürümden daha yeni sürüm var mı kontrol et
 * Örn: /api/version-check?current=1.19.0
 */
app.get('/api/version-check', (req, res) => {
  try {
    const currentVersion = req.query.current;
    if (!currentVersion) {
      return res.status(400).json({
        success: false,
        error: 'current version required'
      });
    }

    const versions = detectGameVersions();
    const latest = versions[0];

    if (!latest) {
      return res.status(404).json({
        success: false,
        error: 'No game versions found'
      });
    }

    const hasUpdate = compareVersions(latest.version, currentVersion) > 0;

    res.json({
      success: true,
      currentVersion: currentVersion,
      latestVersion: latest.version,
      hasUpdate: hasUpdate,
      data: hasUpdate ? latest : null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============= STATIC FILES & LAUNCHER =============

/**
 * GET /
 * Ana launcher HTML'ini serve et
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ce-launcher.html'));
});

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    versions: detectGameVersions().length
  });
});

// ============= ERROR HANDLING =============

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ============= SERVER START =============

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   Legends CE Launcher - Backend       ║
╚════════════════════════════════════════╝

📍 Server running: http://localhost:${PORT}

📡 API Endpoints:
   GET  /api/game-versions          → Tüm versiyonlar
   GET  /api/game-versions/final    → Final versiyonlar
   GET  /api/game-versions/preview  → Preview versiyonlar
   GET  /api/latest-version         → En yeni sürüm
   GET  /api/version-check?current=X → Güncelleme kontrolü
   GET  /api/health                 → Server durumu

🎮 Detected Versions:
${detectGameVersions().map(v => `   • ${v.displayName} (${v.filename})`).join('\n')}

Launcher açmak için: http://localhost:${PORT}
  `);
});

module.exports = app;
