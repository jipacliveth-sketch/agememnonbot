FROM node:24-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json

RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production

RUN pnpm run build

EXPOSE 8080

CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]