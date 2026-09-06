/**
 * ============================================================================
 * VERSIONS ENDPOINT - versions.js
 * ============================================================================
 * 
 * /versions endpoint'i
 * Dosyaları tarar, tipi belirler ve JSON formatında döndürür
 * 
 * Kullanım (Express):
 * app.get('/versions', require('./versions'));
 */

const fs = require('fs');
const path = require('path');

/**
 * Göz ardı edilecek dosyalar
 * Bu dosyalar listelenmez
 */
const ignoreFiles = ['gameexp.html'];

/**
 * Dosya isminden versiyon numarasını çıkar
 * Örnekler:
 *   "game-1.9.0.html" → "1.9.0"
 *   "game-a-1.0.2.html" → "1.0.2"
 *   "game-b-5.3.2.html" → "5.3.2"
 *   "game-i-1.6.2.html" → "1.6.2"
 *   "game-1.0p1.html" → "1.0p1"
 *   "game-1.0Ip1.html" → "1.0Ip1"
 */
function extractVersionFromFilename(filename) {
  const nameWithoutExt = filename.replace(/\.html?$/i, '');
  let versionPart = nameWithoutExt.replace(/^game[-_]?/, '');
  
  if (versionPart && /^[a-z]+$/i.test(versionPart)) {
    return versionPart;
  }
  
  return versionPart || 'unknown';
}

/**
 * Dosya isminden tip belirle
 * 
 * ANA SÜRÜMLER (Main Releases):
 *   - game-i-X.X.X.html → indev
 *   - game-a-X.X.X.html → alpha
 *   - game-b-X.X.X.html → beta
 *   - game-X.X.X.html → release (varsayılan)
 * 
 * PREVIEW SÜRÜMLER (Preview Versions):
 *   - game-X.XpN.html → preview (sadece p)
 *   - game-X.XIpN.html → indev_preview (Ip takısı)
 *   - game-X.XApN.html → alpha_preview (Ap takısı)
 *   - game-X.XBpN.html → beta_preview (Bp takısı)
 *   - "preview" kelimesi → preview
 */
function determineVersionType(filename, version) {
  // ANA SÜRÜMLER (PREFIX KONTROLÜ)
  if (/^game-i-/i.test(filename)) return 'indev';
  if (/^game-a-/i.test(filename)) return 'alpha';
  if (/^game-b-/i.test(filename)) return 'beta';
  
  // PREVIEW SÜRÜMLER (TAKISU KONTROLÜ)
  // Özel Preview Takıları
  if (/Ip\d/i.test(version)) return 'indev_preview';
  if (/Bp\d/i.test(version)) return 'beta_preview';
  if (/Ap\d/i.test(version)) return 'alpha_preview';
  
  // Genel p takısı (sadece p - Preview)
  if (/p\d/i.test(version)) return 'preview';
  
  // "preview" kelimesi içeriyor
  if (/preview/i.test(filename)) return 'preview';
  
  // Varsayılan: Release
  return 'release';
}

/**
 * Versiyonu kategoriye ayır
 * 
 * FINAL kategorisi:
 *   - release, indev, alpha, beta
 * 
 * PREVIEW kategorisi:
 *   - preview, indev_preview, alpha_preview, beta_preview
 */
function getCategory(type) {
  if (['preview', 'indev_preview', 'alpha_preview', 'beta_preview'].includes(type)) {
    return 'preview';
  }
  return 'final'; // release, indev, alpha, beta hepsi final kategorisinde
}

/**
 * Sunucudaki oyun dosyalarını tarar
 */
function scanGameFiles() {
  try {
    const gameDir = path.join(__dirname, 'public');
    
    if (!fs.existsSync(gameDir)) {
      console.warn(`⚠️ Dizin bulunamadı: ${gameDir}`);
      return [];
    }
    
    const files = fs.readdirSync(gameDir);
    const versions = [];
    
    files.forEach(file => {
      // game-*.html veya game.html kalıbı
      if (!/^game.*\.html?$/i.test(file)) return;
      
      // Göz ardı edilecek dosyalar
      if (ignoreFiles.includes(file)) {
        console.log(`⏭️  Göz ardı ediliyor: ${file}`);
        return;
      }
      
      const version = extractVersionFromFilename(file);
      const type = determineVersionType(file, version);
      const category = getCategory(type);
      
      versions.push({
        filename: file,
        version: version,
        type: type,
        category: category
      });
    });
    
    // Versiyon numarasına göre ters sırala
    versions.sort((a, b) => {
      const aParts = a.version.match(/\d+/g) || [];
      const bParts = b.version.match(/\d+/g) || [];
      
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aNum = parseInt(aParts[i] || 0);
        const bNum = parseInt(bParts[i] || 0);
        if (aNum !== bNum) return bNum - aNum;
      }
      
      return b.version.localeCompare(a.version);
    });
    
    return versions;
  } catch (error) {
    console.error('❌ Dosya tarama hatası:', error);
    return [];
  }
}

/**
 * Express route handler
 * GET /versions
 */
module.exports = (req, res) => {
  const versions = scanGameFiles();
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  
  res.status(200).json({
    success: true,
    count: versions.length,
    timestamp: new Date().toISOString(),
    versions: versions
  });
};
