#!/usr/bin/env node
/**
 * shipcheck CLI.
 *
 *   shipcheck check owner/repo [version] [--npm pkg] [--server name] [--ghcr image]
 *                        [--require npm,registry,ghcr,release] [--skip ghcr] [--json]
 *   shipcheck npm @scope/pkg [version] [--json]
 *   shipcheck registry io.github.Owner/repo [version] [--json]
 *   shipcheck mcp
 *
 * Exit codes: 0 GO, 1 NO-GO, 2 usage or setup error.
 * GITHUB_TOKEN is optional and only raises GitHub API rate limits.
 * When version is omitted for `check`, it is read from package.json on the
 * default branch. For `npm` / `registry`, it is that surface's latest.
 */
import {
  checkNpm,
  checkRegistry,
  checkRelease,
  normalizeVersion,
  renderReport,
  VERSION,
} from "./check.js";
import type { ShipReport, SurfaceCheck } from "./types.js";

function usage(): never {
  console.error(`Usage:
  shipcheck check owner/repo [version] [--npm pkg] [--server name] [--ghcr image] [--require list] [--skip list] [--json]
  shipcheck npm @scope/pkg [version] [--json]
  shipcheck registry io.github.Owner/repo [version] [--json]
  shipcheck mcp
  shipcheck --version`);
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (["--npm", "--server", "--ghcr", "--require", "--skip", "--version"].includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function reportFromChecks(
  label: string,
  version: string,
  checks: SurfaceCheck[],
): ShipReport {
  const verdict = checks.some(
    (c) => c.hard && (c.status === "fail" || c.status === "error"),
  )
    ? "NO-GO"
    : "GO";
  return { repo: label, version, verdict, checks, checkedAt: new Date().toISOString() };
}

function emit(report: ShipReport, asJson: boolean): void {
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
  process.exit(report.verdict === "GO" ? 0 : 1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (!cmd) usage();
  try {
    if (cmd === "check") {
      const [repoRef, posVersion] = positional(rest);
      if (!repoRef) usage();
      const version = flag(rest, "--version") ?? posVersion;
      const split = (v?: string): string[] | undefined =>
        v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const report = await checkRelease(fetch, repoRef, version, {
        npmPackage: flag(rest, "--npm"),
        serverName: flag(rest, "--server"),
        ghcrImage: flag(rest, "--ghcr"),
        require: split(flag(rest, "--require")),
        skip: split(flag(rest, "--skip")),
      });
      emit(report, has(rest, "--json"));
    } else if (cmd === "npm") {
      const [pkg, posVersion] = positional(rest);
      if (!pkg) usage();
      const probe = await checkNpm(fetch, pkg, posVersion ? normalizeVersion(posVersion) : "");
      const version = posVersion
        ? normalizeVersion(posVersion)
        : (probe.latest ?? "");
      const result = posVersion ? probe : await checkNpm(fetch, pkg, version);
      emit(reportFromChecks(pkg, version, result.checks), has(rest, "--json"));
    } else if (cmd === "registry") {
      const [serverName, posVersion] = positional(rest);
      if (!serverName) usage();
      // Without an explicit version, resolve the registry's own latest
      // entry first, then check that version for self-consistency.
      const version = posVersion ? normalizeVersion(posVersion) : "";
      const probe = await checkRegistry(fetch, serverName, version);
      const resolved =
        version || probe.find((c) => c.surface === "registry-latest")?.actual || "";
      const finalChecks = version ? probe : await checkRegistry(fetch, serverName, resolved);
      emit(reportFromChecks(serverName, resolved, finalChecks), has(rest, "--json"));
    } else {
      usage();
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

void main();
