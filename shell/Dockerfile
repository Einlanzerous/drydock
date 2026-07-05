# Prod shell image: Vite build served as static files by nginx (DRY-19).
# Build context is the REPO ROOT (bun workspace), not shell/:
#   docker build -f shell/Dockerfile -t ghcr.io/einlanzerous/drydock/shell .
FROM oven/bun:1.3-alpine AS build
# vue-tsc must run under real Node — under bun's node-shebang shim it fails to
# resolve .vue modules. Matches the host setup (bun manages, node executes).
RUN apk add --no-cache nodejs
WORKDIR /app
# Workspace manifests first so installs layer-cache across source edits.
# --ignore-scripts skips the root postinstall (node-pty native build — daemon
# only, needs node-gyp; irrelevant to the shell bundle).
COPY package.json bun.lock ./
COPY daemon/package.json daemon/
COPY shell/package.json shell/
RUN bun install --frozen-lockfile --ignore-scripts
COPY shell/ shell/
RUN bun run --filter '@drydock/shell' build

FROM nginx:1.27-alpine
COPY shell/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY shell/docker/20-drydock-config.sh /docker-entrypoint.d/20-drydock-config.sh
RUN chmod +x /docker-entrypoint.d/20-drydock-config.sh
COPY --from=build /app/shell/dist /usr/share/nginx/html
