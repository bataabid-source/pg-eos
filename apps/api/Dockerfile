# apps/api/Dockerfile — X part 5c. The ONE PG-EOS image (ADR-0006 §1): the `api` service runs it as
# is; the `worker` service runs the same image with a command override (infra/docker/docker-compose.yml).
# Whole workspace: both apps run from TypeScript source under tsx, workspace packages resolve through
# their built dist/ (pnpm build), and apps/api loads modules/** at runtime. No secret at build time.
FROM node:22-bookworm-slim

# psql 16 for database/schema/apply.sh (bookworm ships 15) from the PGDG repository; curl is only
# needed to fetch the repository key and is removed in the same layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/* \
 && psql --version | grep -q ' 16'

# corepack as root caches under /root unless COREPACK_HOME is a world-readable path.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
 && corepack prepare pnpm@9.15.9 --activate \
 && chmod -R a+rX /opt/corepack

WORKDIR /app
COPY --chown=node:node . .

# Install and build as root, then hand the tree to `node` in the same layer. PUPPETEER_SKIP_DOWNLOAD:
# no Chrome build exists for linux/arm64 and the slim base lacks its libraries (PDF rendering in the
# image is a later row). The symlink lets `docker compose run --rm api bash database/schema/apply.sh`
# resolve from WORKDIR /app/apps/api (doc 42 §8.1 shape).
RUN PUPPETEER_SKIP_DOWNLOAD=true TURBO_TELEMETRY_DISABLED=1 pnpm install --frozen-lockfile \
 && TURBO_TELEMETRY_DISABLED=1 pnpm build \
 && ln -s ../../database /app/apps/api/database \
 && chown -R node:node /app

USER node
ENV NODE_ENV=production
HEALTHCHECK --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/api
CMD ["node","--import","tsx","src/main.ts"]
