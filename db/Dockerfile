# Bilde for Cloud Run-jobben faktura-migrate: kjører db/migrations mot Cloud SQL.
FROM public.ecr.aws/docker/library/postgres:16-alpine
RUN apk add --no-cache bash
WORKDIR /app
COPY db/migrations db/migrations
COPY scripts/migrer.sh scripts/migrer.sh
ENV PGSSLMODE=require
ENTRYPOINT ["bash", "-c", "export DATABASE_URL=\"postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:5432/${DB_NAME}\" && exec scripts/migrer.sh"]
