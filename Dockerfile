# Use official Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package manifests
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application source files
COPY . .

# Expose port 3000
EXPOSE 3000

# Environment
ENV PORT=3000
ENV NODE_ENV=production

# Start application server
CMD ["node", "server.js"]
