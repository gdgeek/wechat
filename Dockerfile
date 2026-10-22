FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.migrate.json ./
COPY src ./src
COPY scripts/migrate.ts scripts/record-preservation.ts scripts/file-download-price.ts ./scripts/
RUN npm run build && npx tsc -p tsconfig.migrate.json && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Shanghai PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-tools ./dist-tools
COPY --chown=node:node database ./dist-tools/database
COPY --chown=node:node package.json ./
ARG GIT_COMMIT
ARG BUILD_TIME
ENV GIT_COMMIT=$GIT_COMMIT BUILD_TIME=$BUILD_TIME
LABEL org.opencontainers.image.title="wechat2" \
      org.opencontainers.image.revision=$GIT_COMMIT \
      org.opencontainers.image.created=$BUILD_TIME
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=12s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
