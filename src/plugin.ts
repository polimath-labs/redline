import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin/effect";
import { Effect, Schema } from "effect";
import { contextSchema, errorMessage, readJson, reviewSchema, validateReview } from "./schema";

const limitsSchema = Schema.Struct({ wrapUpMinutes: Schema.Number, submitMinutes: Schema.Number });
const wrapUp = "You are close to the time limit. Finish checking the findings you are working on, then call submit_review. If you did not cover everything, set status to incomplete and list the gaps.";
const submitNow = "Time is up. Call submit_review now with the findings you have already confirmed. Set status to incomplete and list what you did not cover in gaps.";

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
