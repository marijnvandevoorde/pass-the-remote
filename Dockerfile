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

# Run as the image's unprivileged `node` user (uid/gid 1000), not root.
# /data must be writable by it: an empty named volume inherits this
# ownership; a bind-mounted host folder must be owned by uid 1000 (or run
# the container with `user:` set to the folder's owner, see
# docker-compose.yml). /music only needs to be readable.
RUN mkdir -p /music /data && chown node:node /data

USER node

VOLUME ["/music", "/data"]
EXPOSE 3000

CMD ["node", "src/server.ts"]
