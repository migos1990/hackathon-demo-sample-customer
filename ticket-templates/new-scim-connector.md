# [SCIM] <Customer App Name>

<!--
LINEAR TICKET TEMPLATE — "New SCIM Connector"

FOR THE CONSULTANT FILLING THIS OUT:
- This template is the agent's ONLY structured input. Ambiguity here = ambiguity
  in what the agent produces. Fill every section. Don't leave "TBD" in fields
  the agent needs to make decisions on.
- If a section doesn't apply, write "N/A" plus one line on why.
- If you genuinely don't know something, write "UNKNOWN — <what you'd need to
  find out>". The agent will block or ask for clarification rather than guess.

FOR THE ORCHESTRATOR PARSING THIS:
- The YAML front-matter is the machine-parseable contract. Schema at
  `ticket-templates/schema.json`.
- The body sections are rendered into the agent's prompt context verbatim.
- Required fields in YAML front-matter: customer_app_name, auth_method,
  base_url, user_model_source, required_ops, lifecycle_policy.
-->

---
customer_app_name: AcmeHR
customer_slug: acme-hr                 # lowercase, hyphenated; used in repo paths

# Auth
auth_method: bearer                    # bearer | basic | oauth_cc (OAuth client-credentials)
auth_credential_location: env          # env | secret_manager | vault
auth_credential_env_var: ACME_HR_API_TOKEN

# Endpoints
base_url: https://api.acme-hr.example.com
environments:
  dev: https://api.dev.acme-hr.example.com
  staging: https://api.staging.acme-hr.example.com
  prod: https://api.acme-hr.example.com

# Source user model
user_model_source: ldap                # ldap | workday | custom_db — matches patterns in docs/attribute-mapping-patterns.md
user_model_sample_url: https://docs.acme-hr.example.com/api/users  # link to source API docs OR attach a sample response below

# SCIM operations the server MUST implement
required_ops:
  users_create: true
  users_read: true
  users_update_patch: true
  users_delete: true
  users_list: true
  users_filter: true
  groups: true                         # enable group sync end-to-end
  group_push: true                     # Okta pushes groups to this server
  group_members_patch: true

# Lifecycle — what "deprovision" means for this customer
lifecycle_policy: soft_delete          # hard_delete | soft_delete | archive
deactivation_attribute_clearing: []    # list of SCIM attributes to clear on active=false; [] means retain all

# Compliance constraints
compliance:
  pii_retention_days: null             # null = retain indefinitely
  audit_retention_required: false      # if true, server keeps an immutable audit log separate from logs/
  region_restrictions: []              # e.g. ["us-east-1"] — empty means no restriction
  customer_data_residency: null        # optional note string

# Terraform
target_okta_tenant: demo-customer-a-staging.oktapreview.com   # for hackathon: one of the demo tenants
terraform_workspace: staging           # terraform workspaces enforce staging→prod promotion

# Promotion gate — pipeline-written only, never hand-edited (docs/promotion-flow.md)
promotion_gate:
  preprod_verified_at: null            # ISO-8601; set by pre-prod verify gate on pass
  preprod_manifest_sha: null           # SHA-256 of signed Promotion Manifest; set at approval
  approver_github_username: null       # GitHub username; required non-null before prod apply
  promoted_to_prod_at: null            # ISO-8601; set by prod apply on success
---

## Business purpose

<!-- 1-3 sentences. What does this customer use AcmeHR for? Why do they need Okta-driven provisioning? -->

Acme is migrating from manually provisioned HR access to Okta-driven lifecycle. AcmeHR is their core HRIS; onboarding a new hire should create an AcmeHR user within an hour of Okta assignment, deprovisioning should retain records but lock access for compliance audit.

## Source API summary

<!-- Link to official customer-provided API docs AND paste a sample response. The agent uses this to ground its attribute mapping. -->

**Official docs:** https://docs.acme-hr.example.com/api/users

**Sample `GET /users/{id}` response:**

```json
{
  "dn": "uid=jdoe,ou=people,dc=acme-hr,dc=example,dc=com",
  "uid": "jdoe",
  "cn": "Jane Doe",
  "sn": "Doe",
  "givenName": "Jane",
  "mail": "jdoe@acme-hr.example.com",
  "employeeNumber": "E-1234",
  "title": "Senior Engineer",
  "department": "R&D",
  "enabled": true,
  "memberOf": [
    "cn=engineers,ou=groups,dc=acme-hr,dc=example,dc=com",
    "cn=all-staff,ou=groups,dc=acme-hr,dc=example,dc=com"
  ],
  "lastModified": "2026-04-28T14:22:11Z"
}
```

## Attribute mapping requirements

<!-- Map source fields → SCIM fields. If you're using a pattern from docs/attribute-mapping-patterns.md, name it and list any deltas. Otherwise write the full mapping. -->

Pattern: **LDAP-shaped** (`docs/attribute-mapping-patterns.md#pattern-1`).

Deltas from the standard LDAP pattern:
- `userName` sourced from `uid` (not `mail`) — AcmeHR's internal logins use uid, not email
- `employeeNumber` → enterprise extension schema
- Standard LDAP pattern otherwise applies

## Lifecycle requirements

<!-- What should happen on unassignment from Okta? Be specific. -->

- **Unassignment / deprovision:** flip `active: false` in AcmeHR. Do NOT delete the user row (compliance requires 7-year retention).
- **Attribute retention on deactivation:** retain all profile fields. Retain `memberOf`. AcmeHR's audit log keys off historical attribute state.
- **Reactivation:** PATCH `active: true` restores the user as-is. No attribute reset needed.

## Compliance constraints

<!-- PII handling, audit, region. Blank = defaults. -->

- **PII in logs:** none. Server MUST redact userName / emails / names in info-level logs.
- **Audit log:** standard git + Okta system log; no additional audit retention required Pro Serve-side.
- **Region:** US only. Server runs in us-east-1.

## Known risks / open questions

<!-- What might bite the agent? Anything weird about this customer's environment the agent should pause and ask about? -->

- AcmeHR's OAuth implementation historically supported only `/token` with password grant (legacy). We're using bearer token on the assumption they've migrated — **CONFIRM before agent starts work**.
- AcmeHR stores `cn` as "Given Family" with space-separated join. Split-name transform must handle the "single-token" case (some users have one name only — e.g., "Madonna").

## Acceptance criteria for agent-generated PR

- Replay-test suite green against the generated server (all fixtures in `fixtures/okta-payloads/`)
- All three validators green (SCIM compliance, security, Terraform baseline)
- Runbook generated in `generated/<customer-slug>/RUNBOOK.md` with deploy steps
- Postman collection generated in `generated/<customer-slug>/postman.json`
- Terraform plan applies cleanly to `demo-customer-a-staging` tenant; `terraform plan` after apply is empty (idempotent)
- PR description cites `docs/okta-dialect.md` sections for every Okta-specific behavior the generated code relies on

## Human review checklist (filled out by reviewer before merge)

- [ ] Attribute mapping matches the customer's actual source-schema response shape
- [ ] Lifecycle policy is correctly encoded in both the server code AND the Terraform provisioning settings
- [ ] Compliance notes in the runbook match this ticket's compliance section
- [ ] Runbook has the right env vars + deploy steps for the customer's platform
- [ ] Generated tests actually exercise behavior (not just mock calls)
- [ ] No PII / real customer data in any generated file (agent MUST use placeholders like `example.com`)
