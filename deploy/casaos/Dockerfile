# Fausth Lab — CasaOS / Docker 24/7 run surface (Node 22 + Python + tmux)
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    tmux git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Dependency layers first (compose bind-mounts override /app at runtime for live sync)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY engines/ts/package.json engines/ts/
COPY engines/py/pyproject.toml engines/py/

RUN pnpm install --frozen-lockfile

COPY engines/py engines/py
RUN pip3 install --break-system-packages -e engines/py

COPY . .

ENV NODE_ENV=production
ENV FAUSTH_LAB_PORT=8787
ENV FAUSTH_ROOT=/app

EXPOSE 8787

CMD ["node", "lab-ui/server.mjs"]
