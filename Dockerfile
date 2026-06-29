# ============================================================================
# TCS Agentic AI — MCP Server (API-only)
#
# The dashboard is a separate image (console/Dockerfile).
# This image contains only the Node.js MCP server: APIs + cluster operations.
# One image, two roles: control plane (MCP_MODE=control, management bundle)
# or per-cluster stateless data plane (MCP_MODE=spoke).
# ============================================================================

# Stage 1 — Install production dependencies
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev: skip doc-generation tooling (exceljs/pptxgenjs/xlsx) not used at runtime
# --no-audit --no-fund: keep the build log clean (audit/funding notices are noise here)
RUN npm ci --omit=dev --no-audit --no-fund
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
