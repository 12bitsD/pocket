FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app/cloud

COPY cloud/pyproject.toml cloud/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY cloud/src ./src
COPY cloud/migrations ./migrations
RUN uv sync --frozen --no-dev

EXPOSE 8787
CMD ["uv", "run", "--no-sync", "pocket-cloud", "serve"]
