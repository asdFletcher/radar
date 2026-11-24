FROM node:22-alpine
WORKDIR /app

# Only the backend's runtime dependency (ws). Electron and friends are dev-only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY backend ./backend
COPY renderer ./renderer
COPY index.html ./

ENV NODE_ENV=production BIND=0.0.0.0
CMD ["node", "backend/server.js"]
