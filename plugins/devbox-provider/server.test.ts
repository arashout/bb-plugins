import { createHash } from "node:crypto";
import type { PluginMachineProviderProgress } from "@get-bb/plugin-sdk/machine-provider";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ExecOptions, IncusClient, Instance } from "./incus.js";
import { createDevboxProviderPlugin, defaultMachineName, KEY_CONFIG, PROVIDER_ID } from "./server.js";

const APP_URL = "https://bb.example";
const CALLBACK = "https://bb.example/api/v1/plugins/devbox-provider/http/connect/callback";

// A devbox whose tailscaled moves through the states a test scripts.
function fakeIncus(tailscale: Array<Record<string, unknown>>) {
  const instances = new Map<string, Instance>();
  const execs: Array<{ name: string; options: ExecOptions }> = [];
  let ts = 0;
  const client: IncusClient = {
    ping: vi.fn(async () => {}),
    getInstance: vi.fn(async (name: string) => instances.get(name) ?? null),
    listInstances: vi.fn(async () => [...instances.values()]),
    createInstance: vi.fn(async (spec) => {
      instances.set(spec.name, { name: spec.name, status: "Running", config: spec.config });
    }),
    setState: vi.fn(async (name: string, action: "start" | "stop") => {
      const i = instances.get(name);
      if (i) i.status = action === "start" ? "Running" : "Stopped";
    }),
    deleteInstance: vi.fn(async (name: string) => {
      instances.delete(name);
    }),
    exec: vi.fn(async (name: string, options: ExecOptions) => {
      execs.push({ name, options });
      if (options.command[0] === "tailscale" && options.command[1] === "status") {
        const state = tailscale[Math.min(ts, tailscale.length - 1)];
        ts += 1;
        options.onOutput(JSON.stringify(state));
      }
      return { exitCode: 0 };
    }),
  };
  return { client, instances, execs };
}

const report = (): PluginMachineProviderProgress & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, step: (t) => lines.push(`# ${t}`), log: (t) => lines.push(t) };
};
const signal = () => new AbortController().signal;

