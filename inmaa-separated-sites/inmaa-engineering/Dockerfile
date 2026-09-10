FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server.mjs ./
COPY lib ./lib
COPY apps ./apps
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.mjs"]
