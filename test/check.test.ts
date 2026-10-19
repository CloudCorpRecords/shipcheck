import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkGhcr,
  checkNpm,
  checkRegistry,
  checkRelease,
  computeVerdict,
  normalizeVersion,
  parseRegistryVersions,
  parseRepoRef,
} from "../src/check.js";
import type { FetchFn, FetchResponse } from "../src/types.js";

function jsonRes(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type Route = [string | RegExp, FetchResponse | ((url: string) => FetchResponse)];

function makeFetch(routes: Route[]): FetchFn {
  return async (url: string) => {
    for (const [match, res] of routes) {
      const hit = typeof match === "string" ? url.includes(match) : match.test(url);
      if (hit) return typeof res === "function" ? res(url) : res;
    }
    return jsonRes(404, { message: `no route for ${url}` });
  };
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

describe("helpers", () => {
  it("normalizeVersion strips a leading v only", () => {
    assert.equal(normalizeVersion("v0.15.1"), "0.15.1");
    assert.equal(normalizeVersion("0.15.1"), "0.15.1");
    assert.equal(normalizeVersion("  v1.2.3 "), "1.2.3");
  });

  it("parseRepoRef parses owner/repo and rejects junk", () => {
    assert.deepEqual(parseRepoRef("CloudCorpRecords/greenlight"), {
      owner: "CloudCorpRecords",
      repo: "greenlight",
    });
    assert.throws(() => parseRepoRef("greenlight"));
  });

  it("computeVerdict: hard fail means NO-GO, soft fail does not", () => {
    assert.equal(
      computeVerdict([{ surface: "x", status: "fail", hard: true, detail: "" }]),
      "NO-GO",
    );
    assert.equal(
      computeVerdict([{ surface: "x", status: "fail", hard: false, detail: "" }]),
      "GO",
    );
    assert.equal(
      computeVerdict([{ surface: "x", status: "skip", hard: true, detail: "" }]),
      "GO",
    );
    assert.equal(
      computeVerdict([{ surface: "x", status: "error", hard: true, detail: "" }]),
      "NO-GO",
    );
  });

  it("parseRegistryVersions reads the servers array and the official meta", () => {
    const entries = parseRegistryVersions({
      servers: [
        {
          server: { name: "io.github.Acme/tool", version: "1.0.0" },
          _meta: {
            "io.modelcontextprotocol.registry/official": {
              status: "active",
              isLatest: true,
            },
          },
        },
        {
          server: { name: "io.github.Acme/tool", version: "0.9.0" },
          _meta: {
            "io.modelcontextprotocol.registry/official": {
              status: "active",
              isLatest: false,
            },
          },
        },
      ],
    });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].version, "1.0.0");
    assert.equal(entries[0].isLatest, true);
    assert.equal(entries[1].isLatest, false);
  });
});

describe("checkNpm", () => {
  it("passes when the version exists and latest matches", async () => {
    const fetchFn = makeFetch([
      [
        "registry.npmjs.org",
        jsonRes(200, {
          "dist-tags": { latest: "0.15.1" },
          versions: { "0.15.1": {}, "0.15.0": {} },
        }),
      ],
    ]);
    const r = await checkNpm(fetchFn, "@reneturcios/greenlight", "0.15.1");
    assert.equal(r.exists, true);
    assert.equal(r.checks.find((c) => c.surface === "npm-version")?.status, "pass");
    assert.equal(r.checks.find((c) => c.surface === "npm-latest")?.status, "pass");
  });

  it("fails npm-version when the version is missing (staged hold shape)", async () => {
    const fetchFn = makeFetch([
      [
        "registry.npmjs.org",
        jsonRes(200, {
          "dist-tags": { latest: "0.0.0" },
          versions: { "0.0.0": {} },
        }),
      ],
    ]);
    const r = await checkNpm(fetchFn, "@reneturcios/agentmail", "0.1.0");
    assert.equal(r.checks.find((c) => c.surface === "npm-version")?.status, "fail");
    assert.equal(r.checks.find((c) => c.surface === "npm-latest")?.status, "fail");
  });

  it("fails both checks when the package is not on npm at all", async () => {
    const fetchFn = makeFetch([["registry.npmjs.org", jsonRes(404, {})]]);
    const r = await checkNpm(fetchFn, "@reneturcios/nope", "1.0.0");
    assert.equal(r.exists, false);
    assert.ok(r.checks.every((c) => c.status === "fail"));
  });
});

