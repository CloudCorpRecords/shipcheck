/**
 * shipcheck core: verify every public surface of a release agrees on one version.
 *
 * All network access goes through an injectable FetchFn so the whole logic is
 * testable with fixtures. Every check reports expected vs actual plus the
 * source URL. A failed fetch is an "error" check with the HTTP status, never
 * a guessed pass or fail.
 */
import type { CheckOptions, FetchFn, ShipReport, SurfaceCheck } from "./types.js";

export const VERSION = "0.1.0";

const GH_API = "https://api.github.com";
const NPM_API = "https://registry.npmjs.org";
const REGISTRY_API = "https://registry.modelcontextprotocol.io";

export const SURFACE_GROUPS: Record<string, string[]> = {
  github: ["git-tag", "tag-commit", "tag-version", "github-release"],
  release: ["github-release"],
  npm: ["npm-version", "npm-latest"],
  registry: ["registry-version", "registry-latest"],
  ghcr: ["ghcr-tag", "ghcr-latest"],
};

export function expandSurfaces(names: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const n of names ?? []) {
    const key = n.trim().toLowerCase();
    if (!key) continue;
    if (SURFACE_GROUPS[key]) for (const s of SURFACE_GROUPS[key]) out.add(s);
    else out.add(key);
  }
  return out;
}

export function parseRepoRef(ref: string): { owner: string; repo: string } {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(ref.trim().replace(/\.git$/, ""));
  if (!m) throw new Error(`Expected owner/repo, got: ${ref}`);
  return { owner: m[1], repo: m[2] };
}

export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/, "");
}

export function computeVerdict(checks: SurfaceCheck[]): "GO" | "NO-GO" {
  return checks.some((c) => c.hard && (c.status === "fail" || c.status === "error"))
    ? "NO-GO"
    : "GO";
}

function ghHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": `shipcheck/${VERSION}`,
    Accept: "application/vnd.github+json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

interface GhJson {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

async function ghJson(
  fetchFn: FetchFn,
  path: string,
  token?: string,
): Promise<GhJson> {
  const res = await fetchFn(`${GH_API}${path}`, { headers: ghHeaders(token) });
  if (!res.ok) return { ok: false, status: res.status, data: null };
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: true, status: res.status, data };
}

