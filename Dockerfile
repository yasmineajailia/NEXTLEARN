# NextLearn Node/Express app (API + static frontend).
# Multi-stage: compile TypeScript in a full-deps stage, ship only prod deps.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Compiled server + everything the server reads at runtime.
COPY --from=build /app/dist ./dist
COPY public ./public
COPY content ./content
COPY data ./data
EXPOSE 3000
# In compose the Python ML service runs as its own container (SHAP_SERVICE_URL),
# so this image ships no Python — the supervisor adopts the remote service.
CMD ["node", "dist/server.js"]
