# ============================================================================
# Stage 1 — Build the React dashboard (dashboard-react -> dashboard/app)
# Self-contained: the UI is always built reproducibly inside the image, so no
# host Node toolchain is required and a stale committed build can never ship.
# ============================================================================
FROM node:20-alpine AS ui-build
WORKDIR /app/dashboard-react
COPY dashboard-react/package.json dashboard-react/package-lock.json* ./
RUN npm ci
COPY dashboard-react/ ./
# vite.config.js outDir is ../dashboard/app, so this writes to /app/dashboard/app
RUN npm run build

# ============================================================================
# Stage 2 — Install hub server production dependencies
# ============================================================================
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src/ src/

# ============================================================================
# Stage 3 — Final runtime image
# ============================================================================
FROM node:20-alpine
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
# Legacy dashboard (accessible at /old-app)
COPY dashboard/index.html dashboard/index.html
# React app (accessible at /)
COPY --from=ui-build /app/dashboard/app ./dashboard/app
COPY package.json .
USER 1001
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
