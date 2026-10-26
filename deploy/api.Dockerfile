# syntax=docker/dockerfile:1
# One image for migrate, api and maintenance (research R16); compose picks the command.
# Build from the repository root: docker build -f deploy/api.Dockerfile .

ARG NODE_IMAGE=node:24.22.1-alpine3.24

# --- build: full install, generate the Prisma client, compile TypeScript -------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY backend backend
RUN npm run build -w @po/backend

# --- runtime: production dependencies only, non-root ---------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
# The Prisma CLI is a runtime dependency: migrate runs `prisma migrate deploy`.
RUN npm ci --omit=dev --no-audit --no-fund -w @po/backend -w @po/contracts \
  && npm cache clean --force

COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/backend/dist backend/dist
COPY backend/prisma backend/prisma
COPY backend/prisma.config.ts backend/
COPY backend/db-init backend/db-init

WORKDIR /app/backend
USER node

EXPOSE 3000 9464
CMD ["node", "dist/server.js"]