function decodeContent(data: Record<string, unknown>): string | null {
  const content = data.content;
  if (typeof content !== "string") return null;
  try {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Read package.json (name + version) from the repo at a ref. Null when absent. */
export async function fetchPackageJson(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  ref: string,
  token?: string,
): Promise<{ name?: string; version?: string } | null> {
  const r = await ghJson(
    fetchFn,
    `/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(ref)}`,
    token,
  );
  if (!r.ok || !r.data) return null;
  const raw = decodeContent(r.data);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return { name: parsed.name, version: parsed.version };
  } catch {
    return null;
  }
}

/** Resolve the expected version from package.json on the default branch. */
export async function resolveVersionFromRepo(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  token?: string,
): Promise<string> {
  const repoInfo = await ghJson(fetchFn, `/repos/${owner}/${repo}`, token);
  const branch =
    (repoInfo.data?.default_branch as string | undefined) ?? "main";
  const pkg = await fetchPackageJson(fetchFn, owner, repo, branch, token);
  if (!pkg?.version) {
    throw new Error(
      `Could not read a version from package.json on ${owner}/${repo}@${branch}. Pass a version explicitly.`,
    );
  }
  return normalizeVersion(pkg.version);
}

async function checkGitHub(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  version: string,
  skip: Set<string>,
  token?: string,
): Promise<{ checks: SurfaceCheck[]; npmName?: string }> {
  const checks: SurfaceCheck[] = [];
  const tag = `v${version}`;
  const repoPath = `/repos/${owner}/${repo}`;

  // git-tag + tag-commit: the tag must exist and resolve to a real commit.
  // This is the check that would have caught a tag pointing at a
  // nonexistent object: the ref can exist while its target does not.
  let commitSha: string | undefined;
  if (!skip.has("git-tag")) {
    const refRes = await ghJson(fetchFn, `${repoPath}/git/ref/tags/${tag}`, token);
    if (!refRes.ok || !refRes.data) {
      checks.push({
        surface: "git-tag",
        status: refRes.status === 404 ? "fail" : "error",
        hard: true,
        expected: tag,
        detail:
          refRes.status === 404
            ? `No git tag ${tag} on ${owner}/${repo}`
            : `GitHub API returned ${refRes.status} for the tag ref`,
        source: `https://github.com/${owner}/${repo}/tags`,
      });
    } else {
      const obj = refRes.data.object as { sha?: string; type?: string } | undefined;
      checks.push({
        surface: "git-tag",
        status: "pass",
        hard: true,
        expected: tag,
        actual: obj?.sha,
        detail: `Tag ${tag} exists (object type ${obj?.type ?? "unknown"})`,
        source: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
      });
      if (obj?.sha && obj.type === "commit") {
        commitSha = obj.sha;
      } else if (obj?.sha && obj.type === "tag") {
        const tagObj = await ghJson(fetchFn, `${repoPath}/git/tags/${obj.sha}`, token);
        const inner = tagObj.data?.object as { sha?: string } | undefined;
        if (tagObj.ok && inner?.sha) commitSha = inner.sha;
      }
      if (!skip.has("tag-commit")) {
        if (!commitSha) {
          checks.push({
            surface: "tag-commit",
            status: "fail",
            hard: true,
            expected: "a commit object",
            detail: `Tag ${tag} does not resolve to a commit object`,
          });
        } else {
          const commit = await ghJson(fetchFn, `${repoPath}/git/commits/${commitSha}`, token);
          checks.push({
            surface: "tag-commit",
            status: commit.ok ? "pass" : "fail",
            hard: true,
            expected: "a real commit",
            actual: commitSha,
            detail: commit.ok
              ? `Tag resolves to real commit ${commitSha.slice(0, 12)}`
              : `Tag target ${commitSha.slice(0, 12)} is not a real commit (GitHub API ${commit.status})`,
            source: `https://github.com/${owner}/${repo}/commit/${commitSha}`,
          });
        }
      }
    }
  }

  // tag-version: package.json at the tag must carry the expected version.
  let npmName: string | undefined;
  const pkgAtTag = await fetchPackageJson(fetchFn, owner, repo, tag, token);
  if (pkgAtTag?.name) npmName = pkgAtTag.name;
  if (!skip.has("tag-version")) {
    if (!pkgAtTag) {
      checks.push({
        surface: "tag-version",
        status: "skip",
        hard: true,
        detail: `No readable package.json at ${tag}, nothing to compare`,
      });
    } else {
      const actual = pkgAtTag.version ? normalizeVersion(pkgAtTag.version) : undefined;
      checks.push({
        surface: "tag-version",
        status: actual === version ? "pass" : "fail",
        hard: true,
        expected: version,
        actual,
        detail:
          actual === version
            ? `package.json at ${tag} is version ${version}`
            : `package.json at ${tag} is version ${actual ?? "unknown"}, expected ${version}`,
        source: `https://github.com/${owner}/${repo}/blob/${tag}/package.json`,
      });
    }
  }

  // github-release
  if (!skip.has("github-release")) {
    const rel = await ghJson(fetchFn, `${repoPath}/releases/tags/${tag}`, token);
    if (!rel.ok || !rel.data) {
      checks.push({
        surface: "github-release",
        status: rel.status === 404 ? "fail" : "error",
        hard: true,
        expected: `release ${tag}`,
        detail:
          rel.status === 404
            ? `No GitHub release for ${tag}`
            : `GitHub API returned ${rel.status} for the release lookup`,
        source: `https://github.com/${owner}/${repo}/releases`,
      });
    } else if (rel.data.draft === true) {
      checks.push({
        surface: "github-release",
        status: "fail",
        hard: true,
        expected: `published release ${tag}`,
        actual: "draft",
        detail: `Release ${tag} exists but is still a draft`,
        source: (rel.data.html_url as string) ?? undefined,
      });
    } else {
      checks.push({
        surface: "github-release",
        status: "pass",
        hard: true,
        expected: `release ${tag}`,
        actual: rel.data.prerelease === true ? `${tag} (prerelease)` : tag,
        detail: `GitHub release ${tag} is published`,
        source: (rel.data.html_url as string) ?? undefined,
      });
    }
  }

  return { checks, npmName };
}

export interface NpmSurface {
  checks: SurfaceCheck[];
  latest?: string;
  exists: boolean;
}

export async function checkNpm(
  fetchFn: FetchFn,
  pkg: string,
  version: string,
): Promise<NpmSurface> {
  const url = `${NPM_API}/${pkg.replace("/", "%2F")}`;
  const res = await fetchFn(url, { headers: { "User-Agent": `shipcheck/${VERSION}` } });
  if (!res.ok) {
    const status: SurfaceCheck["status"] = res.status === 404 ? "fail" : "error";
    return {
      exists: false,
      checks: [
        {
          surface: "npm-version",
          status,
          hard: true,
          expected: `${pkg}@${version}`,
          detail:
            res.status === 404
              ? `Package ${pkg} is not on npm`
              : `npm registry returned ${res.status}`,
          source: `https://www.npmjs.com/package/${pkg}`,
        },
        {
          surface: "npm-latest",
          status,
          hard: true,
          expected: version,
          detail: "Cannot check latest without the package document",
        },
      ],
    };
  }
  const data = (await res.json().catch(() => null)) as {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, unknown>;
  } | null;
  const latest = data?.["dist-tags"]?.latest;
  const hasVersion = Boolean(data?.versions && version in data.versions);
  return {
    exists: true,
    latest,
    checks: [
      {
        surface: "npm-version",
        status: hasVersion ? "pass" : "fail",
        hard: true,
        expected: `${pkg}@${version}`,
        actual: hasVersion ? `${pkg}@${version}` : undefined,
        detail: hasVersion
          ? `${pkg}@${version} is published on npm`
          : `${pkg}@${version} is not published on npm (a staged hold looks exactly like this)`,
        source: `https://www.npmjs.com/package/${pkg}/v/${version}`,
      },
      {
        surface: "npm-latest",
        status: latest === version ? "pass" : "fail",
        hard: true,
        expected: version,
        actual: latest,
        detail:
          latest === version
            ? `npm latest points at ${version}`
            : `npm latest is ${latest ?? "unknown"}, expected ${version}`,
        source: `https://www.npmjs.com/package/${pkg}`,
      },
    ],
  };
}

interface RegistryEntry {
  version?: string;
  isLatest?: boolean;
  status?: string;
}

export function parseRegistryVersions(data: unknown): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const push = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") return;
    const e = raw as Record<string, unknown>;
    const server = (e.server ?? e) as Record<string, unknown>;
    const meta = (e._meta ?? {}) as Record<string, unknown>;
    const official = (meta["io.modelcontextprotocol.registry/official"] ?? {}) as Record<
      string,
      unknown
    >;
    entries.push({
      version: typeof server.version === "string" ? server.version : undefined,
      isLatest: official.isLatest === true,
      status: typeof official.status === "string" ? official.status : undefined,
    });
  };
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.servers)) for (const s of d.servers) push(s);
    else if (d.server || d.version) push(d);
  }
  return entries;
}