describe("checkRegistry", () => {
  const registryBody = {
    servers: [
      {
        server: { name: "io.github.CloudCorpRecords/greenlight", version: "0.15.1" },
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            status: "active",
            isLatest: true,
          },
        },
      },
    ],
  };

  it("passes when the version is listed and latest", async () => {
    const fetchFn = makeFetch([["registry.modelcontextprotocol.io", jsonRes(200, registryBody)]]);
    const checks = await checkRegistry(fetchFn, "io.github.CloudCorpRecords/greenlight", "0.15.1");
    assert.equal(checks.find((c) => c.surface === "registry-version")?.status, "pass");
    assert.equal(checks.find((c) => c.surface === "registry-latest")?.status, "pass");
  });

  it("fails when the registry only has an older version", async () => {
    const fetchFn = makeFetch([["registry.modelcontextprotocol.io", jsonRes(200, registryBody)]]);
    const checks = await checkRegistry(fetchFn, "io.github.CloudCorpRecords/greenlight", "0.16.0");
    assert.equal(checks.find((c) => c.surface === "registry-version")?.status, "fail");
    assert.equal(checks.find((c) => c.surface === "registry-latest")?.status, "fail");
  });

  it("skips (does not fail) when the server is absent from the registry", async () => {
    const fetchFn = makeFetch([["registry.modelcontextprotocol.io", jsonRes(404, {})]]);
    const checks = await checkRegistry(fetchFn, "io.github.Acme/notmcp", "1.0.0");
    assert.ok(checks.every((c) => c.status === "skip"));
  });
});

describe("checkGhcr", () => {
  it("passes when version and latest tags exist", async () => {
    const fetchFn = makeFetch([
      ["ghcr.io/token", jsonRes(200, { token: "t" })],
      ["ghcr.io/v2/", jsonRes(200, { tags: ["0.15.0", "0.15.1", "latest"] })],
    ]);
    const checks = await checkGhcr(fetchFn, "ghcr.io/cloudcorprecords/greenlight", "0.15.1");
    assert.equal(checks.find((c) => c.surface === "ghcr-tag")?.status, "pass");
    assert.equal(checks.find((c) => c.surface === "ghcr-latest")?.status, "pass");
  });

  it("skips when the image is not public or does not exist", async () => {
    const fetchFn = makeFetch([["ghcr.io/token", jsonRes(403, {})]]);
    const checks = await checkGhcr(fetchFn, "ghcr.io/acme/nope", "1.0.0");
    assert.ok(checks.every((c) => c.status === "skip"));
  });
});

function githubRoutes(overrides: Route[] = []): Route[] {
  const pkg = b64(JSON.stringify({ name: "@reneturcios/greenlight", version: "0.15.1" }));
  const base: Route[] = [
    [
      "/git/ref/tags/v0.15.1",
      jsonRes(200, { object: { sha: "abc123abc123abc123abc123abc123abc123abcd", type: "commit" } }),
    ],
    ["/git/commits/abc123", jsonRes(200, { sha: "abc123abc123abc123abc123abc123abc123abcd" })],
    ["/contents/package.json", jsonRes(200, { content: pkg, encoding: "base64" })],
    [
      "/releases/tags/v0.15.1",
      jsonRes(200, {
        tag_name: "v0.15.1",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/CloudCorpRecords/greenlight/releases/tag/v0.15.1",
      }),
    ],
    [
      "registry.npmjs.org",
      jsonRes(200, {
        "dist-tags": { latest: "0.15.1" },
        versions: { "0.15.1": {} },
      }),
    ],
    [
      "registry.modelcontextprotocol.io",
      jsonRes(200, {
        servers: [
          {
            server: { name: "io.github.CloudCorpRecords/greenlight", version: "0.15.1" },
            _meta: {
              "io.modelcontextprotocol.registry/official": {
                status: "active",
                isLatest: true,
              },
            },
          },
        ],
      }),
    ],
    ["ghcr.io/token", jsonRes(200, { token: "t" })],
    ["ghcr.io/v2/", jsonRes(200, { tags: ["0.15.1", "latest"] })],
  ];
  return [...overrides, ...base];
}

