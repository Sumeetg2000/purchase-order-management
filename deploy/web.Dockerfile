# syntax=docker/dockerfile:1
# The web app and the same-origin edge in one nginx container (research R16).
# Build from the repository root: docker build -f deploy/web.Dockerfile .

ARG NODE_IMAGE=node:24.22.1-alpine3.24

# --- build: the React app -----------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY frontend frontend
RUN npm run build -w @po/frontend

# --- runtime: nginx as its unprivileged user ----------------------------------------
FROM nginx:1.30.6-alpine

# No `user` directive and a pid file in /tmp, so the master process runs unprivileged.
RUN sed -i -e '/^user /d' -e 's#^pid .*#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
  && chown -R nginx:nginx /var/cache/nginx

COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080
