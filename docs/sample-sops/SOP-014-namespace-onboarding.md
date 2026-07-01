# SOP-014: Onboard a New Application Namespace

**Purpose:** Provision a standardized, secure namespace for a new team application.
**Scope:** Non-production OpenShift clusters.
**Owner:** Platform Engineering
**Risk:** Low

## Steps

1. Create a namespace named `team-<appname>` with labels `team=<team>` and `env=nonprod`.
2. Apply a ResourceQuota to the namespace: 4 CPU, 8Gi memory, 10 pods maximum.
3. Apply a LimitRange setting a default container limit of 500m CPU and 512Mi memory.
4. Apply a default-deny NetworkPolicy, then allow ingress traffic only from the `ingress` namespace.
5. Create a RoleBinding granting the `<team>-developers` group the `edit` role in the namespace.
6. Verify the namespace is Active and all objects (quota, limitrange, networkpolicy, rolebinding) were created successfully.
7. Raise a ServiceNow Change Request documenting the onboarding, including the team name and application.
