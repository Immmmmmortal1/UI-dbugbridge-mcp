import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// audit_runtime 输入文件大小上限（20MB），防止读入超大文件耗尽内存
export const MAX_FIGMA_RAW_BYTES = 20 * 1024 * 1024;

const APP_OWNED_TYPES = new Set(["TEXT", "INSTANCE", "COMPONENT", "FRAME", "GROUP"]);
const SYSTEM_NAME_PATTERNS = [
  /status\s*bar/i,
  /statusbar/i,
  /dynamic island/i,
  /signal/i,
  /wifi/i,
  /battery/i,
  /homeindicator/i,
  /home indicator/i,
  /_statusbar/i,
  /trueDepth camera/i,
  /facetime camera/i,
];
const BACKGROUND_NAME_PATTERNS = [/rectangle\s+1183/i, /rectangle\s+1184/i, /background/i, /gradient/i, /9:16/i];
const PLACEHOLDER_TEXT = new Set(["title", "9:41", "time"]);
const DEFAULT_LABEL_ALIASES = {
  share: ["share", "分享", "共有", "공유"],
  save: ["save", "保存", "儲存", "저장"],
  "share and earn": ["share and earn", "分享得金币", "分享得金幣", "シェアでコイン獲得", "공유하고 코인 받기"],
};

