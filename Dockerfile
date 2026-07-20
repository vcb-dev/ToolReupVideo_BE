# syntax=docker/dockerfile:1

# ---------- Build stage ----------
FROM node:22-slim AS builder
WORKDIR /app

# openssl cần cho Prisma engine
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Cài deps trước (tận dụng cache). Copy prisma/ để postinstall `prisma generate` chạy được.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# Copy mã nguồn rồi build (NestJS -> dist/)
COPY . .
RUN npm run build

# ---------- Runtime stage ----------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Chỉ cài deps production; postinstall tự chạy `prisma generate`
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# Copy bản build đã biên dịch
COPY --from=builder /app/dist ./dist

# PORT mặc định 5001 (đọc từ env lúc chạy)
EXPOSE 5001
CMD ["node", "dist/main"]
