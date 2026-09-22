  1. Create a Jenkins secret-text credential named openai-api-key. I used the per-service env: pattern from qq-api and vector-db instead of your option (b). The reason for (b) was not overwriting the web app's .env, and a separate service
     doesn't have that problem. Tell me if you'd still rather handle the key yourself.
  2. Make sure the knowledge collection exists in Qdrant. setup_db.ts creates it.
  3. The VM's knowledge base will start empty. As the plan specified, the sample docs in the repo are only used for local runs and aren't deployed. Copy files to /opt/knowledge-ingest/knowledge-base/ on the VM, then test with:
  cd /opt/knowledge-ingest && sudo docker compose run --rm knowledge-ingest node dist/index.js