# ============================================================================
# TCS Agentic AI — Dashboard (OpenShift-compatible)
#
# Multi-stage: build React with Vite, serve with Nginx.
# OpenShift runs containers with a random UID (not root, not nginx).
# All writable paths use /tmp so any UID can write.
# ============================================================================

# Stage 1 — Build the React app
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2 — Nginx runtime (OpenShift-safe)
FROM nginx:1.27-alpine
LABEL maintainer="TCS Agentic AI <tcs-agentic-ai@tcs.com>"
LABEL description="TCS Agentic AI — Dashboard (React + Nginx)"

# Remove default nginx config entirely — we supply our own as nginx.conf
RUN rm -rf /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*

# Copy built React app
COPY --from=build /app/dist /usr/share/nginx/html

# Copy our OpenShift-compatible nginx.conf (uses /tmp for all writable paths)
COPY nginx.conf /etc/nginx/nginx.conf

# Make directories writable by any UID (OpenShift assigns random UIDs)
RUN chmod -R g+rwx /var/cache/nginx /var/log/nginx /usr/share/nginx/html && \
    chgrp -R 0 /var/cache/nginx /var/log/nginx /usr/share/nginx/html && \
    mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp && \
    chmod -R 777 /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp

EXPOSE 8080

# Do NOT set USER — OpenShift assigns a random UID from the namespace range.
# The nginx.conf uses /tmp for pid + temp files so any UID works.

CMD ["nginx", "-g", "daemon off;"]
