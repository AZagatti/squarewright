#!/usr/bin/env node
/**
 * squarewright CLI. Center of gravity: assemble a repo-local AI reviewer on Pi (see docs/adr/0001).
 *
 * Commands:
 *   init     scaffold a reviewer assembly into the current repo   [implemented]
 *   review   run a review over a gathered PR                      [--phase post implemented; --post posts to GitHub]
 *   doctor   check config + provider setup                        [not implemented]
 */
import { Command } from "commander";
import { readGatherArtifact } from "./assembly/artifact.js";
import { loadAssemblyConfig } from "./assembly/config.js";
import {
  postReviewOutput,
  readTrustedRunSignal,
  runReviewPost,
} from "./assembly/review-post.js";
import {
  createGhPoster,
  createGhPullLookup,
  ghRunner,
} from "./github/poster.js";
import { scaffold } from "./init/scaffold.js";
import { resolveProviderKeys } from "./pi/keys.js";
import { createPiWorker } from "./pi/worker.js";
import { verifyPostingTarget } from "./safety/trust.js";

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
    "--post",
    "post the review to the PR (requires the Review workflow's trusted EVENT_HEAD_SHA + EVENT_REPO); without it, prints the review as JSON"
  )
  .option(
    "-C, --cwd <dir>",
    "repo root holding .squarewright.yml",
    process.cwd()
  )
  .action(
    async (opts: {
      phase: string;
      input: string;
      post?: boolean;
      cwd: string;
    }) => {
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
        const output = await runReviewPost(config, context, {
          makeWorker: (apiKeys) => createPiWorker({ apiKeys }),
          resolveKeys: resolveProviderKeys,
        });

        if (opts.post) {
          const trusted = readTrustedRunSignal(process.env);
          const target = await postReviewOutput(output, context, trusted, {
            poster: createGhPoster(ghRunner),
            verifyTarget: (claimed, tr) =>
              verifyPostingTarget(claimed, tr, createGhPullLookup(ghRunner)),
          });
          console.error(
            `Posted review to ${target.repo}#${target.prNumber} @ ${target.commitSha}.`
          );
          return;
        }

        const { sticky, inline, unplaceable } = output;
        process.stdout.write(
          `${JSON.stringify({ inline, sticky, unplaceable }, null, 2)}\n`
        );
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 2;
      }
    }
  );

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
