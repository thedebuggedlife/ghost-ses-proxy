FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/dist dist/
COPY package.json ./

RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --spider -q http://localhost:${PORT:-3003}/health || exit 1

EXPOSE 3003

CMD ["node", "dist/index.js"]
