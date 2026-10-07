# rag-api

Answers questions from the `knowledge` Qdrant collection that `knowledge-ingest` keeps up to date. It runs on `192.168.1.133:8090` and is reached publicly only through the `personal-web-app` nginx `/api/` proxy.

## Deployment

Jenkins deploys it with `ansible/playbooks/deploy-rag-api.yml`. The playbook copies `compose.yml`, `.env` and the source into `/opt/rag-api` on the host, then rebuilds and starts the container with Docker Compose.

## Viewing logs

The app logs to stdout (for example the `clef intent:` and `sources:` lines in `src/routes/rag-chat.ts`), so the logs are the container logs.

```bash
# ssh in, then follow the logs
ssh deployer@192.168.1.133
cd /opt/rag-api
sudo docker compose logs -f rag-api

# or in one command from your machine
ssh -t deployer@192.168.1.133 'cd /opt/rag-api && sudo docker compose logs -f --tail=100 rag-api'

# only the intent output
sudo docker compose logs -f rag-api | grep -A20 "clef intent"
```

If `docker compose` isn't found, use `docker-compose`, since the playbook installs the apt `docker-compose` package. You can also skip Compose:

```bash
sudo docker logs -f $(sudo docker ps -qf name=rag-api)
```

The `clef intent:` line only prints when `CLOUDFLARE_WORKER_API_KEY` and `CLOUDFLARE_WORKER_ACCOUNT_ID` both reach the container. For that, they must be listed under `environment:` in `compose.yml` and written into the deployed `.env` by the `Jenkinsfile`.
