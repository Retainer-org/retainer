# The billing worker, and nothing else: no web app, no CLI, no contracts, no scripts.
#
# Build from the repository root (railway.json points here):
#   docker build -f apps/worker/Dockerfile -t retainer-worker .
#
# Every workspace's package.json is copied only so `npm ci` can check the lockfile;
# `--workspace` then installs the worker's dependencies alone. Configuration comes
# from the environment at run time -- no .env file is ever in the image.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/chain/package.json packages/chain/
COPY packages/db/package.json packages/db/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
RUN npm ci --omit=dev --workspace=@retainer/worker --no-audit --no-fund

COPY packages/chain/src packages/chain/src
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY apps/worker/src apps/worker/src

USER node
CMD ["node", "apps/worker/src/index.js"]
