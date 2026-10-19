FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:24-bookworm-slim
ENV NODE_ENV=production BIND_ADDRESS=0.0.0.0 DATABASE_PATH=/data/vault.sqlite
WORKDIR /app
COPY --from=build /app/dist/app.mjs ./dist/app.mjs
COPY --from=build /app/src/node.mjs /app/src/sqlite.mjs ./src/
COPY --from=build /app/migrations ./migrations
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node","src/node.mjs"]
