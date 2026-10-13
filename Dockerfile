# Node 24 runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY lib ./lib
COPY server.ts ./

USER node
EXPOSE 3000

# The server starts listening once the database schema is ready (it retries for about 30 s).
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "server.ts"]
