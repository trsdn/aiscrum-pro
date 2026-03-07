---
name: copilot-authoring
description: Guide for modifying agent configurations (copilot-instructions.md and SKILL.md).
---

## When to Use

- Applying retro improvements to agent instructions
- Creating new skills based on sprint learnings
- Fixing recurring agent errors by updating guidance

## Agent Structure

```
.aiscrum/roles/<role>/
├── copilot-instructions.md    # Core role definition
├── prompts/                   # Task-specific prompt templates
│   └── <task>.md
└── skills/                    # Reusable capability definitions
    └── <skill-name>/
        └── SKILL.md
```

## Modification Rules

- Make surgical changes — edit specific sections, not full rewrites
- Preserve existing structure and formatting
- Add guidance, don't remove working instructions
- Keep CLI commands accurate
- Preserve stakeholder authority rules
- One improvement per change

## Safety

- Never modify log directories
- Propose changes before applying
- Preserve existing behavior
- Test that modified files are valid markdown
