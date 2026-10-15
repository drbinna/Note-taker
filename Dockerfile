# Playwright image ships Chromium + Xvfb; tag must match the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

# ffmpeg converts each recording to mp3 before it's sent to Fireworks for transcription.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV PROFILE_DIR=/data/profile OUTPUT_DIR=/data/meetings HEADLESS=false
VOLUME /data
EXPOSE 8080

# Headful Chrome inside a virtual display — Meet is much more suspicious of true headless.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x720x24", "node", "dist/src/server.js"]
