---
name: deploy-notes
description: checklist before deploying the sidecar service to production
---

# Deploy checklist

1. `npm run typecheck` green.
2. `npm test` all suites green.
3. No secrets in trace: scan events for `token|key|password`.
4. Restart sidecar service, check `/health` responds.
