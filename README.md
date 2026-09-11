# Idempotent Transfer Engine

A record-merge job that must land **exactly once** — even when the request is duplicated, the worker crashes mid-transfer, or two transfers race each other against the same source/target pair.

Built for Anthropic's Software Engineering take-home, **Theme 3: Systems & Reliability**.

**Live demo:** https://achalmahajan.github.io/gtm_idempotent_engine/

## Why this problem

This isn't an abstract distributed-systems exercise — it's modeled on a real pattern I've seen in production CPQ implementations: a GTM renewal workflow.

To save sellers time, a system might automatically prepare a renewal by creating an opportunity, generating a quote and quote lines, configuring products, calculating pricing, and applying adjustments. From the seller's perspective this should feel like one operation, but underneath it's a sequence of dependent steps across multiple components. Any one of those steps can fail after earlier ones already succeeded — a worker crashes halfway through, a request gets retried because the caller never received a response, or two workers attempt the same renewal at the same time. Without careful reliability mechanisms, that leaves duplicate records, partial state, or a workflow that requires manual cleanup — and I've seen exactly that failure mode in a real CPQ instance, not just in theory.

That directly hurts the seller experience: sellers, and the business overall, care about deal velocity — less time fixing system issues, more time with customers.

This tool models that class of problem in miniature, around one invariant: every source line should appear exactly once in the final target state, even when retries, crashes, and concurrent execution occur. It intentionally strips the renewal workflow down to a single source record's lines merging into a single target record — the goal is to isolate and make visible the three failure modes and their fixes, not to model the full multi-object renewal graph (see [Extending this with more time](#extending-this-with-more-time) for how this would generalize to Contract → Opportunity/Quote).

## The problem

A "Source" record has N child "lines" that need to be merged into a "Target" record. That sounds trivial — until the transfer has to survive the failure modes every real distributed system hits:

- **Duplicate requests** — the same transfer gets submitted twice (a retry, a double-click, an at-least-once delivery).
- **Crashes mid-transfer** — the worker dies after applying some lines but not all, leaving the job in a partial state.
- **Concurrent transfers** — two transfers race against the same source/target pair.

A naive implementation gets duplicate or missing data in every one of these cases, and the usual "fix" is a human manually re-running (or worse, hand-patching) the whole process. This tool makes that failure mode visible, then shows the three independent mechanisms that actually prevent it.

## The three protections

Each is implemented for real (not just described) and independently toggleable, so you can turn one off, break the system, and turn it back on to watch it converge:

1. **Idempotency-key dedup** — the target stores each line keyed by its source line ID. Re-applying an already-present line is a no-op, so repeating an operation is always safe.
2. **Cursor resume** — every transfer job tracks the last chunk it completed. Resuming after a crash continues from that cursor instead of restarting from zero.
3. **Source/target lock** — only one job may run against a given source+target pair at a time; a second concurrent request is rejected outright rather than being left to reconcile after the fact.

## Quick start

No build step, no dependencies. Just serve the folder statically and open it:

```bash
cd Idempotent_engine
python3 -m http.server 8791
# open http://127.0.0.1:8791 in a browser
```

(Or use any static server / `npx serve` / VS Code's Live Server — it's plain HTML/CSS/JS.)

## How to evaluate this

The fastest way to see the point of the tool: click through the four **Guided demos** buttons in order. Each one runs a fully scripted scenario — no setup, no data to bring — and narrates itself via the banner at the top:

1. **Clean transfer** — baseline: all protections on, a transfer completes and the Integrity panel goes green.
2. **Break it: duplicate request** — protections off, the same request fires twice, watch the Integrity panel show real duplicates (with `DUP` badges on the affected lines). Then dedup is turned back on and the identical duplicate request is repeated — it converges to the correct state even though two jobs actually ran.
3. **Crash + resume** — a large transfer is killed mid-flight (simulated crash) and resumed. First with cursor-resume on (clean recovery), then with it off (resuming restarts from zero and duplicates everything applied before the crash — the "seller has to restart the whole process" failure mode).
4. **Break it: concurrent race** — two transfers fired almost simultaneously with no lock, producing genuine duplicates from two independent jobs that never knew about each other. Then the lock is turned back on and the second request is rejected outright in the event log.

You can also drive it manually with the **Chaos controls** and **Protections** toggles instead of the guided scripts.

## Tests

`engine.js`'s logic is covered by unit tests using Node's built-in test runner — no dependencies to install, in keeping with the rest of the project:

```bash
node --test tests/
```

They drive the engine directly (calling `_tick` instead of waiting on real timers) to verify the same invariant the guided demos show visually: dedup skipping already-applied lines, cursor-resume preventing re-application after a crash, and the lock rejecting/releasing correctly — plus the `checkIntegrity` duplicate/missing calculation itself.

## Architecture

Plain HTML/CSS/JS, no framework, no backend — everything (the "distributed" job processing included) runs client-side in the browser.

| File | Responsibility |
|---|---|
| `engine.js` | Pure simulation logic: `Source`/`Target`/`TransferJob` model, chunked async job processing (`setInterval`-driven ticks), the dedup/resume/lock mechanisms, and an integrity checker. No DOM dependencies. |
| `app.js` | DOM rendering, manual control wiring, and the four scripted guided-demo scenarios. |
| `index.html` / `style.css` | Layout and styling. |

Both scripts are wrapped in IIFEs with an init guard, so they're safe even if injected/executed more than once on the page.

## Design notes

- **Concurrency is simulated, not physically parallel.** Because JavaScript is single-threaded with run-to-completion semantics, "two workers running at once" here means two independently-scheduled `setInterval` timers whose ticks interleave over time — not literal parallel execution. The protective mechanisms themselves (the idempotency key, the cursor, the lock) are exactly what a real distributed system would use; only the "two workers racing at the exact same instant" part is a simplification appropriate for a browser-based demo. This tradeoff was made deliberately to keep the whole thing a static, dependency-free page that's trivially deployable and will never go down for a reviewer — a real backend with real threads would demonstrate genuine races, at the cost of needing a live server.
- **Sync/async chunking:** jobs process in fixed-size chunks (3 lines per tick) rather than all at once, so the failure/resume mechanics have something observable to interrupt mid-flight.
- **The Integrity panel distinguishes "not started yet" from "corrupted."** An early version conflated these (a fresh demo with zero lines transferred technically "matches" the missing-lines condition), which falsely read as broken on first load. It now shows a neutral "awaiting transfer" state until a job has actually run.

## Extending this with more time

- **Multiple source objects mapping to multiple target objects, with parent/child structure** — not just one source to one target. A real GTM renewal is a hierarchy: renewing *from* a Contract with Contract Lines *into* an Opportunity with Opportunity Lines, and/or a Quote with Quote Lines. The invariant would then have to hold at two levels at once — each parent object exactly once, and each child line re-parented to the *right* new parent exactly once. The exact shape of that fan-out (parallel branches vs. a sequential chain where the Quote is created from the Opportunity) is business-specific and would need verifying against the actual renewal process; see the design rationale doc for more on this.
- Real backend with actual threads/async workers (Node or Python) instead of simulated concurrency, to demonstrate genuine races rather than scripted interleaving.
- A "poison line" failure mode — a line that always fails validation — to demonstrate dead-lettering after N retries.
- Persist state to IndexedDB so a demo survives a page refresh.
- Multiple concurrent source/target pairs, to show the lock is scoped correctly and doesn't over-serialize unrelated transfers.
