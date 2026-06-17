---
name: triage-field-notes
description: Classify Field Note Items as "grill" (escalate to a Grilling Session) or "issue" (cut directly into a ready-for-agent issue) and return one strict JSON object keyed by Item id. Report-only — files nothing, opens nothing, writes nothing beyond the JSON result. Defaults to "grill" when uncertain.
---

# Triage Field Notes

You are reviewing a list of **Field Note Items** captured against an open Sofa Project. Each Item is a short, unacted note from the user — a bug, a fix idea, a friction point. Your job is to decide, for each one, whether it is **self-contained enough to file as a `ready-for-agent` issue right now** or whether it **hides unresolved design and needs a Grilling Session first**.

You do **not** file issues, open PRs, or write anything to disk or to GitHub. The only result that matters is the JSON object described in the **Output contract** below.

## Input

Field Note Items are supplied as a JSON array:

```json
[
  { "id": "<opaque id>", "text": "<the note, verbatim>" },
  ...
]
```

Treat `id` as opaque — pass it through unchanged in the result. Do not invent ids, drop ids, or add ids that were not in the input.

## How to decide

For each Item, ask one question: **can this become a single, AFK-ready issue right now — clear behaviour, clear acceptance criteria, using existing vocabulary, without anyone having to make a hard-to-reverse decision first?**

Use the same ready-vs-refinement test the `notes-to-issues` skill uses, with the same domain-aware grounding:

- Consult `CONTEXT.md` (or `CONTEXT-MAP.md` → per-context `CONTEXT.md`) for the project's glossary.
- Scan `docs/adr/` for decisions already made in the area the Item touches.
- Look at the code the Item lands in, enough to know whether the fix is mechanical or whether it bumps into a decision.

Recommend **`issue`** when the Item is essentially a complete vertical slice already:

- The desired behaviour is unambiguous and you could write acceptance criteria for it without inventing anything.
- It uses terms that already exist in `CONTEXT.md` (or introduces none that need defining).
- It doesn't force a choice that an ADR would record — no new architectural shape, integration pattern, technology lock-in, or boundary decision.
- An agent could implement and merge it without stopping to ask a human.

Recommend **`grill`** when the Item hides unresolved design:

- It uses a fuzzy or overloaded term, or one that conflicts with the glossary.
- Pinning down the behaviour requires a real trade-off with genuine alternatives (i.e. it's ADR-worthy).
- Its scope is unclear or it would obviously need to be sliced into several issues.
- It contradicts how the code currently works, so "the fix" is really a decision in disguise.

**The fence rule: when in doubt, recommend `grill`.** Over-grilling costs a conversation; a half-baked issue costs an agent a wasted run and the user a cleanup. The asymmetry favours caution. Default to `grill` whenever the call is genuinely uncertain.

## Output contract

End your run by emitting **exactly one** JSON object, and nothing else that competes to be the result. The object is keyed by the input Item ids; each value is `{ "recommendation": "grill" | "issue", "rationale": string }` plus an **optional** `suggestedTitle` and `suggestedBody`.

```json
{
  "<id-1>": {
    "recommendation": "issue",
    "rationale": "Behaviour is unambiguous and uses only existing glossary terms; no ADR-worthy choice involved.",
    "suggestedTitle": "Add dark mode toggle to settings header",
    "suggestedBody": "The settings header currently has no theme control. Add a toggle that switches between light and dark mode and persists the preference across sessions."
  },
  "<id-2>": {
    "recommendation": "grill",
    "rationale": "Pinning down 'session ownership' here requires a real trade-off between two patterns; ADR-worthy.",
    "suggestedTitle": "Clarify session ownership model",
    "suggestedBody": "The note raises session ownership without specifying whether ownership is per-Project or per-user. Grill to resolve the trade-off before filing."
  }
}
```

Rules:

- Include every input id, exactly once. No extras, no omissions.
- `recommendation` is exactly one of the two literal strings `"grill"` or `"issue"`.
- `rationale` is one short sentence (≤ ~30 words) naming **the specific reason** — the unresolved decision, the missing glossary term, the unambiguous slice. Generic restatements of the Item are not rationales.
- `suggestedTitle` (optional): a concise Issue title (≤ ~10 words). Produce this for **all** Items, regardless of `recommendation`. Omit only if the note is so ambiguous that no reasonable title is possible.
- `suggestedBody` (optional): 1–3 sentences of concise prose that cleans up the terse note, using the project glossary. **Not** a rigid template — write a natural paragraph. Produce this for all Items alongside `suggestedTitle`. Omit only if you cannot produce a meaningful body.
- Do not file issues, post comments, open PRs, or write any files. This skill is advisory; Sofa's per-Item confirm/edit flow is the only path to a GitHub write.
- When uncertain, the value is `"grill"`. Say so in the rationale.
