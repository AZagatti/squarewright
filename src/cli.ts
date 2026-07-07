#!/usr/bin/env node
/**
 * squarewright CLI. Center of gravity: assemble a repo-local AI reviewer on Pi (see docs/adr/0001).
 *
 * Commands:
 *   init     scaffold a reviewer assembly into the current repo   [implemented]
 *   review   run a review (gather / post phases)                  [v0.1 — in construction]
 *   doctor   check config + provider setup                        [v0.1 — in construction]
 */
import { Command } from "commander";
import { readGatherArtifact } from "./assembly/artifact.js";
import { loadAssemblyConfig } from "./assembly/config.js";
import { runReviewPost } from "./assembly/review-post.js";
import { scaffold } from "./init/scaffold.js";
import { createPiWorker } from "./pi/worker.js";

const program = new Command();

program
  .name("squarewright")
  .description("Assemble your own repo-local AI code reviewer, on top of Pi.")
  .version("0.0.0-pre");

program
  .command("init")
  .description(
    "Scaffold a reviewer assembly (workflows + .squarewright.yml + rules) into this repo."
  )
  .option("-C, --cwd <dir>", "repo root to scaffold into", process.cwd())
  .action(async (opts: { cwd: string }) => {
    await scaffold(opts.cwd);
  });

program
  .command("review")
  .description("Run a review over a gathered PR (drives Pi).")
  .option("--phase <phase>", "gather | post", "post")
  .option("--input <dir>", "gather-artifact directory", "artifacts")
  .option(
    "-C, --cwd <dir>",
    "repo root holding .squarewright.yml",
    process.cwd()
  )
  .action(async (opts: { phase: string; input: string; cwd: string }) => {
    if (opts.phase !== "post") {
      console.error(
        `squarewright review --phase ${opts.phase} is not implemented yet — only --phase post. See docs/ROADMAP.md.`
      );
      process.exitCode = 2;
      return;
    }
    try {
      const config = loadAssemblyConfig(opts.cwd);
      const context = readGatherArtifact(opts.input);
      const { sticky, inline, unplaceable } = await runReviewPost(
        config,
        context,
        (apiKeys) => createPiWorker({ apiKeys })
      );
      process.stdout.write(
        `${JSON.stringify({ inline, sticky, unplaceable }, null, 2)}\n`
      );
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 2;
    }
  });

program
  .command("doctor")
  .description(
    "Check assembly config + provider setup. v0.1 — in construction."
  )
  .action(() => {
    console.error(
      "squarewright doctor is not implemented yet — see docs/ROADMAP.md."
    );
    process.exitCode = 2;
  });

program.parseAsync();
