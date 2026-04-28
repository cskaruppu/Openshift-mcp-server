FROM node:20-alpine AS build
WORKDIR /app
COPY package.json .
RUN npm ci --omit=dev 2>/dev/null || true
COPY src/ src/

FROM node:20-alpine
LABEL maintainer="TCS CloudNexus AI <cloudnexus@tcs.com>"
LABEL description="TCS CloudNexus AI — Kubernetes Cluster Agent"
LABEL org.opencontainers.image.source="https://github.com/cskaruppu/openshift-mcp-server"

RUN addgroup -g 1001 -S cloudnexus && adduser -u 1001 -S agent -G cloudnexus

WORKDIR /app

COPY --from=build /app/src ./src
COPY --from=build /app/package.json .

RUN chown -R 1001:1001 /app

USER 1001

ENV NODE_ENV=production
ENV PORT=8080
ENV NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:8080/healthz || exit 1

CMD ["node", "src/index.js"]
