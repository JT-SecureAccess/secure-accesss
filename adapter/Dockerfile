FROM node:22-alpine
WORKDIR /app
COPY adapter/package.json ./package.json
RUN npm install --omit=dev
COPY adapter/server.mjs ./server.mjs
COPY adapter/db.mjs ./db.mjs
COPY adapter/providers.mjs ./providers.mjs
COPY adapter/migrations ./migrations
COPY tenant-template ./tenant-template
ENV NODE_ENV=production
CMD ["node","server.mjs"]