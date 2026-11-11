FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY tsconfig.json ./
COPY docs/testing/test-report.json ./docs/testing/test-report.json
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "server/src/index.ts"]
