# Architecture & Flow Diagrams

Visual diagrams complementing the text-based documentation in [OVERVIEW.md](../OVERVIEW.md).

---

## 1. High-Level Architecture

```mermaid
graph TB
    CLI["CLI Entry<br/>(Commander.js)"] --> Runner["SprintRunner"]
    Runner --> Ceremonies

    subgraph Ceremonies["Ceremonies Pipeline"]
        direction TB
        Refine["Refinement"] --> Plan["Planning"]
        Plan --> Execute["Parallel Execution"]
        Execute --> Review["Sprint Review"]
        Review --> Retro["Retrospective"]
    end

    subgraph ACP["ACP Layer"]
        Client["AcpClient<br/>(stdio)"] --> CopilotCLI["Copilot CLI<br/>(subprocess)"]
        SessionConfig["Session Config<br/>(per-role)"]
        Permissions["Permission Handler"]
    end

    subgraph Enforcement["Enforcement (cross-cutting)"]
        QualityGate["Quality Gate<br/>(test/lint/types/build)"]
        DriftControl["Drift Control"]
        Escalation["Escalation<br/>(MUST / SHOULD)"]
        CodeReview["Code Review Agent"]
    end

    subgraph External["External Integrations"]
        GitHub["GitHub<br/>(Issues / Labels / Milestones)"]
        Git["Git<br/>(Worktrees / Merge / Diff)"]
    end

    Execute --> Client
    Execute --> QualityGate
    Execute --> CodeReview
    QualityGate --> Escalation
    DriftControl --> Escalation

    Runner --> GitHub
    Runner --> Git
    Execute --> Git

    subgraph Observability["Dashboard (Observer)"]
        WSServer["WebSocket Server"]
        EventBus["EventBus<br/>(typed events)"]
        Dashboard["Browser UI"]
    end

    Runner --> EventBus
    EventBus --> WSServer
    WSServer --> Dashboard

    Config["Config<br/>(YAML + Zod)"] --> Runner
    State["State Manager<br/>(atomic JSON)"] --> Runner
```

---

## 2. Sprint Lifecycle Sequence

```mermaid
sequenceDiagram
    participant S as Stakeholder
    participant R as SprintRunner
    participant ACP as ACP / Copilot
    participant GH as GitHub
    participant G as Git

    Note over R: Sprint N begins

    rect rgb(230, 245, 255)
        Note over R,ACP: Refinement Phase
        R->>GH: List "type:idea" issues
        R->>ACP: Refine issues (add AC, ICE scores)
        ACP-->>R: Refined issues
        R->>GH: Update issues with AC + labels
    end

    rect rgb(230, 255, 230)
        Note over R,ACP: Planning Phase
        R->>GH: List backlog issues
        R->>ACP: Select & sequence issues (ICE scoring)
        ACP-->>R: Sprint plan (issues + groups)
        R->>GH: Label issues "status:planned", assign milestone
    end

    rect rgb(255, 245, 230)
        Note over R,G: Execution Phase (per issue, parallel)
        R->>G: Create worktree + branch
        R->>ACP: Plan phase (Planner role)
        ACP-->>R: Implementation plan
        R->>GH: Post plan as comment

        opt TDD Mode enabled
            R->>ACP: TDD phase (Test-Engineer role)
            ACP-->>R: Test files written
        end

        R->>ACP: Implement phase (Developer role)
        ACP-->>R: Code changes

        R->>R: Quality Gate (programmatic)
        alt Quality Gate passes
            R->>GH: Post ✅ QG results
            R->>ACP: Code Review (Reviewer role)
            alt Review approved
                R->>G: Create PR, merge
                R->>G: Verify main branch
            else Review rejected
                R->>ACP: Fix attempt (Developer role)
                R->>R: Re-run Quality Gate
            end
        else Quality Gate fails
            R->>ACP: Fix attempt with feedback
            R->>R: Re-run Quality Gate (max retries)
            alt Still failing
                R->>GH: Label "status:blocked"
                R->>S: Escalate (if MUST)
            end
        end

        R->>G: Remove worktree
        R->>GH: Post huddle comment
    end

    rect rgb(245, 230, 255)
        Note over R,ACP: Review Phase
        R->>ACP: Review sprint results
        ACP-->>R: Demo items, velocity update
    end

    rect rgb(255, 230, 230)
        Note over R,ACP: Retrospective Phase
        R->>ACP: Analyze sprint + check previous improvements
        ACP-->>R: Went well, went badly, improvements
        R->>GH: Create improvement issues
    end

    Note over R: Sprint N complete
```

---

## 3. Data Flow

```mermaid
flowchart LR
    subgraph Input
        YAML[".aiscrum/config.yaml"]
        ENV["Environment Variables"]
    end

    subgraph Config["Configuration Layer"]
        Zod["Zod Schema Validation"]
        YAML --> Zod
        ENV -->|substituteEnvVars| Zod
        Zod --> SprintConfig["SprintConfig"]
    end

    subgraph State["State Persistence"]
        SM["State Manager"]
        SprintConfig --> SM
        SM -->|atomic write<br/>tmp→fsync→rename| JSON["sprint-state.json"]
        SM -->|file lock| Lock[".lock file"]
    end

    subgraph Events["Event Bus"]
        EB["SprintEventBus<br/>(15 typed events)"]
    end

    subgraph Execution
        Runner["SprintRunner"] --> EB
        Runner --> SM
    end

    subgraph Outputs["Documentation Outputs"]
        SL["Sprint Log<br/>(docs/sprints/sprint-N-log.md)"]
        VE["Velocity<br/>(docs/sprints/velocity.md)"]
        HU["Huddle Comments<br/>(GitHub issue comments)"]
    end

    Runner --> SL
    Runner --> VE
    Runner --> HU

    subgraph Dashboard["Dashboard"]
        WS["WebSocket Server"]
        Buffer["Event Buffer<br/>(max 200, FIFO)"]
        Browser["Browser UI"]
    end

    EB --> WS
    WS --> Buffer
    Buffer -->|replay on connect| Browser
    WS -->|live events| Browser
```
