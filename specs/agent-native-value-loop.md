# Marrow Agent-Native Value Loop

Date: 2026-05-06

This spec replaces the old dashboard-first idea with an agent-first operating model. Marrow should be a memory, safety, reporting, and coordination layer that agents can call directly, then explain to their owner in natural language or render in any interface the owner wants.

## 1. SDK/MCP Agent Safety Loop

Problem: Agents should not manually stitch together gate, retrieval, workflow-before, execution, workflow-after, and reporting calls.

Goal: provide one agent-native helper that wraps the full loop.

Target API/SDK shape:

```ts
await marrow.runGuarded({
  agent_id: "jarvis",
  session_id: "deploy-2026-05-06",
  action: "Deploy Cloudflare Worker to production",
  risk_tolerance: "medium",
  execute: async () => deploy(),
});
```

Expected behavior:

- Retrieve relevant prior memories/decisions.
- Call `/v1/workflow/gate`.
- If blocked/review-required, return structured reason before execution.
- Log `/v1/workflow/before`.
- Execute caller-provided function.
- Log `/v1/workflow/after`.
- Classify failures.
- Return a compact owner/agent summary.

Build phases:

- Phase 1: document contract and expose primitives.
- Phase 2: SDK helper for TypeScript and MCP tool helper.
- Phase 3: policy-aware enforcement modes.

Tests:

- Loop allows safe work.
- Loop stops review-required work before execution.
- Loop commits success/failure outcomes.
- Loop redacts raw action/context from owner report surfaces.

## 2. Agent-Native Value Reports

Problem: a human dashboard is not the core product if agents are the operational interface.

Goal: let agents pull a ready-to-say value report for an owner or for their own planning loop.

Endpoint:

- `GET /v1/analytics/value-report`

Query:

- `period`: days, clamped to 1-90, default 7.
- `agent_id`: optional, filters to `agent_id` or `session_id`.

Output:

- `summary`: owner-ready short text.
- `metrics`: machine-readable decisions, success rate, failures, saves.
- `fleet`: active agents and top agents by volume.
- `risks`: top failure categories without raw action text.
- `recommendations`: next policy/loop recommendations.
- `improvement`: baseline improvement block when available.

Security:

- No raw `action`, `context`, or `outcome` text.
- No secrets reflected.
- Authenticated and rate limited.
- Scope to caller account.

Build phases:

- Phase 1: API endpoint.
- Phase 2: MCP tool wrapper.
- Phase 3: email/nudge can reuse the same report body.

## 3. Agent Identity And Role Policy

Problem: fleets need to distinguish deploy, backend, opsec, reviewer, and owner agents.

Goal: managed agent identities with role-aware policy.

Entities:

- Agent ID.
- Display name.
- Role: `deploy`, `backend`, `opsec`, `reviewer`, `research`, `owner`, or custom.
- Allowed scopes.
- Optional approval authority.

Policy examples:

- Deploy agent may deploy only after opsec pass.
- Backend agent may patch but not deploy.
- Opsec agent may block production release.
- Reviewer agent can mark work ready for deploy.

Build phases:

- Phase 1: standardize `X-Marrow-Agent-Id` and managed API key binding.
- Phase 2: policy config API.
- Phase 3: gate endpoint evaluates role policy.

Tests:

- Agent-bound key cannot spoof another agent.
- Deploy action requires opsec approval.
- Review-required response is deterministic and auditable.

## 4. Failure Taxonomy

Problem: failures are often free text, which makes learning hard.

Goal: classify failures into durable, queryable buckets.

Initial taxonomy:

- `auth`
- `permission`
- `rate_limit`
- `timeout`
- `test_failure`
- `deploy_failure`
- `dependency`
- `migration`
- `tooling`
- `missing_context`
- `policy_block`
- `unknown`

Build phases:

- Phase 1: deterministic classifier for workflow-after and agent commit.
- Phase 2: optional `failure_type`, `severity`, `recovery_action` fields.
- Phase 3: value reports and gate recommendations use failure trends.

Tests:

- Common error strings classify correctly.
- Existing commit/workflow-after payloads remain backward compatible.
- Reports aggregate by failure type without leaking raw logs.

## 5. First-Class Integrations

Problem: users need Marrow in the systems where agents already operate.

Goal: provide integration contracts/templates for common agent workflows.

Priority integrations:

- GitHub PR and merge flow.
- Cloudflare dry-run/deploy/rollback flow.
- OpenClaw/TG handoffs.
- CI test runs.
- Security audit loops.

Build phases:

- Phase 1: documented integration event templates.
- Phase 2: SDK/MCP helpers.
- Phase 3: normalized source fields on workflow/reporting APIs.

Tests:

- GitHub PR handoff produces idempotent event IDs.
- Cloudflare deploy report includes dry-run, smoke tests, and rollback.
- Security audit loop enforces Barvis -> Darvis/Codex -> Barvis -> Jarvis sequence.

## First Build Slice

Ship `GET /v1/analytics/value-report`.

Why first:

- It validates the no-dashboard thesis.
- It gives agents immediate owner-ready reporting.
- It reuses existing Marrow metrics.
- It requires no migration.
- It becomes the reporting payload later SDK/MCP loop helpers can return.
