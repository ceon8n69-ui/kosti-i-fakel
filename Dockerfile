FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm deploy --filter @kf/api --prod --legacy /out \
 && cp -r apps/api/drizzle /out/drizzle \
 && cp -r apps/web/dist /out/web

FROM node:22-slim
ENV NODE_ENV=production WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /out ./
EXPOSE 3000
CMD ["node", "dist/main.js"]
