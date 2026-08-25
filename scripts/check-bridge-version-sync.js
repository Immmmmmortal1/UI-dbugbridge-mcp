import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BRIDGE_REPO = "git@github.com:Immmmmmortal1/LookDebugBridgeService.git";

function readText(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

export function parseMCPVersion(packageText) {
  const packageJSON = JSON.parse(packageText);
  if (typeof packageJSON.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageJSON.version)) {
    throw new Error("invalid_mcp_version");
  }
  return packageJSON.version;
}

export function parsePodspecVersion(podspecText) {
  const match = podspecText.match(/s\.version\s*=\s*["'](\d+\.\d+\.\d+)["']/);
  if (!match) {
    throw new Error("missing_podspec_version");
  }
  return match[1];
}

export function parseREADMEBridgeTags(readmeText) {
  return [...readmeText.matchAll(/LookDebugBridgeService\.git['\"][\s\S]*?:tag\s*=>\s*['\"]([^'\"]+)['\"]/g)]
    .map((match) => match[1]);
}

export function parseLatestStableTag(lsRemoteOutput) {
  const versions = String(lsRemoteOutput)
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/)[1] || "")
    .map((ref) => ref.match(/^refs\/tags\/v?(\d+\.\d+\.\d+)$/)?.[1])
    .filter(Boolean);

  if (versions.length === 0) {
    throw new Error("bridge_repo_has_no_stable_tags");
  }

  return versions.sort((left, right) => {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  })[0];
}

export function readLocalBridgeVersions() {
  return {
    mcpVersion: parseMCPVersion(readText("package.json")),
    podVersion: parsePodspecVersion(readText("LookDebugBridge.podspec")),
    readmeTags: parseREADMEBridgeTags(readText("README.md")),
  };
}

export function readLatestBridgeVersion(repo = DEFAULT_BRIDGE_REPO) {
  const output = execFileSync("git", ["ls-remote", "--tags", "--refs", repo], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
  return parseLatestStableTag(output);
}

export function checkBridgeVersionSync({
  offline = false,
  repo = process.env.LOOKDEBUG_BRIDGE_REPO || DEFAULT_BRIDGE_REPO,
} = {}) {
  const local = readLocalBridgeVersions();
  const failures = [];

  if (local.podVersion !== local.mcpVersion) {
    failures.push(`pod_version_mismatch:mcp=${local.mcpVersion},pod=${local.podVersion}`);
  }

  if (local.readmeTags.length === 0) {
    failures.push("readme_bridge_tag_missing");
  } else if (local.readmeTags.some((tag) => tag !== local.mcpVersion)) {
    failures.push(`readme_bridge_tag_mismatch:expected=${local.mcpVersion},actual=${local.readmeTags.join(",")}`);
  }

  let latestBridgeVersion = null;
  if (!offline) {
    try {
      latestBridgeVersion = readLatestBridgeVersion(repo);
      if (latestBridgeVersion !== local.mcpVersion) {
        failures.push(`latest_bridge_version_mismatch:latest=${latestBridgeVersion},mcp=${local.mcpVersion}`);
      }
    } catch (error) {
      failures.push(`latest_bridge_version_unavailable:${error.message}`);
    }
  }

  return { ...local, latestBridgeVersion, repo, offline, ok: failures.length === 0, failures };
}

function main() {
  const offline = process.argv.includes("--offline");
  const result = checkBridgeVersionSync({ offline });
  console.log(`[bridge-version] MCP=${result.mcpVersion} Pod=${result.podVersion} README=${result.readmeTags.join(",") || "missing"}`);
  if (!offline) {
    console.log(`[bridge-version] latest=${result.latestBridgeVersion || "unknown"} repo=${result.repo}`);
  }
  if (!result.ok) {
    for (const failure of result.failures) {
      console.error(`[bridge-version] FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[bridge-version] OK${offline ? " (offline local consistency)" : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
