#!/bin/bash
# 1-Click Hetzner Cloud Automated Deployment Script

set -e

echo "🚀 Starting Hetzner Deployment for Cold Email Campaign Generator..."

# Update system packages
sudo apt-get update -y
sudo apt-get install -y git curl docker.io docker-compose-v2

# Start & Enable Docker
sudo systemctl enable --now docker

# Create working directory
APP_DIR="/opt/emaildrafter"
sudo mkdir -p $APP_DIR
sudo chown -R $USER:$USER $APP_DIR

# Clone or pull latest repository
if [ -d "$APP_DIR/.git" ]; then
  echo "📦 Updating existing repository..."
  cd $APP_DIR
  git pull origin main
else
  echo "📦 Cloning repository..."
  git clone https://github.com/holadin26-design/emaildrafter.git $APP_DIR
  cd $APP_DIR
fi

# Build and launch Docker container
echo "🐳 Launching Docker container..."
docker compose down || true
docker compose up -d --build

echo ""
echo "======================================================="
echo "🎉 DEPLOYMENT COMPLETE!"
echo "Your app is now live at: http://$(curl -s ifconfig.me):3000"
echo "======================================================="
