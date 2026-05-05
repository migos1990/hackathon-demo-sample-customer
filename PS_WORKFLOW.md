---
# PS SCIM Pipeline Workflow Contract — Symphony pattern
# See spec §"Architecture" for the full design
tracker:
  kind: linear
  # Jira-swappable: set kind to "jira" + supply endpoint + project_slug
  endpoint: https://api.linear.app/graphql
  team_key: PS-SCIM          # placeholder — update after Day 1 Linear setup
  active_states: [Backlog, "In Progress", "In Review"]
  terminal_states: [Done, Cancelled, Duplicate]
  draft_states: [Triage]
polling:
  interval_ms: 30000         # supervisor reconciles board every 30s; webhook is latency optimizer
workspace:
  root: ./workspaces         # per-ticket durable workspaces
hooks:
  after_create: ""
  before_run: ""
  after_run: ""
  before_remove: ""
  timeout_ms: 60000
agent:
  max_concurrent_agents: 3   # modest; demo is serial
  max_retry_backoff_ms: 300000
model:
  provider: anthropic
  endpoint: https://llm.atko.ai
  model: claude-sonnet-4-6
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
github:
  owner: louismigault        # placeholder — update when GitHub repo exists
  generated_repo: scim-connectors-generated
  base_branch: main
---

# SCIM Pipeline Workflow Prompt (per-ticket)

This prompt is rendered per ticket by the orchestrator (to be built at hackathon weekend). Template variables:
- `{{ ticket.identifier }}` — Linear ticket key (e.g. PS-SCIM-1234)
- `{{ ticket.title }}`
- `{{ ticket.template_fields }}` — parsed YAML from the Linear ticket template
- `{{ ticket.customer_app_name }}`, `{{ ticket.auth_method }}`, `{{ ticket.base_url }}`, `{{ ticket.user_model }}`, `{{ ticket.required_ops }}`, `{{ ticket.attribute_mapping }}`, `{{ ticket.lifecycle_requirements }}`, `{{ ticket.compliance_constraints }}`
- `{{ harness.skeleton_path }}` — local path to `skeleton/`
- `{{ harness.dialect_doc }}` — rendered content of `docs/okta-dialect.md`
- `{{ harness.attr_patterns }}` — rendered content of `docs/attribute-mapping-patterns.md`

## Your job

Generate a per-customer SCIM connector PR for ticket `{{ ticket.identifier }}` targeting the customer app `{{ ticket.customer_app_name }}`.

Produce, in a new git branch named `scim/{{ ticket.identifier | slug }}`:

1. **SCIM 2.0 server** — TypeScript. Start from `{{ harness.skeleton_path }}`. Fill in `{{ ticket.customer_app_name }}`-specific logic (source-schema read + SCIM-shape transform). DO NOT rewrite PATCH / pagination / filter parsing — those are already correct in the skeleton. If you find yourself tempted to modify skeleton internals, STOP and leave a comment explaining why; route the concern to the reviewer.
2. **Attribute mapping** — consume one of the patterns from `{{ harness.attr_patterns }}` that most closely matches `{{ ticket.user_model }}`. Emit a mapping config file (YAML) the server reads at boot.
3. **Okta-side Terraform** — consume `terraform/okta-scim-module/` via a `terraform.tfvars` file matching this customer. Use demo tenant URLs from the environment.
4. **Test harness customization** — add a `fixtures/customer-specific/` directory with 2-3 fixtures representative of the customer's actual source-schema responses. Replay-test must remain green.
5. **Runbook** — customer-facing markdown: how the app team deploys the generated SCIM server, what env vars to set, how to trigger first sync.
6. **Postman collection** — one request per SCIM operation the customer app implements, pre-filled with dev-environment values.

## Guardrails (must be true at PR time)

- Every product-capability claim about Okta in your generated output is cited from `{{ harness.dialect_doc }}` or official Okta docs (SILVER LAW).
- No PII / real customer data in any generated file. Use `acme-hr` / `user-001@example.com` / `https://demo-customer-a.oktapreview.com` placeholders.
- Every generated test asserts on behavior (not just mock calls).
- Every comment that claims "idempotent" / "thread-safe" / "retries-are-safe" has a matching test or `// UNVERIFIED:` annotation.
- The replay-test suite passes against the generated server before you open the PR.
- All three validators pass (SCIM compliance, security, Terraform baseline).
- You did NOT write directly to Okta, the customer tenant, or production. Only to files on your branch.

## When to stop and ask

- The ticket's `{{ ticket.user_model }}` doesn't match any pattern in `{{ harness.attr_patterns }}`. Drop a comment on the Linear ticket requesting clarification.
- The customer's auth method isn't covered by the skeleton's pluggable auth middleware. Ask before inventing one.
- A fixture in `fixtures/okta-payloads/` conflicts with what the generated server produces. Flag the conflict — don't silently resolve it.