export async function checkRegistry(
  fetchFn: FetchFn,
  serverName: string,
  version: string,
): Promise<SurfaceCheck[]> {
  const source = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(serverName)}/versions`;
  let res = await fetchFn(source, { headers: { "User-Agent": `shipcheck/${VERSION}` } });
  let data: unknown = res.ok ? await res.json().catch(() => null) : null;
  if (!res.ok || !data) {
    // Fallback: search by the trailing name segment and filter exactly.
    const tail = serverName.split("/").pop() ?? serverName;
    const searchUrl = `${REGISTRY_API}/v0.1/servers?search=${encodeURIComponent(tail)}`;
    const sres = await fetchFn(searchUrl, { headers: { "User-Agent": `shipcheck/${VERSION}` } });
    if (sres.ok) {
      const sdata = (await sres.json().catch(() => null)) as Record<string, unknown> | null;
      const servers = Array.isArray(sdata?.servers) ? sdata.servers : [];
      const mine = servers.filter((s) => {
        const srv = (s as Record<string, unknown>).server as Record<string, unknown> | undefined;
        return srv?.name === serverName;
      });
      if (mine.length > 0) data = { servers: mine };
    }
  }
  const entries = parseRegistryVersions(data);
  if (entries.length === 0) {
    return [
      {
        surface: "registry-version",
        status: "skip",
        hard: true,
        detail: `Server ${serverName} is not in the MCP Registry, registry checks do not apply`,
        source,
      },
      {
        surface: "registry-latest",
        status: "skip",
        hard: true,
        detail: "No registry entry to check latest against",
      },
    ];
  }
  const match = entries.find((e) => e.version && normalizeVersion(e.version) === version);
  const latestEntry = entries.find((e) => e.isLatest);
  return [
    {
      surface: "registry-version",
      status: match ? "pass" : "fail",
      hard: true,
      expected: version,
      actual: entries.map((e) => e.version).filter(Boolean).join(", "),
      detail: match
        ? `MCP Registry lists ${serverName} ${version} (status ${match.status ?? "unknown"})`
        : `MCP Registry does not list ${serverName} ${version}`,
      source,
    },
    {
      surface: "registry-latest",
      status:
        latestEntry?.version && normalizeVersion(latestEntry.version) === version
          ? "pass"
          : "fail",
      hard: true,
      expected: version,
      actual: latestEntry?.version,
      detail:
        latestEntry?.version && normalizeVersion(latestEntry.version) === version
          ? `MCP Registry latest is ${version} and active`
          : `MCP Registry latest is ${latestEntry?.version ?? "unknown"}, expected ${version}. Registry publish must run after npm verifies.`,
      source,
    },
  ];
}

export async function checkGhcr(
  fetchFn: FetchFn,
  image: string,
  version: string,
): Promise<SurfaceCheck[]> {
  // image: ghcr.io/owner/repo
  const path = image.replace(/^ghcr\.io\//, "");
  const source = `https://github.com/${path.split("/")[0]}/packages/container/package/${path.split("/").slice(1).join("%2F")}`;
  const tokenRes = await fetchFn(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${path}:pull`,
    { headers: { "User-Agent": `shipcheck/${VERSION}` } },
  );
  if (!tokenRes.ok) {
    return [
      {
        surface: "ghcr-tag",
        status: "skip",
        hard: false,
        detail: `No public GHCR image at ${image} (token request returned ${tokenRes.status}), GHCR checks do not apply`,
        source,
      },
      { surface: "ghcr-latest", status: "skip", hard: false, detail: "No GHCR image to check" },
    ];
  }
  const tokenData = (await tokenRes.json().catch(() => null)) as { token?: string } | null;
  const tagsRes = await fetchFn(`https://ghcr.io/v2/${path}/tags/list`, {
    headers: {
      "User-Agent": `shipcheck/${VERSION}`,
      ...(tokenData?.token ? { Authorization: `Bearer ${tokenData.token}` } : {}),
      Accept: "application/json",
    },
  });
  if (!tagsRes.ok) {
    return [
      {
        surface: "ghcr-tag",
        status: "skip",
        hard: false,
        detail: `GHCR tags lookup returned ${tagsRes.status} for ${image}, treating GHCR as not applicable`,
        source,
      },
      { surface: "ghcr-latest", status: "skip", hard: false, detail: "No GHCR tags to check" },
    ];
  }
  const tagsData = (await tagsRes.json().catch(() => null)) as { tags?: string[] } | null;
  const tags = tagsData?.tags ?? [];
  return [
    {
      surface: "ghcr-tag",
      status: tags.includes(version) ? "pass" : "fail",
      hard: false,
      expected: `${image}:${version}`,
      actual: tags.slice(0, 20).join(", "),
      detail: tags.includes(version)
        ? `GHCR image has tag ${version}`
        : `GHCR image has no tag ${version}`,
      source,
    },
    {
      surface: "ghcr-latest",
      status: tags.includes("latest") ? "pass" : "fail",
      hard: false,
      expected: `${image}:latest`,
      detail: tags.includes("latest")
        ? "GHCR image has a latest tag"
        : "GHCR image has no latest tag",
      source,
    },
  ];
}

