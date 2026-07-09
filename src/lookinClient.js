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

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

function shellCommand(command) {
  return ["/bin/zsh", ["-lc", command]];
}

export class LookinClient {
  constructor(config) {
    this.config = config;
  }

  async ping() {
    const result = await this.#runLookin(["--ping", "--no-color"]);
    return {
      success: result.code === 0,
      payload: result.code === 0 ? result.stdout.trim() : null,
      error: result.code === 0 ? null : result.stderr.trim() || `lookin_ping_failed_${result.code}`,
    };
  }

  async getUIHierarchy(options = {}) {
    const args = [`--host=${this.config.lookinHost}`];
    if (options.color !== true) {
      args.push("--no-color");
    }
    if (options.json) {
      args.push("--json");
    }
    if (options.depth !== undefined) {
      args.push(`--depth=${options.depth}`);
    }
    if (options.filter) {
      args.push(`--filter=${options.filter}`);
    }
    if (options.raw) {
      args.push("--raw");
    }

    const result = await this.#runLookin(args);
    if (result.code !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || `lookin_cli_failed_${result.code}`,
      };
    }

    if (!options.json) {
      return {
        success: true,
        payload: {
          text: result.stdout,
        },
      };
    }

    return this.#parseJSONOutput(result.stdout);
  }

  async #runLookin(args) {
    const resolvedArgs = [...args];
    if (this.config.lookinMode === "device") {
      resolvedArgs.push("--device");
    }

    return runCommand(this.config.lookinCliPath, resolvedArgs, {
      cwd: this.config.cwd,
    });
  }

  #parseJSONOutput(stdout) {
    try {
      return {
        success: true,
        payload: JSON.parse(stdout),
      };
    } catch (error) {
      return {
        success: false,
        error: `invalid_lookin_json: ${error.message}`,
        raw: stdout,
      };
    }
  }

  async getScreenshot() {
    if (!this.config.screenshotCommand) {
      return {
        success: false,
        error: "screenshot_command_not_configured",
      };
    }

    await fs.mkdir(this.config.screenshotOutputDir, { recursive: true });
    const filename = `lookdebug-${Date.now()}.png`;
    const outputPath = path.join(this.config.screenshotOutputDir, filename);
    const command = this.config.screenshotCommand.replaceAll("{output}", outputPath);
    const [shell, args] = shellCommand(command);
    const result = await runCommand(shell, args, { cwd: this.config.cwd });

    if (result.code !== 0) {
      return {
        success: false,
        error: result.stderr.trim() || `screenshot_command_failed_${result.code}`,
      };
    }

    return {
      success: true,
      payload: {
        path: outputPath,
        stdout: result.stdout.trim(),
      },
    };
  }
}
