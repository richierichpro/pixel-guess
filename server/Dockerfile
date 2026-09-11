FROM denoland/deno:2.1.4

WORKDIR /app
COPY main.ts .

# KV persists to a file on the mounted volume (/data).
ENV KV_PATH=/data/kv.sqlite
RUN mkdir -p /data

# Cache deps at build time.
RUN deno cache main.ts

CMD ["run", "--unstable-kv", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "main.ts"]
