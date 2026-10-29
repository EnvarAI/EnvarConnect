FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY contracts ./contracts
COPY scripts ./scripts
COPY README.md LICENSE ./
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production HOME=/data
WORKDIR /opt/envar-connect
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/contracts ./contracts
COPY --from=build /build/package.json /build/README.md /build/LICENSE ./
RUN groupadd --gid 10001 envar-connect \
    && useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home envar-connect \
    && mkdir /data && chown 10001:10001 /data && chmod 700 /data \
    && printf '#!/bin/sh\nexec node /opt/envar-connect/dist/cli.js "$@"\n' > /usr/local/bin/envar-connect \
    && chmod 755 /usr/local/bin/envar-connect
USER 10001:10001
WORKDIR /data
ENTRYPOINT ["envar-connect"]
CMD ["--help"]