/** Full check across every surface. */
export async function checkRelease(
  fetchFn: FetchFn,
  repoRef: string,
  versionInput: string | undefined,
  opts: CheckOptions = {},
): Promise<ShipReport> {
  const { owner, repo } = parseRepoRef(repoRef);
  const token = opts.githubToken ?? process.env.GITHUB_TOKEN;
  const skip = expandSurfaces(opts.skip);
  const requireSet = expandSurfaces(opts.require);

  const version = versionInput
    ? normalizeVersion(versionInput)
    : await resolveVersionFromRepo(fetchFn, owner, repo, token);

  const gh = await checkGitHub(fetchFn, owner, repo, version, skip, token);
  const checks: SurfaceCheck[] = [...gh.checks];

  const npmPkg = opts.npmPackage ?? gh.npmName ?? `@reneturcios/${repo}`;
  if (!skip.has("npm-version") || !skip.has("npm-latest")) {
    const npm = await checkNpm(fetchFn, npmPkg, version);
    for (const c of npm.checks) if (!skip.has(c.surface)) checks.push(c);
  }

  const serverName = opts.serverName ?? `io.github.${owner}/${repo}`;
  if (!skip.has("registry-version") || !skip.has("registry-latest")) {
    const reg = await checkRegistry(fetchFn, serverName, version);
    for (const c of reg) if (!skip.has(c.surface)) checks.push(c);
  }

  const ghcrImage = opts.ghcrImage ?? `ghcr.io/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  if (!skip.has("ghcr-tag") || !skip.has("ghcr-latest")) {
    const ghcr = await checkGhcr(fetchFn, ghcrImage, version);
    for (const c of ghcr) if (!skip.has(c.surface)) checks.push(c);
  }

  if (requireSet.size > 0) {
    for (const c of checks) if (requireSet.has(c.surface)) c.hard = true;
  }

  // Stable surface order for readable output.
  const order = [
    "git-tag",
    "tag-commit",
    "tag-version",
    "github-release",
    "npm-version",
    "npm-latest",
    "registry-version",
    "registry-latest",
    "ghcr-tag",
    "ghcr-latest",
  ];
  checks.sort((a, b) => order.indexOf(a.surface) - order.indexOf(b.surface));

  return {
    repo: `${owner}/${repo}`,
    version,
    verdict: computeVerdict(checks),
    checks,
    checkedAt: new Date().toISOString(),
  };
}

export function renderReport(report: ShipReport): string {
  const lines: string[] = [];
  lines.push(`shipcheck ${report.repo} v${report.version}: ${report.verdict}`);
  for (const c of report.checks) {
    const mark =
      c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : c.status === "error" ? "ERROR" : "SKIP";
    lines.push(`  [${mark}] ${c.surface}: ${c.detail}`);
  }
  const hardFails = report.checks.filter(
    (c) => c.hard && (c.status === "fail" || c.status === "error"),
  );
  if (report.verdict === "GO") {
    lines.push("GO: every hard surface agrees on this version.");
  } else {
    lines.push(
      `NO-GO: ${hardFails.length} hard surface(s) disagree: ${hardFails.map((c) => c.surface).join(", ")}`,
    );
  }
  return lines.join("\n");
}
