import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Schema } from "effect";
import { resolve } from "./command";
import { api, command, log, main, output, pullSchema } from "./github";
import { triggerSchema } from "./schema";

const permissionSchema = Schema.Struct({
  permission: Schema.String,
  user: Schema.optional(Schema.NullOr(Schema.Struct({
    permissions: Schema.optional(Schema.Struct({
      admin: Schema.optional(Schema.Boolean),
      maintain: Schema.optional(Schema.Boolean),
      push: Schema.optional(Schema.Boolean),
    })),
  }))),
});

main(() => {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const triggerPath = process.env.REDLINE_TRIGGER ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !triggerPath) throw new Error("GITHUB_REPOSITORY and REDLINE_TRIGGER must be set.");
  const event: unknown = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));

  const result = resolve(process.env.GITHUB_EVENT_NAME ?? "", event as Parameters<typeof resolve>[1], {
    repository,
    pull: (number) => api([`repos/${repository}/pulls/${number}`], pullSchema),
    permission: (login) => api([`repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`], permissionSchema),
    react: (id, content) => {
      command("gh", ["api", `repos/${repository}/issues/comments/${id}/reactions`, "--method", "POST", "-f", `content=${content}`]);
    },
    log,
  });

  if (!result.run) {
    console.log(`::notice::${result.reason}`);
    output("run", "false");
    return;
  }
  // The trigger, including any instructions, goes to a file. Only validated values reach step outputs.
  const trigger = Schema.decodeUnknownSync(triggerSchema)(result.trigger);
  mkdirSync(dirname(triggerPath), { recursive: true });
  writeFileSync(triggerPath, JSON.stringify(trigger, null, 2));
  output("run", "true");
  output("pr", String(trigger.pr));
  output("head", trigger.head);
  log(`Reviewing PR #${trigger.pr} at ${trigger.head}${trigger.manual ? " on request" : ""}.`);
});
