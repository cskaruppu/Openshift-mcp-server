# Requirement Document — Negative Test (Broken Image)

This document is SUPPOSED to fail. The image tag does not exist, so the
rollout can never complete. Use it to demonstrate that the verification
pyramid tells the truth: a green result means something because this red
result is possible.

Deploy it exactly like the others. Expected outcome: the pod watch shows
ImagePullBackOff, verification level 1 (rollout) stays red with "0/1 new
replicas rolled out", and no URL is ever offered. Then use the rollback on
the deployment record to clean up — it removes only what this deploy created.

## Application Overview

| Field | Value |
|---|---|
| Application Name | negative-test |
| Description | Deliberately broken deployment proving the verification pyramid fails honestly |
| Environment | demo |

## Target Platform

| Field | Value |
|---|---|
| Platform Type | openshift |
| Namespace | demo-negative |

## Tier 1 — Web Frontend

The tag 1.99-does-not-exist is intentionally invalid.

| Field | Value |
|---|---|
| Component Name | web |
| Role | frontend |
| Container Image | docker.io/nginxinc/nginx-unprivileged:1.99-does-not-exist |
| Port | 8080 |
| Replicas | 1 |
| CPU Request | 50m |
| CPU Limit | 100m |
| Memory Request | 32Mi |
| Memory Limit | 64Mi |
| Expose Externally | yes |
| TLS | edge |

### Health Probes

| Probe | Type | Path | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| readiness | http | / | 8080 | 3 | 5 |

## Post-Deploy Validation

| Test | Command | Expected |
|---|---|---|
| Rollout fails honestly | oc -n demo-negative get pods | ImagePullBackOff / ErrImagePull |
| Pyramid reports it | POST /api/automation/verify {"namespace":"demo-negative"} | passed: false, rollout level red |

## Rollback Criteria

- This deployment always meets its rollback criteria. Roll it back after the demonstration.
