function joinURL(baseURL, pathname) {
  return new URL(pathname, baseURL).toString();
}

function withQuery(pathname, values) {
  const url = new URL(pathname, "http://lookdebug.invalid");
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

async function decodeJSON(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

export class HTTPBridgeClient {
  constructor({ baseURL, fetchImpl = fetch, timeoutMs = 3000 }) {
    this.baseURL = baseURL;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  setBaseURL(baseURL) {
    this.baseURL = baseURL;
  }

  async getPage() {
    return this.#request("GET", "/debug/page");
  }

  async tapElement(id) {
    return this.#request("POST", "/debug/tap", { id });
  }

  async setSwitch(id, isOn) {
    return this.#request("POST", "/debug/switch", { id, isOn });
  }

  async setText(id, text) {
    return this.#request("POST", "/debug/text/set", { id, text });
  }

  async typeText(id, text) {
    return this.#request("POST", "/debug/text/type", { id, text });
  }

  async getRuntimeNode(anchor) {
    return this.#request("POST", "/debug/runtime/node", { anchor });
  }

  async getWindowTree({ depth, includeHidden = false, maxNodes } = {}) {
    return this.#request(
      "GET",
      withQuery("/debug/windows", { depth, include_hidden: includeHidden, max_nodes: maxNodes })
    );
  }

  async readLogs({ query, level, category, limit, waitMs } = {}) {
    return this.#request(
      "GET",
      withQuery("/debug/logs", { query, level, category, limit, wait_ms: waitMs })
    );
  }

  async ping() {
    return this.#request("GET", "/ping");
  }

  async getIdentity() {
    return this.#request("GET", "/debug/identity");
  }

  async #request(method, pathname, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(joinURL(this.baseURL, pathname), {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const payload = await decodeJSON(response);
      return {
        ok: response.ok,
        status: response.status,
        payload,
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`bridge_request_timeout:${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
