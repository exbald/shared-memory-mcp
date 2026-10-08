# Self-hosted image (Coolify). Node 24 runs the TypeScript sources directly
# (type stripping), so there is no build step.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY api ./api
COPY server.ts ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.ts"]
