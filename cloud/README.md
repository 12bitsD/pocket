# Pocket Cloud

Self-hosted backend shared by **Pocket Calendar** and **Pocket Notes**.

- **Stack**: Python 3.12 · FastAPI · PostgreSQL (`psycopg` v3 + SQL migrations) · lightweight `asyncio` scheduler
- **Responsibilities**: 6-digit device pairing, multi-device sync (`Link`), scheduled Prompt delivery to bound Agents (`202 Accepted` + one-time callback token), and scoped Agent read grants.

## Configuration

Copy `.env.example` to `.env` and fill in your secrets before starting:

```sh
cp cloud/.env.example cloud/.env
docker compose -f cloud/docker-compose.yml up -d
```

Detailed protocol and schema rules live in [`../docs/cloud/architecture.md`](../docs/cloud/architecture.md).
