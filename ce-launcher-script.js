// ============================================================================
// CE-LAUNCHER.HTML İÇİN GEREKLİ SCRIPT KODLARI
// ============================================================================

// ============= STATIC FALLBACK VERSIONS =============
const STATIC_AVAILABLE_VERSIONS = [
  // ANA SÜRÜMLER
  { filename: 'game-1.9.0.html', version: '1.9.0', type: 'release', category: 'final' },
  { filename: 'game-b-5.3.2.html', version: '5.3.2', type: 'beta', category: 'final' },
  { filename: 'game-a-1.0.2.html', version: '1.0.2', type: 'alpha', category: 'final' },
  { filename: 'game-i-1.6.2.html', version: '1.6.2', type: 'indev', category: 'final' },
  // PREVIEW SÜRÜMLER
  { filename: 'game-1.0p1.html', version: '1.0p1', type: 'preview', category: 'preview' },
  { filename: 'game-1.0Ip1.html', version: '1.0Ip1', type: 'indev_preview', category: 'preview' },
  { filename: 'game-1.0Ap1.html', version: '1.0Ap1', type: 'alpha_preview', category: 'preview' },
  { filename: 'game-1.0Bp1.html', version: '1.0Bp1', type: 'beta_preview', category: 'preview' }
];

// ============= HELPER FUNCTIONS =============

/**
 * Versiyonu kategoriye ayır (final veya preview)
 */
function getVersionCategory(type) {
  if (['preview', 'indev_preview', 'alpha_preview', 'beta_preview'].includes(type)) {
    return 'preview';
  }
  return 'final';
}

/**
 * Dinamik versiyon etiketi oluştur
 * 
 * ANA SÜRÜMLER (Final Kategorisi):
 *   - type: 'release' → "Version 1.9.0"
 *   - type: 'indev' → "Version 1.6.2 (Indev)"
 *   - type: 'alpha' → "Version 1.0.2 (Alpha)"
 *   - type: 'beta' → "Version 5.3.2 (Beta)"
 * 
 * PREVIEW SÜRÜMLER (Preview Kategorisi):
 *   - type: 'preview' → "Preview 1.0p1"
 *   - type: 'indev_preview' → "I-Preview 1.0Ip1"
 *   - type: 'alpha_preview' → "A-Preview 1.0Ap1"
 *   - type: 'beta_preview' → "B-Preview 1.0Bp1"
 */
function parseVersionLabel(filename, version, type) {
  // ANA SÜRÜMLER (FINAL KATEGORISI)
  if (type === 'release') {
    return `Version ${version}`;
  }
  if (type === 'indev') {
    return `Version ${version} (Indev)`;
  }
  if (type === 'alpha') {
    return `Version ${version} (Alpha)`;
  }
  if (type === 'beta') {
    return `Version ${version} (Beta)`;
  }

  // PREVIEW SÜRÜMLER (PREVIEW KATEGORISI)
  if (type === 'indev_preview' || /Ip\d/i.test(version)) {
    return `I-Preview ${version}`;
  }
  if (type === 'beta_preview' || /Bp\d/i.test(version)) {
    return `B-Preview ${version}`;
  }
  if (type === 'alpha_preview' || /Ap\d/i.test(version)) {
    return `A-Preview ${version}`;
  }
  if (type === 'preview' || /p\d/i.test(version)) {
    return `Preview ${version}`;
  }

  return `${version}`;
}

/**
 * /versions API'sinden versiyon listesini çek
 * Başarısız olursa STATIC_AVAILABLE_VERSIONS yedeklemeyi kullan
 */
async function updateVersionDropdown() {
  try {
    console.log('📡 /versions endpoint\'inden versiyonlar çekiliyor...');
    
    const response = await fetch('/versions', {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const versions = data.versions || data || [];

    console.log(`✅ ${versions.length} versiyon sunucudan yüklendi`);
    populateVersionDropdown(versions);
    
  } catch (error) {
    console.warn(`⚠️ /versions çekilemedi: ${error.message}`);
    console.log('📦 Yedek versiyon listesi kullanılıyor...');
    
    // Fallback: Statik liste kullan
    populateVersionDropdown(STATIC_AVAILABLE_VERSIONS);
  }
}

/**
 * Dropdown'ı kategorilere göre doldur
 * 
 * Yapı:
 * - Official Releases (release, indev, alpha, beta)
 * - Preview Builds (preview, indev_preview, alpha_preview, beta_preview)
 */
function populateVersionDropdown(allVersions = []) {
  const dropdown = document.getElementById('versionSelect');
  
  if (!dropdown) {
    console.error('❌ #versionSelect element bulunamadı');
    return;
  }

  // Dropdown'ı temizle
  dropdown.innerHTML = '';

  if (!allVersions || allVersions.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '⚠️ Versiyon bulunamadı';
    dropdown.appendChild(option);
    return;
  }

  // OFFICIAL RELEASES grubu (final kategorisi: release, indev, alpha, beta)
  const officialVersions = allVersions.filter(v => v.category === 'final');
  
  if (officialVersions.length > 0) {
    const officialGroup = document.createElement('optgroup');
    officialGroup.label = '📦 Official Releases';

    officialVersions.forEach(ver => {
      const option = document.createElement('option');
      option.value = ver.filename;
      option.setAttribute('data-type', ver.type);
      option.setAttribute('data-category', 'final');
      option.textContent = parseVersionLabel(ver.filename, ver.version, ver.type);
      officialGroup.appendChild(option);
    });

    dropdown.appendChild(officialGroup);
  }

  // PREVIEW BUILDS grubu (preview kategorisi)
  const previewVersions = allVersions.filter(v => v.category === 'preview');
  
  if (previewVersions.length > 0) {
    const previewGroup = document.createElement('optgroup');
    previewGroup.label = '🔮 Preview Builds';

    previewVersions.forEach(ver => {
      const option = document.createElement('option');
      option.value = ver.filename;
      option.setAttribute('data-type', ver.type);
      option.setAttribute('data-category', 'preview');
      option.textContent = parseVersionLabel(ver.filename, ver.version, ver.type);
      previewGroup.appendChild(option);
    });

    dropdown.appendChild(previewGroup);
  }

  console.log(`✅ Dropdown dolduruldu: ${dropdown.options.length} seçenek`);
}

// ============================================================================
// İNİSYALİZASYON
// ============================================================================

// Sayfa yüklendiğinde dropdown'ı güncelle
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateVersionDropdown);
} else {
  updateVersionDropdown();
}
