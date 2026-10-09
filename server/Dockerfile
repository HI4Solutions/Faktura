# Ett bilde for både API og worker; ROLLE (api|worker) settes av Cloud Run.
FROM public.ecr.aws/docker/library/node:22-slim AS bygg
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src src
RUN npm run build && npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=bygg /app/node_modules node_modules
COPY --from=bygg /app/dist dist
COPY server/package.json ./
USER node
CMD ["node", "dist/main.js"]
