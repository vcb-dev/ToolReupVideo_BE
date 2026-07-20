# syntax=docker/dockerfile:1

# ---------- Build stage ----------
FROM node:22-slim AS builder
WORKDIR /app

# openssl cần cho Prisma engine
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .

# Prisma generate + Nest build cần DATABASE_URL (dummy cho CI/Docker build)
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN rm -rf dist tsconfig.tsbuildinfo && npm run build
RUN npm prune --omit=dev

# ---------- Runtime stage ----------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Railway inject PORT lúc chạy; mặc định 5001 cho local
ENV PORT=5001
EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
