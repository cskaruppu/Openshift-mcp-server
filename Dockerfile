FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src/ src/

FROM node:20-alpine
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY dashboard/ dashboard/
COPY package.json .
USER 1001
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
