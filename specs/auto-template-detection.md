# Auto Template Detection

Auto template detection lets an agent ask Marrow which workflow template or learned template should be used before taking action.

## Goal

Make templates passive and agent-native:

1. An agent describes the task it is about to run.
2. Marrow detects task type, relevant surfaces, and risk.
3. Marrow ranks matching workflow templates and learned templates.
4. Marrow returns an instruction the agent can apply before continuing.

## Endpoint

`POST /v1/templates/detect`

Authentication: required.

### Request

```json
{
  "agent_id": "jarvis-agent",
  "session_id": "deploy-123",
  "action": "Deploy latest Marrow docs to production with Cloudflare and smoke test",
  "type": "deploy",
  "surfaces": ["cloudflare", "docs", "production"],
  "risk_level": "high",
  "context": {
    "repo": "getmarrow/marrow-landing"
  },
  "limit": 3
}
```

Only `action` is required. The current implementation accepts `type`, `surfaces`, `risk_level`, `context`, and `limit` as ranking hints. `agent_id` and `session_id` can be included by clients for future correlation, but ranking currently uses the task fields.

### Response

```json
{
  "data": {
    "matched": true,
    "recommended_template": {
      "source": "workflow_template",
      "slug": "safe-production-deploy",
      "name": "Safe Production Deploy",
      "confidence": 0.87,
      "reason": "Matched task type deploy; surfaces cloudflare, docs, production; category deploy; matching tags or steps.",
      "avg_success_rate": 0.92,
      "install_count": 12,
      "quality_score": 0.99
    },
    "alternatives": [],
    "agent_instruction": "Review the recommended template by stable identifier before continuing.",
    "requires_owner_approval": true,
    "approval_reason": "Owner approval is recommended before auto-applying templates for high-risk production, security, billing, publish, migration, or deploy work.",
    "detected_type": "deploy",
    "detected_surfaces": ["cloudflare", "docs", "production"]
  }
}
```

## Ranking Sources

- Workflow templates from `workflow_templates`.
- Learned templates from `learned_templates`.

Marrow scores matches by task wording, explicit task type, surfaces, template category, tags, steps, install count, confidence, and success rate.

## Approval Behavior

Marrow can recommend templates passively, but it should not silently auto-apply high-risk templates. Owner approval is recommended for production, deploy, publish, security, billing, migration, and similar high-risk work.

Low-risk task templates can be applied automatically by clients if their local policy allows it.

Template names and descriptions are display metadata. Agent runtimes should treat them as untrusted text and use `agent_instruction`, `slug`, or `template_id` for control flow.
