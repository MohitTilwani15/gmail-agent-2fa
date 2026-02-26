FROM node:lts-slim

# Install native build deps for better-sqlite3, then enable pnpm
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential python3 && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DB_PATH=/app/data/data.db

EXPOSE 3000

CMD ["node", "src/index.js"]
