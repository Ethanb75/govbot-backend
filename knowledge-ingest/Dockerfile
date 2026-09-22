FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:24-alpine

# supercronic runs the schedule as PID 1 and sends job output to the container logs;
# tzdata lets TZ pick the timezone the crontab is evaluated in
RUN apk add --no-cache supercronic tzdata

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY crontab ./crontab

USER node

CMD ["supercronic", "/app/crontab"]
