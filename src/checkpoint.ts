import { deflateRawSync, inflateRawSync } from "node:zlib";
import { Schema } from "effect";
import { stateSchema } from "./schema";
import type { State } from "./schema";

// Reviews post with the workflow's GITHUB_TOKEN. Anyone else can paste the marker, so only this author's state counts.
export const botLogin = "github-actions[bot]";

const statePattern = /<!-- redline:state ([A-Za-z0-9_-]+) -->/;

// Compressed to fit the review body limit. Base64url keeps model-written text such as "-->" from ending the comment early.
export function encodeState(state: State) {
  return `<!-- redline:state ${deflateRawSync(JSON.stringify(state)).toString("base64url")} -->`;
}

export function decodeState(body: string): State | undefined {
  const match = statePattern.exec(body);
  if (!match?.[1]) return undefined;
  try {
    return Schema.decodeUnknownSync(stateSchema)(JSON.parse(inflateRawSync(Buffer.from(match[1], "base64url"), { maxOutputLength: 1_000_000 }).toString("utf8")));
  } catch {
    return undefined;
  }
}

export function stripState(body: string) {
  return body.replace(statePattern, "").trim();
}

type PostedReview = {
  readonly body: string | null;
  readonly user: { readonly login: string; readonly type: string } | null;
  readonly commit_id?: string | null | undefined;
};

// The last review Redline posted, if it carries a state for the commit it was posted on.
export function latestState(reviews: readonly PostedReview[]): State | undefined {
  for (const review of reviews.toReversed()) {
    if (review.user?.login !== botLogin || review.user.type !== "Bot" || !review.body) continue;
    const state = decodeState(review.body);
    if (state && state.head === review.commit_id) return state;
  }
  return undefined;
}

export type Git = {
  mergeBase(a: string, b: string): string;
  isAncestor(ancestor: string, descendant: string): boolean;
};

export type Plan =
  | { mode: "skip"; reason: string; mergeBase: string }
  | { mode: "full" | "revisit"; reason: string; mergeBase: string; since: null }
  | { mode: "incremental"; reason: string; mergeBase: string; since: string };

export type PlanInput = {
  state: State | undefined;
  head: string;
  base: string;
  baseRef: string;
  manual: boolean;
  full: boolean;
};

// Picks what this run reviews. Anything that makes the checkpoint unsafe falls back to a full review.
export function plan(input: PlanInput, git: Git): Plan {
  const mergeBase = git.mergeBase(input.base, input.head);
  const full = (reason: string): Plan => ({ mode: "full", reason, mergeBase, since: null });
  const { state } = input;
  if (input.full) return full("Full review requested.");
  if (!state) return full("First review of this pull request.");
  if (state.baseRef !== input.baseRef) return full(`The base branch changed from ${state.baseRef} to ${input.baseRef}.`);
  if (state.head === input.head) {
    return input.manual
      ? { mode: "revisit", reason: "Requested again with no new commits.", mergeBase, since: null }
      : { mode: "skip", reason: `No new commits since the review of ${state.head.slice(0, 7)}.`, mergeBase };
  }
  let ancestor = false;
  try {
    ancestor = git.isAncestor(state.head, input.head);
  } catch {
    ancestor = false;
  }
  if (!ancestor) return full(`The last reviewed commit ${state.head.slice(0, 7)} is no longer in this branch's history.`);
  if (state.mergeBase !== mergeBase) return full("The branch picked up new commits from the base branch.");
  return { mode: "incremental", reason: `Changes since ${state.head.slice(0, 7)}.`, mergeBase, since: state.head };
}
