# Agent Instructions

Read items 0-2 in full. Everything below is reference: consult it when relevant, not front to back.

## Always, in full

0. `docs/AGENT_HANDOFF.md` — live baton, current owner, blockers, and uncommitted work. Read it first. Protocol: `~/.claude/HANDOFF.md`.
1. `README.md` — purpose, architecture, supported behavior, and limits.
2. `docs/SECURITY_AUDIT.md` — credential, network, container, and dependency invariants.

## Reference — search, do not read front to back

3. `docs/INVARIANTS.md` — what must not be undone, re-diagnosed, or "simplified", and why. Search it
   **before** changing reconnect/session lifecycle, the circuit breaker, or Homebridge on the NAS,
   and before concluding "no video" is our bug.
4. `Journal.md` — the narrative **why**: how the current state came about, what was tried and
   rejected, and measured findings. Read the **most recent entry**; `grep` for older ones. Older
   entries are archived under `docs/journal/`.
5. `docs/UPSTREAM.md` — use when sending anything to Omar-L: what is open, what is held, and the
   rules (verify against **their** lockfile; never ship internal docs).
6. `docs/SETUP.md` — use for general deployment or Homebridge integration.
7. `docs/SYNOLOGY.md` — use for Synology Container Manager deployment and operations.
8. `docs/superpowers/specs/` and `docs/superpowers/plans/` — historical design and test-foundation context; search for the relevant decision.

If another document contradicts the baton, the baton wins. Do not commit `.env`, real camera configuration, credentials, tokens, camera names or IDs, logs, or captured media.
