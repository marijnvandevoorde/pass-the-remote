FROM node:26-alpine

WORKDIR /app

# ffprobe (shipped with ffmpeg) reads ID3/Vorbis/MP4 tags + duration
# from every supported audio format. The scanner shells out to it; no
# npm dep needed. Falls back to filename heuristics when ffprobe is
# absent or a file has no readable tags.
RUN apk add --no-cache ffmpeg

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
