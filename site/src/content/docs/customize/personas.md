---
title: Personas & rules
description: The review lenses, and teaching the reviewer your project's conventions.
---

## Personas

Personas are review lenses. The default set covers correctness, security, CSS, build/config, Docker, and CI. Each
is a prompt + a lane + `when` globs deciding when it runs, capped so cost and attention stay bounded.

```yaml
personas:
  - id: sentinel
    label: Correctness
    lane: cheap
    when: ["always"]
    prompt: "Hunt for correctness bugs the diff introduces…"
```

## Rules memory

Drop `.review-rules/*.md` files (with `globs:` frontmatter) into your repo to teach the reviewer conventions it
should enforce; they are loaded from the **trusted base revision** and take precedence over model guesses. A
**rule-drift** path lets the reviewer *propose* a new rule for a recurring pattern — as a human-ratified
suggestion, never an auto-write.
