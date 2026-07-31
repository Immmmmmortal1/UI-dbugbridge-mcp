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
  constructor({ baseURL, fetchImpl = fetch }) {
    this.baseURL = baseURL;
    this.fetchImpl = fetchImpl;
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

  async #request(method, pathname, body) {
    const response = await this.fetchImpl(joinURL(this.baseURL, pathname), {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await decodeJSON(response);
    return {
      ok: response.ok,
      status: response.status,
      payload,
    };
  }
}
