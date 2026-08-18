import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// 用 single-quote 包裹并转义内部单引号，防止 outputPath 中的 shell 元字符引发注入
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export class ScreenshotClient {
  constructor(config) {
    this.config = config;
  }

  async getScreenshot() {
    if (!this.config.screenshotCommand) {
      // 未配置截图命令时返回明确的"未配置"错误，不静默使用默认命令
      return {
        success: false,
        error: "screenshot_command_not_configured:请配置 LOOKDEBUG_SCREENSHOT_COMMAND",
      };
    }

    await fs.mkdir(this.config.screenshotOutputDir, { recursive: true });
    const filename = `lookdebug-${Date.now()}.png`;
    const outputPath = path.join(this.config.screenshotOutputDir, filename);
    // {output} 占位符替换后做 shell 转义，防止路径中包含 shell 元字符
    const command = this.config.screenshotCommand.replaceAll(
      "{output}",
      shellQuote(outputPath)
    );
    const result = await runCommand("/bin/zsh", ["-lc", command], { cwd: this.config.cwd });

    if (result.code !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || `screenshot_command_failed_${result.code}`,
      };
    }

    // 命令执行成功但输出文件不存在时返回失败，防止命令静默失败被误认为成功
    try {
      await fs.stat(outputPath);
    } catch (error) {
      return {
        success: false,
        error: `screenshot_output_not_created:${error.code || "unknown"}`,
      };
    }

    return {
      success: true,
      payload: {
        path: outputPath,
        stdout: result.stdout.trim(),
        // 提示命令按配置执行，调用方需自行确认命令来源可信
        warning: "screenshot_command_executed_as_configured",
      },
      error: null,
    };
  }
}