export function sanitizeArtifactName(value) {
  return String(value || "artifact")
    .toLowerCase()
    .replace(/[^0-9a-z._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "artifact";
}

// 校验候选路径是否位于根目录内（path.relative 校验，禁 ../ 逃逸）
export function isPathInside(candidatePath, rootPath) {
  const resolved = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// 找到 candidatePath 的最深已存在祖先，返回其 realpath
// 用于校验尚未创建的写路径：realpath(不存在路径) 会抛 ENOENT，无法发现父目录的符号链接逃逸
// 注意：TOCTOU 残余风险在本地 debug 工具可接受，不做 fd 级加固
async function realpathOfDeepestExisting(candidatePath) {
  let current = path.resolve(candidatePath);
  let attempts = 0;
  // 逐级向父目录找第一个存在的路径，防止死循环限制 64 级
  while (attempts < 64) {
    attempts += 1;
    try {
      return await realpath(current);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // 已到根目录仍不存在，理论上不应发生
      return current;
    }
    current = parent;
  }
  return current;
}

// 校验路径位于 artifact root 内，并额外检查符号链接逃逸（realpath 后再次校验）
// 未配置 root 时：allowWrite=true 直接拒绝（默认拒绝写操作），allowWrite=false 保持现状
// 错误消息不泄漏绝对路径，详细路径写 console.error 供调试
export async function assertArtifactPath(inputPath, { root, allowWrite, allowSymlink = false }) {
  if (!inputPath) {
    return inputPath;
  }
  const resolved = path.resolve(inputPath);
  if (!root) {
    if (allowWrite) {
      // 未配置 LOOKDEBUG_ARTIFACT_ROOT 时，对写操作默认拒绝
      throw new Error("artifact_root_not_configured_for_write");
    }
    // 读操作未配置 root 时保持现状（向后兼容）
    return resolved;
  }
  if (!isPathInside(resolved, root)) {
    // 路径逃逸：详细路径写 DEBUG 日志，错误消息用稳定错误码
    console.error("[lookdebug-mcp] artifact_path_outside_root path=%s root=%s", resolved, path.resolve(root));
    throw new Error("artifact_path_outside_root");
  }
  if (!allowSymlink) {
    // 符号链接逃逸检查：root 和 candidate 都做 realpath
    // root 用 realpath 避免系统符号链接（/tmp → /private/tmp）误报
    // candidate 不存在时，找最深已存在祖先做 realpath，发现父目录的符号链接逃逸
    let rootReal;
    try {
      rootReal = await realpath(path.resolve(root));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      rootReal = path.resolve(root);
    }
    try {
      const candidateReal = await realpathOfDeepestExisting(resolved);
      if (!isPathInside(candidateReal, rootReal)) {
        console.error("[lookdebug-mcp] artifact_symlink_escape real=%s root_real=%s", candidateReal, rootReal);
        throw new Error("artifact_symlink_escape");
      }
    } catch (error) {
      if (error.message === "artifact_symlink_escape") {
        throw error;
      }
      // 其他非预期错误（权限等）也不放过，但用稳定错误码
      console.error("[lookdebug-mcp] artifact_realpath_check_failed error=%s path=%s", error.message, resolved);
      throw new Error("artifact_realpath_check_failed");
    }
  }
  return resolved;
}

// 校验输入文件大小不超过上限，防止读入超大文件
export async function assertFileSize(filePath, maxBytes) {
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    // 文件大小不涉及敏感信息，保留在错误消息中便于定位
    throw new Error(`file_too_large:${info.size}>${maxBytes}`);
  }
  return info.size;
}

export function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function writeJSONArtifact(payload, { artifactDir = ".devflow-ui/runtime", artifactPrefix, suffix = "artifact", outPath } = {}) {
  const filePath =
    outPath ||
    path.join(
      artifactDir,
      `${sanitizeArtifactName(artifactPrefix || payload?.pageID || payload?.runtime?.pageID || "lookdebug")}-${timestamp()}-${sanitizeArtifactName(suffix)}.json`
    );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, " ")
    .trim();
}

function compact(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

function isGeneratedRuntimeLabel(element) {
  return compact(element?.label) === compact(element?.id);
}

function hasPattern(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

async function loadFigmaRaw(figmaRawPath) {
  return JSON.parse(await readFile(figmaRawPath, "utf8"));
}

function findFigmaRoot(raw, nodeID) {
  if (raw?.targetFrame && (!nodeID || raw.targetFrame.id === nodeID)) {
    return raw.targetFrame;
  }

  function walk(node) {
    if (!node || typeof node !== "object") {
      return null;
    }
    if (nodeID && node.id === nodeID) {
      return node;
    }
    for (const child of node.children || []) {
      const found = walk(child);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (nodeID) {
    const found = walk(raw);
    if (found) {
      return found;
    }
  }

  if (raw?.nodes) {
    for (const value of Object.values(raw.nodes)) {
      if (value?.document) {
        return value.document;
      }
    }
  }
  if (raw?.document) {
    return raw.document;
  }
  throw new Error("figma_root_not_found");
}

function relBounds(node, root) {
  const bounds = node.absoluteBoundingBox;
  const rootBounds = root.absoluteBoundingBox;
  if (!bounds || !rootBounds) {
    return null;
  }
  return {
    x: Number((Number(bounds.x || 0) - Number(rootBounds.x || 0)).toFixed(2)),
    y: Number((Number(bounds.y || 0) - Number(rootBounds.y || 0)).toFixed(2)),
    w: Number(Number(bounds.width || 0).toFixed(2)),
    h: Number(Number(bounds.height || 0).toFixed(2)),
  };
}

function childText(node) {
  const texts = [];
  function walk(item) {
    if (item?.visible === false) {
      return;
    }
    if (typeof item?.characters === "string" && item.characters.trim()) {
      texts.push(item.characters.trim());
    }
    for (const child of item?.children || []) {
      walk(child);
    }
  }
  walk(node);
  return texts.join(" ");
}

function classifyFigmaNode(node, ancestors) {
  const names = [...ancestors, node].map((item) => String(item?.name || "")).join(" ");
  const text = String(node.characters || "");
  if (hasPattern(names, SYSTEM_NAME_PATTERNS)) {
    return "system";
  }
  if (PLACEHOLDER_TEXT.has(compact(text))) {
    return "placeholder";
  }
  if (hasPattern(names, BACKGROUND_NAME_PATTERNS)) {
    return "background";
  }
  return "app";
}

function roleFor(node) {
  const nodeType = String(node.type || "");
  const name = String(node.name || "");
  const text = String(node.characters || "");
  if (nodeType === "TEXT") {
    return "label";
  }
  if (/button/i.test(name)) {
    return "button";
  }
  if (/px\/|icon|coin|left|back|save|share|help/i.test(name)) {
    return "icon";
  }
  if (text) {
    return "label";
  }
  return "view";
}

function semanticKey(pageID, node, role, text) {
  const basis = text || String(node.name || "") || String(node.id || "node");
  let key = compact(basis) || compact(String(node.id || "node"));
  if (key.length > 36) {
    key = key.slice(0, 36);
  }
  return `${pageID}.${role}.${key}`;
}

function dedupeFigmaElements(elements) {
  const result = [];
  const seen = new Set();
  for (const item of elements) {
    let key = `${item.role}:${compact(item.text)}:${compact(item.name)}`;
    if (item.role === "label" && compact(item.text)) {
      key = `${item.role}:${compact(item.text)}`;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function extractFigmaElements(root, pageID) {
  const elements = [];
  const excluded = [];
  const counts = { app: 0, system: 0, background: 0, placeholder: 0, hidden: 0, no_render: 0 };

  function walk(node, ancestors, ancestorVisible) {
    const currentVisible = ancestorVisible && node.visible !== false;
    const hasRender = Boolean(node.absoluteRenderBounds);
    const nodeID = String(node.id || "");
    const name = String(node.name || "");

    if (!currentVisible) {
      counts.hidden += 1;
      excluded.push({ node_id: nodeID, name, reason: "visible=false on node or ancestor" });
    } else if (!hasRender && APP_OWNED_TYPES.has(node.type)) {
      counts.no_render += 1;
      excluded.push({ node_id: nodeID, name, reason: "no absoluteRenderBounds" });
    } else if (APP_OWNED_TYPES.has(node.type)) {
      const classification = classifyFigmaNode(node, ancestors);
      counts[classification] += 1;
      if (classification === "app") {
        const role = roleFor(node);
        const text = String(node.characters || childText(node)).trim();
        if (role === "view") {
          excluded.push({ node_id: nodeID, name, reason: "generic container/decorative node" });
        } else {
          elements.push({
            semantic_key: semanticKey(pageID, node, role, text),
            node_id: nodeID,
            name,
            node_type: String(node.type || ""),
            role,
            text,
            rel: relBounds(node, root),
            match_hint: norm(`${name} ${text}`),
          });
        }
      }
    }

    for (const child of node.children || []) {
      walk(child, [...ancestors, node], currentVisible);
    }
  }

  walk(root, [], true);
  return { elements: dedupeFigmaElements(elements), counts, excluded };
}

function mergedAliases(labelAliases = {}) {
  const aliases = { ...DEFAULT_LABEL_ALIASES };
  for (const [key, values] of Object.entries(labelAliases || {})) {
    aliases[norm(key)] = Array.isArray(values) ? values.map(String) : [String(values)];
  }
  return aliases;
}

function expectedTerms(element, aliases) {
  const terms = new Set([norm(element.text), compact(element.text), norm(element.name), compact(element.name)]);
  for (const [key, values] of Object.entries(aliases)) {
    const candidates = new Set([norm(key), compact(key)]);
    if (candidates.has(norm(element.text)) || candidates.has(compact(element.text))) {
      for (const value of values) {
        terms.add(norm(value));
        terms.add(compact(value));
      }
    }
  }
  for (const part of norm(`${element.name} ${element.text}`).split(" ")) {
    if (part.length >= 3) {
      terms.add(part);
    }
  }
  return [...terms].filter(Boolean);
}

function runtimeTerms(element) {
  const terms = new Set();
  for (const value of [element.id, element.label, element.type]) {
    terms.add(norm(value));
    terms.add(compact(value));
    for (const part of norm(value).split(" ")) {
      if (part.length >= 3) {
        terms.add(part);
      }
    }
  }
  return [...terms].filter(Boolean);
}

function compatibleRole(figma, runtime) {
  if (figma.role === "button") {
    return runtime.type === "button";
  }
  if (figma.role === "label") {
    return ["label", "button"].includes(runtime.type) && !isGeneratedRuntimeLabel(runtime);
  }
  if (figma.role === "icon") {
    return ["view", "button"].includes(runtime.type);
  }
  return true;
}

function scoreMatch(figma, runtime, aliases) {
  if (!compatibleRole(figma, runtime)) {
    return { score: 0, method: "incompatible-type" };
  }

  const labelNorm = norm(runtime.label);
  const labelCompact = compact(runtime.label);
  const figmaTextNorm = norm(figma.text);
  const figmaTextCompact = compact(figma.text);

  if (figma.text && !isGeneratedRuntimeLabel(runtime)) {
    const textAliases = new Set([figmaTextNorm, figmaTextCompact]);
    for (const [key, values] of Object.entries(aliases)) {
      if ([norm(key), compact(key)].includes(figmaTextNorm) || [norm(key), compact(key)].includes(figmaTextCompact)) {
        for (const value of values) {
          textAliases.add(norm(value));
          textAliases.add(compact(value));
        }
      }
    }
    if (textAliases.has(labelNorm) || textAliases.has(labelCompact)) {
      return { score: 100, method: `label:${runtime.label}` };
    }
  }

  const fTerms = new Set(expectedTerms(figma, aliases));
  const overlap = runtimeTerms(runtime).filter((term) => fTerms.has(term));
  if (overlap.length > 0) {
    const best = overlap.sort((a, b) => b.length - a.length)[0];
    if (compact(figma.text) && [compact(figma.text), norm(figma.text)].includes(best)) {
      return { score: 95, method: `label:${best}` };
    }
    return { score: 65, method: `token:${best}` };
  }

  const hint = compact(figma.match_hint);
  const id = compact(runtime.id);
  if (hint.includes("coin") && id.includes("coin")) {
    return { score: 85, method: "id-token:coin" };
  }
  if (hint.includes("save") && id.includes("save")) {
    return { score: runtime.type === "button" ? 90 : 85, method: "id-token:save" };
  }
  if (hint.includes("share") && id.includes("share")) {
    return { score: runtime.type === "button" ? 90 : 85, method: "id-token:share" };
  }
  if (hint.includes("left") && id.includes("back")) {
    return { score: 80, method: "id-token:back" };
  }
  return { score: 0, method: "none" };
}

function auditElements(figmaElements, runtimeElements, aliases) {
  const comparison = [];
  const matchedRuntimeIDs = new Set();

  for (const figma of figmaElements) {
    const scored = runtimeElements
      .map((runtime) => ({ runtime, ...scoreMatch(figma, runtime, aliases) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    let runtime = null;
    let status = "needs_mapping";
    if (best?.score >= 70) {
      runtime = best.runtime;
      status = "present";
      matchedRuntimeIDs.add(runtime.id);
    } else if (best?.score >= 40) {
      runtime = best.runtime;
    }
    comparison.push({
      semantic_key: figma.semantic_key,
      figma_node_id: figma.node_id,
      figma_name: figma.name,
      figma_role: figma.role,
      figma_text: figma.text,
      figma_rel: figma.rel,
      runtime,
      match_method: best?.method || "none",
      match_score: best?.score || 0,
      status,
    });
  }

  const extra = runtimeElements.filter((runtime) => {
    if (matchedRuntimeIDs.has(runtime.id)) {
      return false;
    }
    const labelIsGenerated = isGeneratedRuntimeLabel(runtime);
    return ["button", "label"].includes(runtime.type) && !labelIsGenerated;
  });
  return { comparison, extra };
}

function markdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMarkdown(report) {
  const lines = [
    "# Runtime Semantic Audit",
    "",
    `- figma: ${report.inputs.figmaRawPath}`,
    `- pageID: ${report.runtime.pageID}`,
    `- expected elements: ${report.summary.expected}`,
    `- present: ${report.summary.present}`,
    `- needs_mapping: ${report.summary.needs_mapping}`,
    `- extra candidates: ${report.summary.extra_candidates}`,
    "",
    "## Comparison",
    "",
    "| semantic key | Figma node | role | text | runtime id | runtime type | runtime label | method | status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const row of report.comparison) {
    lines.push(
      `| ${[
        row.semantic_key,
        row.figma_node_id,
        row.figma_role,
        row.figma_text,
        row.runtime?.id,
        row.runtime?.type,
        row.runtime?.label,
        row.match_method,
        row.status,
      ].map(markdownCell).join(" | ")} |`
    );
  }

  if (report.extra_runtime_candidates.length > 0) {
    lines.push("", "## Extra Runtime Candidates", "");
    for (const item of report.extra_runtime_candidates) {
      lines.push(`- \`${item.id}\` ${item.type} label=${JSON.stringify(item.label)}`);
    }
  }

  if (report.excluded_figma_nodes.length > 0) {
    lines.push("", "## Excluded Figma Nodes", "");
    for (const item of report.excluded_figma_nodes.slice(0, 80)) {
      lines.push(`- \`${item.node_id}\` ${item.name}: ${item.reason}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function buildRuntimeAuditReport({
  figmaRawPath,
  figmaNodeID,
  page,
  expectedPageID,
  labelAliases,
} = {}) {
  if (!figmaRawPath) {
    throw new Error("figmaRawPath_required");
  }
  if (!page) {
    throw new Error("page_required");
  }
  const pageID = expectedPageID || page.pageID || "page";
  const raw = await loadFigmaRaw(figmaRawPath);
  const root = findFigmaRoot(raw, figmaNodeID);
  const { elements, counts, excluded } = extractFigmaElements(root, pageID);
  const runtimeElements = Array.isArray(page.elements)
    ? page.elements
        .filter((item) => item?.id)
        .map((item) => ({
          id: String(item.id || ""),
          type: String(item.type || ""),
          label: String(item.label || ""),
          enabled: item.enabled,
        }))
    : [];
  const { comparison, extra } = auditElements(elements, runtimeElements, mergedAliases(labelAliases));
  const summary = {
    expected: comparison.length,
    present: comparison.filter((item) => item.status === "present").length,
    needs_mapping: comparison.filter((item) => item.status === "needs_mapping").length,
    extra_candidates: extra.length,
  };
  return {
    tool: "audit_runtime",
    version: 1,
    inputs: { figmaRawPath, figmaNodeID, expectedPageID: expectedPageID || null },
    runtime: { pageID: page.pageID, title: page.title, element_count: runtimeElements.length },
    figma: { root_id: root.id, root_name: root.name, visible_counts: counts },
    summary,
    comparison,
    extra_runtime_candidates: extra,
    excluded_figma_nodes: excluded,
  };
}

export async function writeRuntimeAuditArtifacts(
  report,
  { artifactDir = ".devflow-ui/runtime", artifactPrefix, outJsonPath, outMarkdownPath } = {}
) {
  const prefix = artifactPrefix || `${report.runtime.pageID || "page"}-runtime-audit`;
  const jsonPath =
    outJsonPath || path.join(artifactDir, `${sanitizeArtifactName(prefix)}-${timestamp()}.json`);
  const markdownPath =
    outMarkdownPath || path.join(artifactDir, `${sanitizeArtifactName(prefix)}-${timestamp()}.md`);
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}
