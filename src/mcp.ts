/**
 * shipcheck MCP server. Tools: check_release, check_npm, check_pypi, check_registry.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkNpm, checkPypi, checkRegistry, checkRelease, normalizeVersion, VERSION } from "./check.js";

const server = new McpServer({ name: "shipcheck", version: VERSION });

server.tool(
  "check_release",
  "Verify a GitHub release shipped consistently: git tag resolves to a real commit, package.json and the Python metadata (pyproject.toml, setup.cfg, setup.py) at the tag match, server.json matches when present, GitHub release is published, npm has the version and points latest at it (only when the repo has an npm package), PyPI has the version and points latest at it (only for Python projects, skipped when the project is not on PyPI), the MCP Registry lists it as latest, and GHCR has the image tag. Python projects also get soft structure evidence (tests, Dockerfile, README, MCP entry point). Returns a GO or NO-GO report with evidence per surface.",
  {
    repo: z.string().describe("Repo in owner/repo form, e.g. CloudCorpRecords/greenlight"),
    version: z
      .string()
      .optional()
      .describe("Expected version, e.g. 0.15.1. Omit to read it from package.json or the Python metadata on the default branch."),
    npmPackage: z.string().optional().describe("npm package name when it cannot be inferred from package.json at the tag"),
    pypiPackage: z.string().optional().describe("PyPI package name when it cannot be inferred from the Python metadata"),
    serverName: z.string().optional().describe("MCP Registry server name, defaults to io.github.<Owner>/<repo>"),
    require: z
      .array(z.string())
      .optional()
      .describe("Surfaces or groups to force as hard checks: npm, pypi, python, server, registry, ghcr, release, github"),
    skip: z
      .array(z.string())
      .optional()
      .describe("Surfaces or groups to skip: npm, pypi, python, server, registry, ghcr, release, github"),
  },
  async ({ repo, version, npmPackage, pypiPackage, serverName, require, skip }) => {
    const report = await checkRelease(fetch, repo, version, {
      npmPackage,
      pypiPackage,
      serverName,
      require,
      skip,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

server.tool(
  "check_npm",
  "Check one npm package surface: the version is published and dist-tags.latest points at it. Catches staged publishing holds, where a version exists in the publish pipeline but is not actually live.",
  {
    package: z.string().describe("npm package name, e.g. @reneturcios/greenlight"),
    version: z.string().describe("Expected version, e.g. 0.15.1"),
  },
  async ({ package: pkg, version }) => {
    const result = await checkNpm(fetch, pkg, normalizeVersion(version));
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "check_pypi",
  "Check one PyPI package surface: the version is published with files and it is the latest release. A package absent from PyPI reports as skipped, not failed, because many Python projects ship only through GitHub, GHCR or an npm wrapper.",
  {
    package: z.string().describe("PyPI package name, e.g. wallcheck"),
    version: z.string().describe("Expected version, e.g. 0.5.0"),
  },
  async ({ package: pkg, version }) => {
    const result = await checkPypi(fetch, pkg, normalizeVersion(version));
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "check_registry",
  "Check one MCP Registry surface: the server lists the version and marks it as the latest active version. Servers absent from the registry report as skipped, not failed.",
  {
    serverName: z.string().describe("Registry server name, e.g. io.github.CloudCorpRecords/greenlight"),
    version: z.string().describe("Expected version, e.g. 0.15.1"),
  },
  async ({ serverName, version }) => {
    const checks = await checkRegistry(fetch, serverName, normalizeVersion(version));
    return { content: [{ type: "text" as const, text: JSON.stringify(checks, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
