# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN --mount=type=secret,id=proxy_ca,target=/tmp/proxy-ca.pem \
    if [ -f /tmp/proxy-ca.pem ]; then NODE_EXTRA_CA_CERTS=/tmp/proxy-ca.pem npm ci; else npm ci; fi
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production APP_MODE=mes HOST=0.0.0.0 PORT=3000 FILES_ROOT=/data/files DRIVE_TOKEN_FILE=/data/drive-credentials.json
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/mes/dist ./mes/dist
COPY --from=build --chown=node:node /app/start.mjs ./start.mjs
RUN mkdir -p /data/files && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","start.mjs"]