async function setup(options: { token?: string; tailscale?: Array<Record<string, unknown>>; fetch?: typeof fetch } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "devbox-provider",
    appUrl: APP_URL,
    settings: options.token === undefined ? {} : { token: options.token },
  });
  harness.sdk.stub("hosts.list", async () => [
    { id: "host_box", name: "box", machineProviderId: "devbox", lifecycle: { phase: "creating" }, status: "disconnected" },
    { id: "host_other", name: "laptop", machineProviderId: null, lifecycle: { phase: "active" }, status: "connected" },
  ]);
  const created: unknown[] = [];
  harness.sdk.stub("hosts.experimental_create", async (args: unknown) => {
    created.push(args);
    return { id: "host_new" };
  });
  const bootstrap = vi.fn(async () => ({ hostId: "host_devbox" }));
  Object.assign(bb.experimental_machines, { bootstrap });
  const incus = fakeIncus(options.tailscale ?? [{ BackendState: "Running", Self: { DNSName: "box.ts.net." } }]);
  const incusFactory = vi.fn(() => incus.client);
  const fetchImpl =
    options.fetch ??
    (vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/1.0/projects")) {
        return Response.json({ type: "sync", metadata: ["/1.0/projects/dylan"] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch);
  await createDevboxProviderPlugin({
    incusFactory,
    fetch: fetchImpl,
    now: () => Date.now(),
    sleep: async () => {},
  })(bb);
  const provider = harness.registrations.machineProviders.get(PROVIDER_ID)!;
  const route = harness.registrations.httpRoutes.find((r) => r.path === "/connect/callback")!;
  const app = new Hono().get("/cb", route.handler);
  const callback = (query: Record<string, string>) => app.request(`/cb?${new URLSearchParams(query)}`);
  return { bb, harness, provider, incus, incusFactory, bootstrap, callback, route, fetchImpl, created };
}

describe("connect", () => {
  it("sends the browser to devbox with PKCE and this server's callback", async () => {
    const { harness } = await setup();
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://devbox.boreray-eel.ts.net/connect/authorize");
    expect(u.searchParams.get("client_id")).toBe("bb");
    expect(u.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(u.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("exchanges the code with the verifier and stores the token", async () => {
    let exchanged: URLSearchParams | null = null;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/connect/token")) {
        exchanged = new URLSearchParams(String(init?.body));
        return Response.json({ access_token: "dbx_abc", token_type: "Bearer", project: "dylan" });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const { harness, callback } = await setup({ fetch: fetchImpl });
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const sent = new URL(url).searchParams;

    const res = await callback({ code: "the-code", state: sent.get("state")! });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dylan");
    expect(exchanged!.get("code")).toBe("the-code");
    expect(exchanged!.get("redirect_uri")).toBe(CALLBACK);
    expect(exchanged!.get("client_id")).toBe("bb");
    const verifier = exchanged!.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(sent.get("code_challenge"));

    expect(await harness.callRpc("status", null)).toMatchObject({ connected: true, project: "dylan" });

    // The state is single-use.
    expect((await callback({ code: "again", state: sent.get("state")! })).status).toBe(400);
  });

  it("refuses a callback whose state it never issued", async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const { callback } = await setup({ fetch: fetchImpl });
    for (const state of ["", "short", "x".repeat(43)]) {
      expect((await callback({ code: "c", state })).status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not exchange anything when the developer denied", async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const { harness, callback } = await setup({ fetch: fetchImpl });
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const res = await callback({ error: "access_denied", state: new URL(url).searchParams.get("state")! });
    expect(res.status).toBe(200);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("escapes what it echoes", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: "invalid_grant", error_description: "<script>x</script>" }, { status: 400 }),
    ) as unknown as typeof fetch;
    const { harness, callback } = await setup({ fetch: fetchImpl });
    const { url } = (await harness.callRpc("connect", null)) as { url: string };
    const res = await callback({ code: "c", state: new URL(url).searchParams.get("state")! });
    const body = await res.text();
    expect(body).not.toContain("<script>");
  });
});

describe("machines", () => {
  it("lists only devbox machines and creates one standalone", async () => {
    const { harness, created } = await setup({ token: "dbx_abc" });
    expect(await harness.callRpc("status", null)).toMatchObject({
      machines: [{ hostId: "host_box", name: "box", phase: "creating", status: "disconnected" }],
    });
    expect(await harness.callRpc("createMachine", { name: "mybox" })).toEqual({ hostId: "host_new" });
    expect(await harness.callRpc("createMachine", {})).toEqual({ hostId: "host_new" });
    expect(created).toEqual([
      { machineProviderId: "devbox", inputs: { name: "mybox" }, wait: false },
      { machineProviderId: "devbox", inputs: {}, wait: false },
    ]);
    await expect(harness.callRpc("createMachine", { name: "Bad Name" })).rejects.toThrow();
  });

  it("needs a connection first", async () => {
    const { provider } = await setup();
    expect(await provider.availability!()).toMatchObject({ status: "setup-required" });
    expect(await provider.validate!({ inputs: {} } as never)).toMatchObject({ action: "refuse" });
  });

  it("creates, asks for the Tailscale sign-in, and bootstraps as dev", async () => {
    const { provider, incus, bootstrap, harness, bb } = await setup({
      token: "dbx_abc",
      tailscale: [
        { BackendState: "NeedsLogin", AuthURL: "" },
        { BackendState: "NeedsLogin", AuthURL: "" },
        { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" },
        { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc" },
        { BackendState: "Running", Self: { DNSName: "box.boreray-eel.ts.net." } },
      ],
    });
    const r = report();
    const checkpoint = vi.fn(async () => {});
    let seenSignIn: unknown = null;
    const realtime = vi.spyOn(bb.realtime, "publish").mockImplementation(async () => {
      seenSignIn = seenSignIn ?? (await harness.callRpc("status", null));
    });

    const result = await provider.create({ inputs: { name: "box" }, key: "key-1", attempt: 1, checkpoint, report: r, signal: signal() } as never);
    expect(result).toEqual({ status: "created", name: "box", resource: { name: "box", key: "key-1", project: "dylan" } });
    expect(incus.instances.get("box")?.config[KEY_CONFIG]).toBe("key-1");
    expect(checkpoint).toHaveBeenCalledWith({ name: "box", key: "key-1", project: "dylan" });
    expect(r.lines.join("")).toContain("https://login.tailscale.com/a/abc");
    expect(seenSignIn).toMatchObject({ signIns: [{ machine: "box", url: "https://login.tailscale.com/a/abc" }] });
    expect(await harness.callRpc("status", null)).toMatchObject({ signIns: [] });
    expect(realtime).toHaveBeenCalled();

    // Prepared and logged in as root; bootstrapped as dev with the creation key.
    const roots = incus.execs.filter((e) => e.options.user === 0).map((e) => e.options.command.join(" "));
    expect(roots.some((c) => c.includes("loginctl enable-linger dev"))).toBe(true);
    expect(roots.some((c) => c.includes("tailscale up --ssh"))).toBe(true);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    const call = (bootstrap.mock.calls[0] as unknown[])[0] as { key: string; executor: { exec: Function } };
    expect(call.key).toBe("key-1");
    await call.executor.exec({ command: ["id"], stdin: "bundle", timeoutMs: 1000, signal: signal(), onOutput: () => {} });
    const devExec = incus.execs.at(-1)!.options;
    expect(devExec).toMatchObject({ user: 1000, group: 1000, cwd: "/home/dev", stdin: "bundle" });
    expect(devExec.environment.PATH).toContain("/home/dev/.local/share/mise/shims");
  });

  it("reuses its own instance on retry and refuses someone else's name", async () => {
    const { provider, incus } = await setup({ token: "dbx_abc" });
    const ctx = (key: string) => ({ inputs: { name: "box" }, key, attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() }) as never;
    expect(await provider.create(ctx("key-1"))).toMatchObject({ status: "created" });
    expect(await provider.create(ctx("key-1"))).toMatchObject({ status: "created" });
    expect(incus.client.createInstance).toHaveBeenCalledTimes(1);
    expect(await provider.create(ctx("key-2"))).toMatchObject({ status: "failed", message: expect.stringContaining("already exists") });
  });

  it("names a machine from its key when none is given", async () => {
    const { provider } = await setup({ token: "dbx_abc" });
    const result = await provider.create({ inputs: {}, key: "key-9", attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() } as never);
    expect(result).toMatchObject({ status: "created", name: defaultMachineName("key-9") });
    expect(defaultMachineName("key-9")).toMatch(/^bb-[0-9a-f]{6}$/u);
  });

  it("refuses a machine that joined the tailnet as a tag", async () => {
    const { provider, bootstrap } = await setup({
      token: "dbx_abc",
      tailscale: [{ BackendState: "Running", Self: { DNSName: "box.ts.net.", Tags: ["tag:server"] } }],
    });
    const result = await provider.create({ inputs: { name: "box" }, key: "k", attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() } as never);
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("tag:server") });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("removes the instance, and cleanup finds strays by key", async () => {
    const { provider, incus } = await setup({ token: "dbx_abc" });
    await provider.create({ inputs: { name: "box" }, key: "k", attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() } as never);
    incus.instances.set("stray", { name: "stray", status: "Stopped", config: { [KEY_CONFIG]: "lost" } });
    incus.instances.set("mine", { name: "mine", status: "Running", config: {} });

    expect(await provider.reconcileCleanup({ key: "lost", report: report(), signal: signal() })).toEqual({ status: "removed" });
    expect(incus.instances.has("stray")).toBe(false);
    expect(incus.instances.has("mine")).toBe(true);

    expect(await provider.remove({ resource: { name: "box", key: "k", project: "dylan" }, hostId: "h", report: report(), signal: signal() } as never)).toEqual({ status: "removed" });
    expect(incus.instances.has("box")).toBe(false);
    expect(incus.execs.some((e) => e.options.command.join(" ").includes("tailscale logout"))).toBe(true);
  });

  it("suspends by stopping and resumes with the same key", async () => {
    const { provider, incus, bootstrap } = await setup({ token: "dbx_abc" });
    const resource = { name: "box", key: "k", project: "dylan" };
    await provider.create({ inputs: { name: "box" }, key: "k", attempt: 1, checkpoint: async () => {}, report: report(), signal: signal() } as never);
    await provider.suspend!({ resource, hostId: "h", checkpoint: async () => {}, report: report(), signal: signal() });
    expect(incus.instances.get("box")?.status).toBe("Stopped");
    await provider.resume!({ resource, hostId: "h", checkpoint: async () => {}, report: report(), signal: signal() });
    expect(incus.instances.get("box")?.status).toBe("Running");
    expect((bootstrap.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ key: "k" });
  });
});
