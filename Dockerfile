FROM node:24-bookworm-slim AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY README.md LICENSE ./
COPY docs ./docs
RUN npm pack --pack-destination /tmp
RUN npm install --prefix /runtime --omit=dev --no-audit --no-fund /tmp/edgaralochi-yada-*.tgz

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /runtime/ ./
COPY deploy/server.mjs ./server.mjs
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
