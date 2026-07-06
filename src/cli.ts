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
import { scaffold } from "./init/scaffold.js";

const program = new Command();

program
  .name("squarewright")
  .description("Assemble your own repo-local AI code reviewer, on top of Pi.")
  .version("0.0.0-pre");

program
  .command("init")
  .description("Scaffold a reviewer assembly (workflows + .squarewright.yml + rules) into this repo.")
  .option("-C, --cwd <dir>", "repo root to scaffold into", process.cwd())
  .action(async (opts: { cwd: string }) => {
    await scaffold(opts.cwd);
  });

program
  .command("review")
  .description("Run a review over a PR (drives Pi). v0.1 — in construction.")
  .option("--phase <phase>", "gather | post", "post")
  .action((opts: { phase: string }) => {
    console.error(
      `squarewright review (--phase ${opts.phase}) is not implemented yet.\n` +
        `The Pi-driven harness is the v0.1 build — see docs/ROADMAP.md.`,
    );
    process.exitCode = 2;
  });

program
  .command("doctor")
  .description("Check assembly config + provider setup. v0.1 — in construction.")
  .action(() => {
    console.error("squarewright doctor is not implemented yet — see docs/ROADMAP.md.");
    process.exitCode = 2;
  });

program.parseAsync();
