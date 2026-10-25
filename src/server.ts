import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin/effect";
import { Effect, Schema } from "effect";
import { contextSchema, errorMessage, readJson, reviewSchema, validateReview } from "./schema";

const limitsSchema = Schema.Struct({ wrapUpMinutes: Schema.Number, submitMinutes: Schema.Number });
const wrapUp = "Stop starting new investigations and resolve candidates already under review. Update your working summary with confirmed findings, rejected candidates and their reasons, and unfinished checks.";
const submitNow = "You are almost out of time. Stop investigating and consolidate your review using the evidence you already gathered. Review your findings, drop unsupported claims, merge duplicates, and rank the remaining findings by impact. Call submit_review before the time limit. If coverage is incomplete, set status to incomplete and list unfinished checks in gaps.";

export default Plugin.define({
  id: "redline",
  effect: (ctx) => Effect.gen(function* () {
    const directory = join(ctx.location.directory, ".github", "redline");
    const context = readJson(join(directory, "context.json"), contextSchema);
    const limits = Schema.decodeUnknownSync(limitsSchema)(ctx.options);
    const start = Date.now();
    const reached = (minutes: number) => Date.now() - start >= minutes * 60_000;

    yield* ctx.session.hook("title", (event) => Effect.sync(() => { event.result = "Redline review"; }));
    yield* ctx.session.hook("context", (event) => Effect.sync(() => {
      if (reached(limits.submitMinutes)) {
        event.system.push({ type: "text", text: submitNow });
        for (const name of Object.keys(event.tools)) {
          if (name !== "submit_review") delete event.tools[name];
        }
      } else if (reached(limits.wrapUpMinutes)) {
        event.system.push({ type: "text", text: wrapUp });
      }
    }));
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "submit_review",
        description: "Submit the finished review. Use status incomplete only when changed code you needed went unread, and list it in gaps. Findings must target added lines in the PR.",
        input: reviewSchema,
        options: { codemode: false },
        execute: (input) => Effect.sync(() => {
          try {
            writeFileSync(join(directory, "review.json"), JSON.stringify(validateReview(input, context), null, 2));
            return { content: "Review submitted. End the session now." };
          } catch (error) {
            return { content: `Review not submitted: ${errorMessage(error)}` };
          }
        }),
      });
    });
  }),
});