describe("checkRelease", () => {
  it("GO when every surface agrees", async () => {
    const report = await checkRelease(
      makeFetch(githubRoutes()),
      "CloudCorpRecords/greenlight",
      "0.15.1",
    );
    assert.equal(report.verdict, "GO");
    assert.ok(report.checks.every((c) => c.status === "pass" || !c.hard));
  });

  it("NO-GO when the tag points at a commit that does not exist", async () => {
    const fetchFn = makeFetch(
      githubRoutes([["/git/commits/abc123", jsonRes(404, { message: "Not Found" })]]),
    );
    const report = await checkRelease(fetchFn, "CloudCorpRecords/greenlight", "0.15.1");
    assert.equal(report.verdict, "NO-GO");
    assert.equal(
      report.checks.find((c) => c.surface === "tag-commit")?.status,
      "fail",
    );
  });

  it("NO-GO when npm latest is behind the release", async () => {
    const fetchFn = makeFetch(
      githubRoutes([
        [
          "registry.npmjs.org",
          jsonRes(200, {
            "dist-tags": { latest: "0.15.0" },
            versions: { "0.15.1": {}, "0.15.0": {} },
          }),
        ],
      ]),
    );
    const report = await checkRelease(fetchFn, "CloudCorpRecords/greenlight", "0.15.1");
    assert.equal(report.verdict, "NO-GO");
    assert.equal(report.checks.find((c) => c.surface === "npm-latest")?.status, "fail");
  });

  it("NO-GO when package.json at the tag carries a different version", async () => {
    const wrongPkg = b64(JSON.stringify({ name: "@reneturcios/greenlight", version: "0.15.0" }));
    const fetchFn = makeFetch(
      githubRoutes([["/contents/package.json", jsonRes(200, { content: wrongPkg, encoding: "base64" })]]),
    );
    const report = await checkRelease(fetchFn, "CloudCorpRecords/greenlight", "0.15.1");
    assert.equal(report.verdict, "NO-GO");
    assert.equal(report.checks.find((c) => c.surface === "tag-version")?.status, "fail");
  });

  it("NO-GO when the release is still a draft", async () => {
    const fetchFn = makeFetch(
      githubRoutes([
        [
          "/releases/tags/v0.15.1",
          jsonRes(200, { tag_name: "v0.15.1", draft: true, prerelease: false }),
        ],
      ]),
    );
    const report = await checkRelease(fetchFn, "CloudCorpRecords/greenlight", "0.15.1");
    assert.equal(report.verdict, "NO-GO");
    assert.equal(
      report.checks.find((c) => c.surface === "github-release")?.status,
      "fail",
    );
  });

  it("skip removes a surface group entirely", async () => {
    const report = await checkRelease(
      makeFetch(githubRoutes()),
      "CloudCorpRecords/greenlight",
      "0.15.1",
      { skip: ["ghcr", "registry"] },
    );
    assert.equal(report.verdict, "GO");
    assert.ok(!report.checks.some((c) => c.surface.startsWith("ghcr")));
    assert.ok(!report.checks.some((c) => c.surface.startsWith("registry")));
  });
});
