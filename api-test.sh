#!/bin/bash

# 🎮 Legends CE Launcher - API Test Script
# Kullanım: bash api-test.sh

API_URL="http://localhost:3000"

echo "╔════════════════════════════════════════╗"
echo "║  Legends CE Launcher - API Test       ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Renk kodları
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ============= Health Check =============
echo -e "${BLUE}1️⃣  Server Health Check${NC}"
echo "   GET $API_URL/api/health"
echo ""
curl -s "$API_URL/api/health" | jq '.' || echo "❌ Server not responding"
echo ""
echo ""

# ============= Tüm Versiyonlar =============
echo -e "${BLUE}2️⃣  Get All Game Versions${NC}"
echo "   GET $API_URL/api/game-versions"
echo ""
curl -s "$API_URL/api/game-versions" | jq '.' || echo "❌ Failed to fetch"
echo ""
echo ""

# ============= Final Versiyonlar =============
echo -e "${BLUE}3️⃣  Get Final Versions Only${NC}"
echo "   GET $API_URL/api/game-versions/final"
echo ""
curl -s "$API_URL/api/game-versions/final" | jq '.' || echo "❌ Failed to fetch"
echo ""
echo ""

# ============= Preview Versiyonlar =============
echo -e "${BLUE}4️⃣  Get Preview Versions Only${NC}"
echo "   GET $API_URL/api/game-versions/preview"
echo ""
curl -s "$API_URL/api/game-versions/preview" | jq '.' || echo "❌ Failed to fetch"
echo ""
echo ""

# ============= En Yeni Versiyon =============
echo -e "${BLUE}5️⃣  Get Latest Version${NC}"
echo "   GET $API_URL/api/latest-version"
echo ""
curl -s "$API_URL/api/latest-version" | jq '.' || echo "❌ Failed to fetch"
echo ""
echo ""

# ============= Güncelleme Kontrolü =============
echo -e "${BLUE}6️⃣  Check for Updates${NC}"
echo "   GET $API_URL/api/version-check?current=1.20.0"
echo ""
curl -s "$API_URL/api/version-check?current=1.20.0" | jq '.' || echo "❌ Failed to fetch"
echo ""
echo ""

# ============= Özet =============
echo -e "${GREEN}✅ Test tamamlandı!${NC}"
echo ""
echo "API Endpoints:"
echo "  • Tüm versiyonlar: GET /api/game-versions"
echo "  • Final versiyonlar: GET /api/game-versions/final"
echo "  • Preview versiyonlar: GET /api/game-versions/preview"
echo "  • En yeni: GET /api/latest-version"
echo "  • Güncelleme kontrolü: GET /api/version-check?current=X.X.X"
echo "  • Server durumu: GET /api/health"
echo ""
echo "Launcher: $API_URL"
echo ""
