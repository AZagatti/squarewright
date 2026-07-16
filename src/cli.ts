#!/usr/bin/env node
/**
 * squarewright CLI. Center of gravity: assemble a repo-local AI reviewer on Pi (see docs/adr/0001).
 *
 * Commands:
 *   init     scaffold a reviewer assembly into the current repo   [implemented]
 *   review   run a review over a gathered PR                      [--phase post implemented; --post posts to GitHub]
 *   teach    interpret a reply to a finding into a rule suggestion (ADR-0005 §3) [implemented; driven by the Teach workflow]
 *   doctor   check config + provider setup                        [implemented]
 */
import { Command } from "commander";
import { readGatherArtifact } from "./assembly/artifact.js";
import { loadAssemblyConfig } from "./assembly/config.js";
import { doctorProblems, renderDoctor, runDoctor } from "./assembly/doctor.js";
import { runReviewCommand, runReviewPost } from "./assembly/review-post.js";
import { runTeachCommand } from "./assembly/teach-post.js";
import {
  createGhPoster,
  createGhPullLookup,
  ghRunner,
  spawnRunner,
} from "./github/poster.js";
import { scaffold } from "./init/scaffold.js";
import { fsRepoReader } from "./pi/fs-reader.js";
import { resolveProviderKeys } from "./pi/keys.js";
import { catalogWarnings } from "./pi/model-catalog.js";
import { createReplyInterpreter } from "./pi/reply-interpreter.js";
import { createPiWorker } from "./pi/worker.js";
import { openrouterReasoningRisk } from "./safety/spend-guard.js";

/** Fetch the parent review-comment's body (the finding a reply is attached to) when the event carried one. */
function teachFindingFetcher(env: NodeJS.ProcessEnv) {
  return async (): Promise<string | undefined> => {
    const id = env.TEACH_IN_REPLY_TO_ID;
    const repo = env.TEACH_REPO;
    if (!(id && repo)) {
      return env.TEACH_FINDING || undefined;
    }
    const { code, stdout } = await ghRunner([
      "api",
      `repos/${repo}/pulls/comments/${id}`,
      "--jq",
      ".body",
    ]);
    return code === 0 ? stdout.trim() || undefined : undefined;
  };
}

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
    try {
      await scaffold(opts.cwd);
    } catch (e) {
      // scaffold does real fs I/O (mkdir/cp/write) that can fail (perms, missing/unwritable --cwd). Match the
      // other commands: a clean one-line error + exit 2, never a raw stack trace on the first command users run.
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 2;
    }
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
        const result = await runReviewCommand(
          { cwd: opts.cwd, input: opts.input, post: opts.post },
          {
            env: process.env,
            loadConfig: loadAssemblyConfig,
            lookup: createGhPullLookup(ghRunner),
            poster: createGhPoster(ghRunner, {
              selfLogin:
                process.env.SQUAREWRIGHT_BOT_LOGIN?.trim() || undefined,
            }),
            readArtifact: readGatherArtifact,
            review: (config, context) =>
              runReviewPost(config, context, {
                makeWorker: (apiKeys, structurerLane) =>
                  createPiWorker({ apiKeys, structurerLane }),
                // refuse a reasoning-trap OpenRouter lane before any paid call (#36)
                reasoningRisk: openrouterReasoningRisk,
                // Tier-A rules load from the TRUSTED base checkout the Review workflow provides (default branch,
                // never PR head — see squarewright-review.yml). opts.cwd is that checkout root.
                repoReader: fsRepoReader(opts.cwd),
                resolveKeys: resolveProviderKeys,
              }),
          }
        );
        if (result.posted) {
          const { repo, prNumber, commitSha } = result.posted;
          console.error(`Posted review to ${repo}#${prNumber} @ ${commitSha}.`);
        } else if (result.skipped === "no-open-pr") {
          // Benign no-op, not a failure: the PR was merged/closed before this async review ran. Exit 0 so the
          // workflow stays green — a red "review failed" for a merged PR is noise that erodes trust in the signal.
          console.error(
            "No open PR for this commit (merged or closed before the review ran) — nothing to post. Skipping."
          );
        } else if (result.json) {
          process.stdout.write(result.json);
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 2;
      }
    }
  );

program
  .command("teach")
  .description(
    "Interpret a maintainer's reply to a finding into a rule suggestion and post it (ADR-0005 §3). Driven by the Teach workflow via TEACH_* env; posts only for an authorized actor and a confident, durable rule."
  )
  .action(async () => {
    try {
      const { apiKeys, missing } = await resolveProviderKeys(["zai"]);
      if (missing.length > 0) {
        console.error(
          `teach: missing provider key(s): ${missing.join(", ")}. Set ZAI_API_KEY.`
        );
        process.exitCode = 2;
        return;
      }
      const res = await runTeachCommand({
        env: process.env,
        fetchFinding: teachFindingFetcher(process.env),
        interpreter: createReplyInterpreter({ apiKeys }),
        poster: createGhPoster(ghRunner, {
          selfLogin: process.env.SQUAREWRIGHT_BOT_LOGIN?.trim() || undefined,
        }),
      });
      if (res.posted) {
        console.error(
          `Posted a rule suggestion to ${res.posted.repo}#${res.posted.issueNumber}.`
        );
      } else {
        console.error(
          `No suggestion posted (${res.outcome.kind === "skip" ? res.outcome.reason : "no-post"}).`
        );
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 2;
    }
  });

program
  .command("doctor")
  .description("Check assembly config + provider setup.")
  .option(
    "-C, --cwd <dir>",
    "repo root holding .squarewright.yml",
    process.cwd()
  )
  .action(async (opts: { cwd: string }) => {
    try {
      const report = await runDoctor(opts.cwd, {
        catalogWarnings,
        hasGh: () =>
          spawnRunner("gh")(["--version"])
            .then((r) => r.code === 0)
            .catch(() => false),
        loadConfig: loadAssemblyConfig,
        resolveKeys: resolveProviderKeys,
      });
      process.stdout.write(`${renderDoctor(report)}\n`);
      if (doctorProblems(report) > 0) {
        process.exitCode = 2;
      }
    } catch (e) {
      // a diagnostic must never crash ungracefully — report and fail
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 2;
    }
  });

program.parseAsync();
