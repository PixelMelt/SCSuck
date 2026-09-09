FROM oven/bun:1-debian AS bun
FROM debian:bookworm-slim
ARG CHROME_VERSION=151.0.7922.173-1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl g++ ffmpeg tini && curl -fsSLo /tmp/chrome.deb "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" && apt-get install -y /tmp/chrome.deb && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY src/hlsPlaylist.ts src/types.ts ./src/
COPY services/decryption ./services/decryption
RUN g++ -std=c++17 -shared -fPIC services/decryption/cdm-vtable-capture.cc -ldl -lpthread -o /app/capture.so && useradd --create-home --uid 1000 worker
USER worker
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["bun", "services/decryption/server.ts"]
