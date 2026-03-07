---
name: copilot-authoring
description: "Reference for creating and modifying Copilot agent configurations: copilot-instructions.md and SKILL.md files. Essential for the retro agent's job of improving agent capabilities based on session log analysis."
---

# Copilot Authoring Guide — For Retro Agent

You modify agent configurations to improve their performance. This guide defines the exact formats and rules you must follow.

## Agent Configuration Structure

Each agent role lives in `.aiscrum/roles/<role>/`:

```
.aiscrum/roles/<role>/
├── copilot-instructions.md    # Agent identity, workflow, rules
├── skills/
│   ├── <skill-name>/SKILL.md  # Specialized capabilities
│   └── <skill-name>/SKILL.md
└── log/                       # Session logs (DO NOT modify, DO NOT load)
    └── sprint-N/
```

The system loads ALL `.md` files from the role folder (except `log/`) into the agent's context window. Keep files concise.

## copilot-instructions.md Format

```markdown
# {Role Name} Agent — Copilot Instructions

You are a **{Role Name} Agent** for the AiScrum Pro project.

## Role
One-sentence description.

## Workflow
1. **Step**: Exact action with CLI commands
2. ...

## Rules
- Hard constraints
- Safety boundaries
- What NOT to do
```

### When Modifying Instructions

- **Preserve the structure**: Keep the Role → Workflow → Rules sections
- **Be surgical**: Change only what the logs show needs improvement
- **Add, don't rewrite**: Prefer adding a new rule or clarifying a step over rewriting the whole file
- **Keep CLI commands**: Agents work via terminal — always include exact commands
- **Stakeholder Authority rule**: Never remove this — every role must include it

## SKILL.md Format

```markdown
---
name: skill-name
description: "What the skill does and when to use it (max 1024 chars)"
---

# Skill: {Title}

## When to Use
- Trigger conditions

## Instructions
Step-by-step with exact commands.

## Examples
Concrete input/output.

## Rules
- Constraints for this skill
```

### Frontmatter Fields

| Field | Required | Max Length |
|-------|----------|-----------|
| `name` | Yes | 64 chars, lowercase-with-hyphens |
| `description` | Yes | 1024 chars, specific and descriptive |

### When Modifying Skills

- **Fix commands**: If logs show an agent using wrong CLI syntax, fix it in the skill
- **Add examples**: If logs show repeated confusion, add concrete examples
- **Add rules**: If logs show the agent overstepping, add a constraint
- **Create new skills**: If logs show a recurring capability gap, create a new skill directory with SKILL.md
- **Never delete skills**: Deprecate by adding a note, but don't remove

## How to Apply Improvements

### Pattern: Fix a Recurring Error

```
Log shows: Refiner keeps running `gh issue edit --label` instead of `--add-label`
Action: Update .aiscrum/roles/refiner/skills/issue-editing/SKILL.md
Change: Fix the command example to use `--add-label`
```

### Pattern: Add Missing Guidance

```
Log shows: Planner doesn't check for milestone conflicts
Action: Add a new rule to .aiscrum/roles/planner/copilot-instructions.md
Change: Add "Check for existing milestone before creating new one" to Rules section
```

### Pattern: New Capability Needed

```
Log shows: Reviewer needs to check for breaking API changes but has no skill for it
Action: Create .aiscrum/roles/reviewer/skills/api-compatibility/SKILL.md
Change: New skill with instructions for detecting breaking changes
```

## Safety Rules for Retro Agent

1. **Never modify `log/`** — logs are read-only input for analysis
2. **Propose changes, don't auto-apply** — show the user what you plan to change and get confirmation
3. **One improvement per change** — small, focused edits, not bulk rewrites
4. **Preserve existing behavior** — improvements must be additive, not destructive
5. **Context budget** — every byte added to a role folder costs context tokens. Be concise
6. **Test the change** — after modifying, verify the role folder still loads correctly

## Reference

- [Agent Skills standard](https://agentskills.io/)
- Agent loader: `src/dashboard/chat-manager.ts` → `loadRoleContext()` recursively loads `.md` files (excludes `log/`)
- Available roles: refiner, planner, reviewer, researcher, general
