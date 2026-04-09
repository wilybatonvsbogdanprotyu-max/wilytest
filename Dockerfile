FROM node:22-slim

RUN npm install -g pnpm@10

WORKDIR /app

COPY pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY package.json ./
COPY tsconfig.base.json ./
COPY tsconfig.json ./

COPY scripts/package.json ./scripts/

RUN pnpm install --filter @workspace/scripts --no-frozen-lockfile

COPY scripts/ ./scripts/

CMD ["pnpm", "--filter", "@workspace/scripts", "run", "bot"]
