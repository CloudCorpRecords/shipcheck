/**
 * shipcheck MCP server. Tools: check_release, check_npm, check_registry.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkNpm, checkRegistry, checkRelease, normalizeVersion, VERSION } from "./check.js";

const server = new McpServer({ name: "shipcheck", version: VERSION });

server.tool(
  "check_release",
  "Verify a GitHub release shipped consistently: git tag resolves to a real commit, package.json at the tag matches, GitHub release is published, npm has the version and points latest at it, the MCP Registry lists it as latest, and GHCR has the image tag. Returns a GO or NO-GO report with evidence per surface.",
  {
    repo: z.string().describe("Repo in owner/repo form, e.g. CloudCorpRecords/greenlight"),
    version: z
      .string()
      .optional()
      .describe("Expected version, e.g. 0.15.1. Omit to read it from package.json on the default branch."),
    npmPackage: z.string().optional().describe("npm package name when it cannot be inferred from package.json at the tag"),
    serverName: z.string().optional().describe("MCP Registry server name, defaults to io.github.<Owner>/<repo>"),
    require: z
      .array(z.string())
      .optional()
      .describe("Surfaces or groups to force as hard checks: npm, registry, ghcr, release, github"),
    skip: z
      .array(z.string())
      .optional()
      .describe("Surfaces or groups to skip: npm, registry, ghcr, release, github"),
  },
  async ({ repo, version, npmPackage, serverName, require, skip }) => {
    const report = await checkRelease(fetch, repo, version, {
      npmPackage,
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
