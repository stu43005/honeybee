# --------------> The build image
FROM node:24-bookworm AS build

WORKDIR /app

# build app
COPY package*.json /app/
RUN npm ci
COPY tsconfig.json /app/
COPY src /app/src
RUN npm run build
RUN npm prune --omit=dev

# --------------> The production image
FROM node:24-bookworm-slim

ENV NODE_ENV=production

USER node
WORKDIR /app

# setup app
COPY --chown=node:node package*.json /app/
COPY --chown=node:node --from=build /app/node_modules /app/node_modules
COPY --chown=node:node --from=build /app/dist /app/dist

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
