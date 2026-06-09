# ============================================================================
# TCS Agentic AI — MCP Server (API-only)
#
# The dashboard is now a separate image (dashboard-react/Dockerfile).
# This image contains only the Node.js MCP server for cluster operations.
# Deployable on hub (MCP_MODE=hub) or spoke (MCP_MODE=spoke) clusters.
# ============================================================================

# Stage 1 — Install production dependencies
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src/ src/

# Stage 2 — Final runtime image
FROM node:20-alpine
LABEL maintainer="TCS Agentic AI <tcs-agentic-ai@tcs.com>"
LABEL description="TCS Agentic AI — MCP Server (cluster operations)"

ARG BUILD_HASH=""
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package.json .
USER 1001
ENV NODE_ENV=production
ENV BUILD_HASH=${BUILD_HASH}
EXPOSE 3000
CMD ["node", "src/index.js"]
