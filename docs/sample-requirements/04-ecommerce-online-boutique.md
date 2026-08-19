# Requirement Document — Online Boutique (E-Commerce Demo)

Google's **Online Boutique** (microservices-demo): a real, browsable web shop —
product catalog, cart, currency conversion, recommendations, ads, checkout,
payment, shipping, order-confirmation email — implemented as 11 microservices
in 5 languages talking gRPC, plus a Redis cart store and a load generator that
keeps synthetic shoppers clicking through the store from the moment it comes up.

Why this exact app: its images are built to run as **non-root under an
arbitrary UID**, so it deploys on OpenShift's restricted SCC with no security
grants — most demo shops (Sock Shop, robot-shop) do not. The images live in
Google's public registry (`us-central1-docker.pkg.dev/google-samples/…`); if
your cluster cannot reach it, mirror the 12 images to your internal registry
and edit only the image rows.

The functional proof is the shop itself: browse products, add to cart, place
an order, get a confirmation — every step crosses 4–8 services and the Redis
store, under a zero-trust network matrix.

## Application Overview

| Field | Value |
|---|---|
| Application Name | online-boutique |
| Description | 11-service e-commerce demo (gRPC microservices, Redis cart) with synthetic load |
| Environment | demo |

## Target Platform

| Field | Value |
|---|---|
| Platform Type | openshift |
| Namespace | demo-boutique |
| Deployment Order | redis-cart, productcatalogservice, currencyservice, paymentservice, shippingservice, emailservice, adservice, cartservice, recommendationservice, checkoutservice, frontend, loadgenerator |

## Tier 1 — Cart Store (Redis)

| Field | Value |
|---|---|
| Component Name | redis-cart |
| Role | database |
| Container Image | docker.io/redis:7-alpine |
| Port | 6379 |
| Replicas | 1 |
| CPU Request | 70m |
| CPU Limit | 125m |
| Memory Request | 200Mi |
| Memory Limit | 256Mi |
| Storage Size | 1Gi |
| Storage Mount Path | /data |
| Expose Externally | no |

### Health Probes

| Probe | Type | Port | Initial Delay | Period |
|---|---|---|---|---|
| liveness | tcp | 6379 | 10 | 10 |
| readiness | tcp | 6379 | 5 | 5 |

## Tier 2 — Product Catalog Service

| Field | Value |
|---|---|
| Component Name | productcatalogservice |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/productcatalogservice:v0.10.2 |
| Port | 3550 |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Run As Non-Root | yes |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| PORT | 3550 |   |   |
| DISABLE_PROFILER | 1 |   |   |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | /bin/grpc_health_probe -addr=:3550 | 3550 | 10 | 10 |
| readiness | exec | /bin/grpc_health_probe -addr=:3550 | 3550 | 5 | 5 |

## Tier 3 — Currency Service

| Field | Value |
|---|---|
| Component Name | currencyservice |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/currencyservice:v0.10.2 |
| Port | 7000 |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Run As Non-Root | yes |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| PORT | 7000 |   |   |
| DISABLE_PROFILER | 1 |   |   |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | /bin/grpc_health_probe -addr=:7000 | 7000 | 10 | 10 |
| readiness | exec | /bin/grpc_health_probe -addr=:7000 | 7000 | 5 | 5 |

## Tier 4 — Payment Service

| Field | Value |
|---|---|
| Component Name | paymentservice |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/paymentservice:v0.10.2 |
| Port | 50051 |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Run As Non-Root | yes |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| PORT | 50051 |   |   |
| DISABLE_PROFILER | 1 |   |   |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | /bin/grpc_health_probe -addr=:50051 | 50051 | 10 | 10 |
| readiness | exec | /bin/grpc_health_probe -addr=:50051 | 50051 | 5 | 5 |

## Tier 5 — Shipping Service

| Field | Value |
|---|---|
| Component Name | shippingservice |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/shippingservice:v0.10.2 |
| Port | 50051 |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Run As Non-Root | yes |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| PORT | 50051 |   |   |
| DISABLE_PROFILER | 1 |   |   |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | /bin/grpc_health_probe -addr=:50051 | 50051 | 10 | 10 |
| readiness | exec | /bin/grpc_health_probe -addr=:50051 | 50051 | 5 | 5 |

## Tier 6 — Email Service

