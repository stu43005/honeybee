# --------------> The build image
FROM node:20-bookworm AS build

WORKDIR /app

# build app
COPY package*.json yarn.lock /app/
RUN yarn install --frozen-lockfile --production=false
COPY tsconfig.json /app/
COPY src /app/src
RUN yarn build
RUN yarn install --frozen-lockfile --production=true

# --------------> The production image
FROM node:20-bookworm-slim

ENV NODE_ENV production

USER node
WORKDIR /app

# setup app
COPY --chown=node:node package*.json yarn.lock /app/
COPY --chown=node:node --from=build /app/node_modules /app/node_modules
COPY --chown=node:node --from=build /app/lib /app/lib

ENTRYPOINT ["node", "lib/index.js"]
CMD ["--help"]
