FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/voice ./src/voice
COPY src/server ./src/server
COPY src/prompts ./src/prompts
COPY src/shared ./src/shared

ENV NODE_ENV=production
ENV INNGEST_DEV=0

USER node
EXPOSE 8081

CMD ["node", "--conditions=react-server", "--import", "tsx", "src/voice/worker.ts", "start"]