| Field | Value |
|---|---|
| Component Name | emailservice |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/emailservice:v0.10.2 |
| Port | 8080 |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Run As Non-Root | yes |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| PORT | 8080 |   |   |
| DISABLE_PROFILER | 1 |   |   |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | /bin/grpc_health_probe -addr=:8080 | 8080 | 10 | 10 |
| readiness | exec | /bin/grpc_health_probe -addr=:8080 | 8080 | 5 | 5 |

## Tier 7 — Ad Service

| Field | Value |
|---|---|
| Component Name | adservice |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/adservice:v0.10.2 |
| Port | 9555 |
| Replicas | 1 |
| CPU Request | 200m |
| CPU Limit | 300m |
| Memory Request | 200Mi |
| Memory Limit | 400Mi |
| Run As Non-Root | yes |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| PORT | 9555 |   |   |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | /bin/grpc_health_probe -addr=:9555 | 9555 | 20 | 15 |
| readiness | exec | /bin/grpc_health_probe -addr=:9555 | 9555 | 20 | 15 |

## Tier 8 — Cart Service

| Field | Value |
|---|---|
| Component Name | cartservice |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/cartservice:v0.10.2 |
| Port | 7070 |
| Replicas | 1 |
| CPU Request | 200m |
| CPU Limit | 300m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Run As Non-Root | yes |
| Depends On | redis-cart |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| REDIS_ADDR | redis-cart:6379 |   |   |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | /bin/grpc_health_probe -addr=:7070 -rpc-timeout=5s | 7070 | 15 | 10 |
| readiness | exec | /bin/grpc_health_probe -addr=:7070 -rpc-timeout=5s | 7070 | 15 | 10 |

## Tier 9 — Recommendation Service

| Field | Value |
|---|---|
| Component Name | recommendationservice |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/recommendationservice:v0.10.2 |
| Port | 8080 |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 200m |
| Memory Request | 220Mi |
| Memory Limit | 450Mi |
| Run As Non-Root | yes |
| Depends On | productcatalogservice |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| PORT | 8080 |   |   |
| PRODUCT_CATALOG_SERVICE_ADDR | productcatalogservice:3550 |   |   |
| DISABLE_PROFILER | 1 |   |   |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | /bin/grpc_health_probe -addr=:8080 | 8080 | 10 | 10 |
| readiness | exec | /bin/grpc_health_probe -addr=:8080 | 8080 | 5 | 5 |

## Tier 10 — Checkout Service

| Field | Value |
|---|---|
| Component Name | checkoutservice |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/checkoutservice:v0.10.2 |
| Port | 5050 |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Run As Non-Root | yes |
| Depends On | productcatalogservice, shippingservice, paymentservice, emailservice, currencyservice, cartservice |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| PORT | 5050 |   |   |
| PRODUCT_CATALOG_SERVICE_ADDR | productcatalogservice:3550 |   |   |
| SHIPPING_SERVICE_ADDR | shippingservice:50051 |   |   |
| PAYMENT_SERVICE_ADDR | paymentservice:50051 |   |   |
| EMAIL_SERVICE_ADDR | emailservice:8080 |   |   |
| CURRENCY_SERVICE_ADDR | currencyservice:7000 |   |   |
| CART_SERVICE_ADDR | cartservice:7070 |   |   |

### Health Probes

| Probe | Type | Command | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | exec | /bin/grpc_health_probe -addr=:5050 | 5050 | 10 | 10 |
| readiness | exec | /bin/grpc_health_probe -addr=:5050 | 5050 | 5 | 5 |

## Tier 11 — Frontend Web

The storefront people browse. This is the only tier exposed by a Route.

| Field | Value |
|---|---|
| Component Name | frontend |
| Role | frontend |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/frontend:v0.10.2 |
| Port | 8080 |
| Replicas Min | 2 |
| Replicas Max | 5 |
| CPU Request | 100m |
| CPU Limit | 200m |
| Memory Request | 64Mi |
| Memory Limit | 128Mi |
| Expose Externally | yes |
| TLS | edge |
| Run As Non-Root | yes |
| Depends On | productcatalogservice, currencyservice, cartservice, recommendationservice, shippingservice, checkoutservice, adservice |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| PORT | 8080 |   |   |
| PRODUCT_CATALOG_SERVICE_ADDR | productcatalogservice:3550 |   |   |
| CURRENCY_SERVICE_ADDR | currencyservice:7000 |   |   |
| CART_SERVICE_ADDR | cartservice:7070 |   |   |
| RECOMMENDATION_SERVICE_ADDR | recommendationservice:8080 |   |   |
| SHIPPING_SERVICE_ADDR | shippingservice:50051 |   |   |
| CHECKOUT_SERVICE_ADDR | checkoutservice:5050 |   |   |
| AD_SERVICE_ADDR | adservice:9555 |   |   |

