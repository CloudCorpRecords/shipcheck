/**
 * shipcheck types.
 *
 * A ShipReport is the result of checking every public surface a release
 * touches (git tag, package.json and Python metadata at the tag, GitHub
 * release, npm, PyPI, the MCP Registry, GHCR) against one expected version. Every SurfaceCheck carries
 * the evidence for its verdict: what was expected, what was actually found,
 * and the URL it came from. Nothing in a report is inferred silently.
 */

export type SurfaceStatus = "pass" | "fail" | "skip" | "error";

export interface SurfaceCheck {
  /** Stable id, e.g. "git-tag", "npm-latest". */
  surface: string;
  status: SurfaceStatus;
  /** Hard checks decide the verdict. Soft checks are reported only. */
  hard: boolean;
  expected?: string;
  actual?: string;
  detail: string;
  source?: string;
}

export interface ShipReport {
  repo: string;
  version: string;
  verdict: "GO" | "NO-GO";
  checks: SurfaceCheck[];
  checkedAt: string;
  /** Detected project ecosystem: node, python, hybrid (both), or unknown. */
  ecosystem?: "node" | "python" | "hybrid" | "unknown";
}

export interface CheckOptions {
  /** npm package name. Inferred from package.json at the tag when omitted. */
  npmPackage?: string;
  /** PyPI package name. Inferred from the Python metadata (pyproject, setup.cfg, setup.py) when omitted. */
  pypiPackage?: string;
  /** MCP Registry server name. Defaults to io.github.<Owner>/<repo>. */
  serverName?: string;
  /** GHCR image, e.g. ghcr.io/cloudcorprecords/greenlight. Defaults to ghcr.io/<owner>/<repo> lowercased. */
  ghcrImage?: string;
  /** Surfaces to force hard (in addition to defaults). */
  require?: string[];
  /** Surfaces to skip entirely. */
  skip?: string[];
  githubToken?: string;
}

/** Minimal fetch surface so tests can inject fixtures. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchResponse>;
