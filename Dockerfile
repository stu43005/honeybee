# --------------> The build image
FROM node:20-bookworm AS build

# setup tini
ENV TINI_VERSION v0.19.0
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini /tini
RUN chmod +x /tini

WORKDIR /app

# build app
COPY package*.json yarn.lock /app
RUN yarn install --frozen-lockfile --production=false
COPY tsconfig.json /app/
COPY src /app/src
RUN yarn build
RUN yarn install --frozen-lockfile --production=true

# --------------> The production image
FROM node:20-bookworm-slim

ENV NODE_ENV production

# setup tini
COPY --from=build /tini /tini
ENTRYPOINT ["/tini", "--"]

USER node
WORKDIR /app

# setup app
COPY --chown=node:node package*.json yarn.lock /app
COPY --chown=node:node --from=build /app/node_modules /app/node_modules
COPY --chown=node:node --from=build /app/lib /app/lib

CMD ["node", "lib/index.js"]
