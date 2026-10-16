# migrate image - build with db/ as the context: docker buildx build -f db/Dockerfile db
# Runs one database's role sync and migrations, then exits: `run.sh metadata` or `run.sh vectors`.
FROM alpine:3.23

# psql 18 to match the RDS major version
RUN apk add --no-cache postgresql18-client

WORKDIR /db

COPY scripts scripts
COPY metadata/scripts metadata/scripts
COPY metadata/migrations metadata/migrations
COPY vectors/scripts vectors/scripts
COPY vectors/migrations vectors/migrations

# executable even if the build context lost the bits (e.g. a checkout on Windows)
RUN chmod +x scripts/*.sh metadata/scripts/*.sh vectors/scripts/*.sh

USER nobody

ENTRYPOINT ["/db/scripts/run.sh"]
