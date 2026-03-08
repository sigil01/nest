FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22

# Tools pi expects
RUN apt-get update && apt-get install -y \
    git openssh-client curl wget jq ripgrep fd-find fzf \
    tree less vim-tiny build-essential python3 python3-pip \
    python3-venv ca-certificates dnsutils iptables \
    && rm -rf /var/lib/apt/lists/*

# pi coding agent
RUN npm install -g @mariozechner/pi-coding-agent

# nest kernel
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/

# Plugins — ship examples, agent can add more at runtime
COPY plugins/ plugins/

# Pi extensions
COPY src/extensions/ extensions/

COPY scripts/entrypoint.sh /entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8484/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/main.js", "/config/config.yaml"]
