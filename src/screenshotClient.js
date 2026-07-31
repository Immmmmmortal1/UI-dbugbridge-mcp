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

export class ScreenshotClient {
  constructor(config) {
    this.config = config;
  }

  async getScreenshot() {
    if (!this.config.screenshotCommand) {
      return { success: false, error: "screenshot_command_not_configured" };
    }

    await fs.mkdir(this.config.screenshotOutputDir, { recursive: true });
    const filename = `lookdebug-${Date.now()}.png`;
    const outputPath = path.join(this.config.screenshotOutputDir, filename);
    const command = this.config.screenshotCommand.replaceAll("{output}", outputPath);
    const result = await runCommand("/bin/zsh", ["-lc", command], { cwd: this.config.cwd });

    if (result.code !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || `screenshot_command_failed_${result.code}`,
      };
    }

    return {
      success: true,
      payload: { path: outputPath, stdout: result.stdout.trim() },
      error: null,
    };
  }
}
