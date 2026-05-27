FROM node:24-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV MUSIC_DIR=/music
ENV DB_PATH=/data/library.db

VOLUME ["/music", "/data"]
EXPOSE 3000

CMD ["node", "src/server.ts"]
