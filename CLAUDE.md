# Agent Instructions

Read items 0-2 in full. Everything below is reference: consult it when relevant, not front to back.

## Always, in full

0. `docs/AGENT_HANDOFF.md` — live baton, current owner, blockers, and uncommitted work. Read it first. Protocol: `~/.claude/HANDOFF.md`.
1. `README.md` — purpose, architecture, supported behavior, and limits.
2. `docs/SECURITY_AUDIT.md` — credential, network, container, and dependency invariants.

## Reference — search, do not read front to back

3. `Journal.md` — the narrative **why**: how the current state came about, what was tried and
   rejected, and measured findings. Read the **most recent entry**; `grep` for older ones. Older
   entries are archived under `docs/journal/`.
4. `docs/SETUP.md` — use for general deployment or Homebridge integration.
5. `docs/SYNOLOGY.md` — use for Synology Container Manager deployment and operations.
6. `docs/superpowers/specs/` and `docs/superpowers/plans/` — historical design and test-foundation context; search for the relevant decision.

If another document contradicts the baton, the baton wins. Do not commit `.env`, real camera configuration, credentials, tokens, camera names or IDs, logs, or captured media.
