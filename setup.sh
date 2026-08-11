#!/bin/bash
# 1-Click Hetzner Cloud Automated Deployment Script (PM2 Engine)

set -e

echo "🚀 Starting Hetzner Deployment for Cold Email Campaign Generator..."

APP_DIR="/opt/emaildrafter"
mkdir -p $APP_DIR

if [ -d "$APP_DIR/.git" ]; then
  echo "📦 Updating repository..."
  cd $APP_DIR
  git pull origin main
else
  echo "📦 Cloning repository..."
  git clone https://github.com/holadin26-design/emaildrafter.git $APP_DIR
  cd $APP_DIR
fi

echo "📦 Installing npm dependencies..."
npm install

echo "⚡ Configuring PM2 Process Manager..."
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2
fi

pm2 delete email-drafter 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "======================================================="
echo "🎉 DEPLOYMENT COMPLETE!"
echo "Your app is live at: http://87.99.139.116:3000"
echo "======================================================="
