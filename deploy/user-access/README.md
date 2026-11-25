# User & Access

Automation Hub → **User & Access** shows who can log in to which cluster and
with what rights, across every cluster the hub manages, and changes it through
approved requests.

## How access is given

OpenShift has no "create a user with a password" API: people come from an
identity provider. So a grant is one of:

| Mode | What happens on each chosen cluster | Password |
|---|---|---|
| **Company login (AD / SSO)** — recommended | The person is added to a platform-managed group (`tcs-<role>-<namespace>`), which is bound to the role | None; they log in with their company account |
| **Local user (htpasswd)** — labs and emergency accounts | A bcrypt entry is added to the htpasswd Secret the OAuth config uses, then the same group and binding | Generated at approval, shown once to the approver, never stored |

Roles offered: `view`, `edit`, `admin` (per namespace), `cluster-reader`,
`cluster-admin` (cluster-wide). A grant can have an end date; access is taken
away automatically every 10 minutes after it passes (`USER_ACCESS_EXPIRY_TICK_MS`).

Groups synced from AD/LDAP are never edited here (the next sync would undo it):
the screen says to change them in the directory.

## Approval

Every change is a request. Operators and Admins can request; only an Admin can
approve, and not the person who requested it (unless sign-in is off). A request
can also be raised as a ServiceNow change request. Requests, approvals,
results per cluster and expiries are in the audit trail.

## Delivery

- **Directly** — the hub applies the change on each cluster (through the spoke
  agent's credentials or direct access; a cluster reached only through the
  read-only bridge reports that it cannot be changed).
- **ACM policy** — nothing is applied; you get a `Policy` that enforces the
  group and binding, to apply on the ACM hub with a Placement.
- **GitOps** — nothing is applied; you get the Group and RoleBinding YAML for
  your repository. Local (htpasswd) users can only be applied directly, so a
  password hash never goes into Git or a policy.

## Remove everywhere, and kubeadmin

"Remove everywhere" takes a person out of every non-synced group, removes
bindings that name them directly, removes their htpasswd entry, and deletes
their User and Identity objects, on each chosen cluster. It refuses to remove
the only cluster-admin who can log in.

"Request removal" on kubeadmin deletes `kube-system/kubeadmin` only where an
identity provider exists and someone else holds cluster-admin.

## Permissions

Apply `rbac.yaml` on each cluster to be managed. It includes `bind` on the five
offered roles, which Kubernetes requires before an account can grant them.

## Not covered

Adding or changing identity providers (OAuth config) and LDAP group sync jobs
are not changed from this screen; it shows which clusters lack company login.
Last-login dates come from OAuth access tokens and are shown only where the
platform may list them.