### Health Probes

| Probe | Type | Path | Port | Initial Delay | Period |
|---|---|---|---|---|---|
| liveness | http | /_healthz | 8080 | 10 | 10 |
| readiness | http | /_healthz | 8080 | 5 | 5 |

## Tier 12 — Load Generator

Synthetic shoppers (Locust) browsing, carting and checking out continuously —
the store carries live traffic from the moment it is up. The port is
informational; the tier accepts no inbound traffic.

| Field | Value |
|---|---|
| Component Name | loadgenerator |
| Role | app |
| Container Image | us-central1-docker.pkg.dev/google-samples/microservices-demo/loadgenerator:v0.10.2 |
| Port | 8089 |
| Replicas | 1 |
| CPU Request | 100m |
| CPU Limit | 300m |
| Memory Request | 256Mi |
| Memory Limit | 512Mi |
| Run As Non-Root | yes |
| Depends On | frontend |

### Environment Variables

| Name | Value | From Secret | Secret Key |
|---|---|---|---|
| FRONTEND_ADDR | frontend:8080 |   |   |
| USERS | 5 |   |   |

## Network Connectivity Matrix

Zero-trust: each allowed row becomes an ingress rule on the target AND an
egress rule on the caller; DNS egress is a granted precondition; everything
else is denied both directions. This matrix is the application's architecture
diagram, enforced.

| From | To | Port | Protocol | Allowed |
|---|---|---|---|---|
| internet | frontend | 8080 | TCP | yes |
| loadgenerator | frontend | 8080 | TCP | yes |
| frontend | productcatalogservice | 3550 | TCP | yes |
| frontend | currencyservice | 7000 | TCP | yes |
| frontend | cartservice | 7070 | TCP | yes |
| frontend | recommendationservice | 8080 | TCP | yes |
| frontend | shippingservice | 50051 | TCP | yes |
| frontend | checkoutservice | 5050 | TCP | yes |
| frontend | adservice | 9555 | TCP | yes |
| checkoutservice | productcatalogservice | 3550 | TCP | yes |
| checkoutservice | shippingservice | 50051 | TCP | yes |
| checkoutservice | paymentservice | 50051 | TCP | yes |
| checkoutservice | emailservice | 8080 | TCP | yes |
| checkoutservice | currencyservice | 7000 | TCP | yes |
| checkoutservice | cartservice | 7070 | TCP | yes |
| recommendationservice | productcatalogservice | 3550 | TCP | yes |
| cartservice | redis-cart | 6379 | TCP | yes |
| internet | redis-cart | 6379 | TCP | no |
| internet | paymentservice | 50051 | TCP | no |

## Post-Deploy Validation

| Test | Command | Expected |
|---|---|---|
| Storefront serves | curl -k https://<route-host>/ | HTTP 200, product grid |
| A purchase completes | Browse → add to cart → Place Order in the browser | Order confirmation page with tracking ID |
| Live traffic flowing | oc -n demo-boutique logs deploy/loadgenerator --tail=20 | Locust request stats, 0 failed |
| Cart survives the round trip | Add an item, open /cart | Item present (served from redis-cart via cartservice) |
| Denied path is denied | oc -n demo-boutique exec deploy/frontend -- timeout 3 sh -c "nc -z redis-cart 6379" | timeout — the frontend must not reach Redis directly |

## Rollback Criteria

- Any rollout incomplete after 8 minutes (first pull of 12 images can be slow)
- The storefront route does not return HTTP 200
- Load generator reports a sustained failure rate above 5 percent

## Expected Result

First deploy pulls ~12 images — allow 3–6 minutes. The pyramid goes green:
12 rollouts complete, services wired, the storefront answering HTTP 200 —
and "Open application" lands on a working shop already carrying synthetic
traffic. Place an order yourself: that one click traverses frontend →
checkout → catalog, shipping, payment, email, currency, cart → Redis, every
hop crossing a network policy this document declared.
