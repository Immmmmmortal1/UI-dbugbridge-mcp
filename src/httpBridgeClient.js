function joinURL(baseURL, pathname) {
  return new URL(pathname, baseURL).toString();
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
