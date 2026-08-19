# Requirement Document — Hello Web

A minimal, known-good requirement. One stateless web tier, exposed with TLS.
Use this first: it proves the whole pipeline — extract → generate → dry-run →
deploy → verification pyramid → a URL that answers — in about a minute.

## Application Overview

| Field | Value |
|---|---|
| Application Name | hello-web |
| Description | Single-tier static web server used to smoke-test the Automation Hub pipeline end to end |
| Environment | demo |

## Target Platform

| Field | Value |
|---|---|
| Platform Type | openshift |
| Namespace | demo-hello-web |

## Tier 1 — Frontend Web Server (nginx)

The image is nginx-unprivileged: it listens on 8080 and runs as whatever UID
OpenShift assigns, so it works under the restricted SCC without any grants.
Stock nginx binds port 80 as root and crash-loops on OpenShift — do not swap it in.

| Field | Value |
|---|---|
| Component Name | web |
| Role | frontend |
| Container Image | docker.io/nginxinc/nginx-unprivileged:1.27 |
| Port | 8080 |
| Replicas | 2 |
| CPU Request | 50m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Expose Externally | yes |
| TLS | edge |
| Run As Non-Root | yes |
| Drop Capabilities | yes |

### Health Probes

| Probe | Type | Path | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | http | / | 8080 | 5 | 10 |
| readiness | http | / | 8080 | 3 | 5 |

## Post-Deploy Validation

| Test | Command | Expected |
|---|---|---|
| Both replicas serving | oc -n demo-hello-web get deploy web | READY 2/2 |
| Route answers | curl -k https://<route-host>/ | HTTP 200, nginx welcome page |

## Rollback Criteria

- Rollout does not complete within 3 minutes
- The route probe does not return HTTP 200

## Expected Result

Every verification level green. The access panel shows the route URL with a
green dot and an HTTP 200 in a few hundred milliseconds; "Open application"
shows the nginx welcome page.
