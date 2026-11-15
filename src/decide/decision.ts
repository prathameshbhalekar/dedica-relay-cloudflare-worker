/** What the worker decided to do with a request (decide.ts), before anything is fetched (execute.ts). */

import type { DocRequest } from "../dedica/serve";
import type { BlockRule } from "./access";

/** What the worker did with a request, as reported. */
export type Outcome =
  | "proxied" // a path the policy proxies to Dedica (`/mcp`, `/ask`, ...)
  | "artifact" // a file Dedica manages (`/llms.txt`, ...), from Dedica
  | "artifact_origin" // a `fallback` file the origin has itself
  | "blocked" // a bot the site's Agent Access rules block
  | "twin" // an explicit markdown URL (`/pricing.md`)
  | "negotiated" // the agent version of a normal page URL
  | "human_page" // a search engine, preview or unknown crawler kept the normal page
  | "origin"; // passed through to the origin

/** `public`: a file that is the same for everyone. `eligible`: the agent version of a page URL. */
export type Category = "public" | "eligible" | null;

export type Decision =
  /** The origin answers. `report: false` for Dedica's own crawler, which is never reported. */
  | { do: "origin"; outcome: "origin" | "human_page"; report?: false }
  /** An Agent Access 403. JSON on proxied paths. */
  | { do: "block"; rule: BlockRule; json: boolean }
  /** Dedica's document; if Dedica has none, the origin answers. */
  | { do: "serve"; doc: DocRequest; outcome: "artifact" | "twin" | "negotiated" }
  /** A `fallback` artifact: the origin's own file if it has one, else Dedica's, else the origin's answer. */
  | { do: "fallback"; doc: DocRequest }
  /** A proxied path, sent to Dedica; if Dedica can't be reached or declines, the origin answers. */
  | { do: "proxy"; target: URL };

export const ORIGIN: Decision = { do: "origin", outcome: "origin" };
/** Dedica's own crawler: the origin answers, unreported. */
export const ORIGIN_UNREPORTED: Decision = { do: "origin", outcome: "origin", report: false };
