# ============================================================================
# TCS Agentic AI — Dashboard (Separated)
# Nginx serves the React SPA and reverse-proxies /api/* to the MCP server.
# ============================================================================

# Stage 1 — Build the React app
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2 — Nginx runtime
FROM nginx:1.27-alpine
LABEL maintainer="TCS Agentic AI <tcs-agentic-ai@tcs.com>"
LABEL description="TCS Agentic AI — Dashboard (React + Nginx)"

RUN rm -rf /usr/share/nginx/html/*
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown nginx:nginx /var/run/nginx.pid

USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
