# inlay-cam with its server: the built app, and inlay-server with the tool file in a
# volume at /data. See README "With a server".

# The core, twice: as WebAssembly for the page, and in the server.
FROM rust:1-slim-bookworm AS core
RUN rustup target add wasm32-unknown-unknown && cargo install wasm-pack --locked
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY crates crates
RUN wasm-pack build crates/inlay-wasm --target web --release --out-dir /src/wasm \
    && cargo build --release --locked -p inlay-server

FROM node:24-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
COPY --from=core /src/wasm ./src/wasm
RUN npm run build

FROM debian:bookworm-slim
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin inlay \
    && mkdir /data && chown 10001:10001 /data
COPY --from=core /src/target/release/inlay-server /usr/local/bin/inlay-server
COPY --from=web /src/web/dist /app/web

USER inlay
ENV INLAY_WEB=/app/web INLAY_DATA=/data INLAY_HOST=0.0.0.0 INLAY_PORT=8000
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["inlay-server", "--health"]

CMD ["inlay-server"]
