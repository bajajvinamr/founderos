# Engineering Queue

Items the chief-of-staff has drained from `product-backlog.md`, in dispatch order. The engineering team picks the top `queued` item with all dependencies `merged`.

**Schema per entry**:
```
## [EQ-NNN] <title>  (from BL-NNN)
- branch: <feat/...>
- agent: <agent-id-from-dispatch>
- dispatched_at: <iso ts>
- pr: <#N | null>
- status: <queued|dispatched|in_progress|pr_opened|merged|blocked|abandoned>
- last_update: <iso ts>
- notes: <any blockers or surprises>
```

---

(empty — populated by chief-of-staff after activation)
