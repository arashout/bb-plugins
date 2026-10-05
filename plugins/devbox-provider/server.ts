// Devbox machines: create a devbox in the developer's Incus project on
// bertha, put it on the tailnet as theirs, and enroll it as a bb machine.
//
// Access to the project comes from connecting devbox once (connect.ts), which
// leaves a bearer token in the `token` secret setting. Every Incus call goes
// through devbox-gate with that token (incus.ts). Core installs and enrolls
// the daemon through the exec transport here, as it does for any machine.
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi, type MachineExecutor } from "@get-bb/plugin-sdk";
import type {
  PluginMachineProviderProgress,
  PluginMachineProviderResource,
} from "@get-bb/plugin-sdk/machine-provider";
import type { Context } from "hono";
import { z } from "zod";
import {
  authorizeUrl,
  exchangeCode,
  newPendingConnect,
  PENDING_TTL_MS,
  revokeToken,
  type PendingConnect,
} from "./connect.js";
import { createIncusClient, type IncusClient, type IncusConfig } from "./incus.js";
import {
  LOGOUT_COMMAND,
  parseTailscaleStatus,
  PREPARE_SCRIPT,
  START_LOGIN_SCRIPT,
  STATUS_COMMAND,
  type TailscaleStatus,
} from "./tailnet.js";

export const PROVIDER_ID = "devbox";
export const CALLBACK_PATH = "/connect/callback";
export const KEY_CONFIG = "user.bb.key";

// Incus instance names are hostnames; keep to the lowercase subset.
export const MACHINE_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const machineInputsSchema = z
  .object({
    name: z.string().regex(MACHINE_NAME_PATTERN, "lowercase letters, digits and dashes, starting with a letter").optional(),
    // An image alias visible to the project; the setting's image otherwise.
    image: z.string().min(1).optional(),
  })
  .strict();

export const resourceSchema = z.object({ name: z.string().min(1), key: z.string().min(1), project: z.string().min(1) }).strict();
export type MachineResource = z.infer<typeof resourceSchema>;

const signInSchema = z.object({ machine: z.string(), url: z.string(), since: z.number() });
export type SignIn = z.infer<typeof signInSchema>;

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      connected: z.boolean(),
      project: z.string().nullable(),
      devboxUrl: z.string(),
      signIns: z.array(signInSchema),
    }),
  },
  connect: {
    input: z.null(),
    output: z.object({ url: z.string() }),
  },
  disconnect: {
    input: z.null(),
    output: z.object({ ok: z.boolean() }),
  },
});

export const SETTING_DESCRIPTORS = {
  devboxUrl: {
    type: "string",
    label: "devbox address",
    description: "Where your browser approves the connection.",
    default: "https://devbox.boreray-eel.ts.net",
  },
  apiUrl: {
    type: "string",
    label: "devbox API",
    description: "devbox-gate's API listener as this server reaches it, in-cluster.",
    default: "http://devbox-gate.devbox-production.svc.cluster.local:8081",
  },
  clientId: {
    type: "string",
    label: "Client ID",
    description: "This server's client ID in devbox's client registry.",
    default: "bb",
  },
  token: {
    type: "string",
    secret: true,
    label: "Connection token",
    description: "Filled in by Connect devbox below. Paste one only if you got it another way.",
  },
  image: {
    type: "string",
    label: "Image",
    description: "Image alias new machines start from.",
    default: "devbox",
  },
  profiles: {
    type: "string",
    label: "Profiles",
    description: "Comma-separated Incus profiles for new machines, applied in order.",
    default: "default,devbox",
  },
  signInTimeoutMinutes: {
    type: "number",
    label: "Tailscale sign-in timeout (minutes)",
    description: "How long machine creation waits for you to sign the machine in to Tailscale.",
    default: 20,
  },
} as const;

export const SIGNINS_CHANGED = "signins-changed";
export const CONNECTION_CHANGED = "connection-changed";

const ROOT_ENV = {
  HOME: "/root",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
};
// Incus exec runs no login shell, so nothing reads /etc/environment or the
// profile: the mise shims (Node for bb's installer) and the user bus are
// spelled out here.
const DEV_ENV = {
  HOME: "/home/dev",
  USER: "dev",
  LOGNAME: "dev",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
  PATH: "/home/dev/.local/share/mise/shims:/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  XDG_RUNTIME_DIR: "/run/user/1000",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
};
const DEV_UID = 1000;

const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
const SHORT_EXEC_TIMEOUT_MS = 60 * 1000;
const AUTH_URL_TIMEOUT_MS = 2 * 60 * 1000;
const RECONNECT_TIMEOUT_MS = 2 * 60 * 1000;
const POLL_MS = 3000;

export interface DevboxProviderDeps {
  incusFactory: (cfg: IncusConfig) => IncusClient;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// A retried create must find the instance its first attempt made, so the
// default name is a function of the creation key.
export function defaultMachineName(key: string): string {
  return `bb-${createHash("sha256").update(key).digest("hex").slice(0, 6)}`;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

function resultPage(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222;background:#fafafa}@media (prefers-color-scheme:dark){body{color:#ddd;background:#161616}}main{max-width:32rem;padding:2rem;text-align:center}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

export function createDevboxProviderPlugin(deps: DevboxProviderDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);

    // ---- the connection ---------------------------------------------------

    const pendingKey = (state: string) => `connect/pending/${state}`;
    const CONNECTION_KEY = "connection";
    const connectionRecord = z.object({ tokenFingerprint: z.string(), project: z.string() });

    function redirectUri(): string {
      const appUrl = bb.server.experimental_appUrl;
      if (appUrl === null) {
        throw new Error("This bb server has no public address (BB_APP_URL), so devbox cannot send you back to it.");
      }
      return new URL(`/api/v1/plugins/${bb.pluginId}/http${CALLBACK_PATH}`, appUrl).toString();
    }

    // The project the token opens. Recorded at connect; a token pasted by
    // hand is asked, since its certificate sees exactly one project.
    async function projectFor(token: string, apiUrl: string, signal: AbortSignal): Promise<string> {
      const fp = tokenFingerprint(token);
      const stored = connectionRecord.safeParse(await bb.storage.kv.get(CONNECTION_KEY));
      if (stored.success && stored.data.tokenFingerprint === fp) return stored.data.project;
      const response = await deps.fetch(new URL("/1.0/projects", apiUrl), {
        headers: { authorization: `Bearer ${token}` },
        signal,
      });
      const body = (await response.json().catch(() => ({}))) as { metadata?: unknown };
      const projects = Array.isArray(body.metadata) ? body.metadata.filter((p): p is string => typeof p === "string") : [];
      if (!response.ok || projects.length !== 1) {
        throw new Error("The connection token does not open exactly one devbox project; connect devbox again.");
      }
      const project = projects[0].split("/").pop() ?? "";
      await bb.storage.kv.set(CONNECTION_KEY, { tokenFingerprint: fp, project });
      return project;
    }

    async function connection(signal: AbortSignal): Promise<{ incus: IncusClient; project: string; cfg: Awaited<ReturnType<typeof settings.get>> }> {
      const cfg = await settings.get();
      const token = cfg.token?.trim() ?? "";
      if (token === "") {
        throw new Error("devbox is not connected. Open Settings → Plugins → Devbox machines and choose Connect devbox.");
      }
      const project = await projectFor(token, cfg.apiUrl, signal);
      return { incus: deps.incusFactory({ apiUrl: cfg.apiUrl, token, project }), project, cfg };
    }

    async function prunePending(): Promise<void> {
      const now = deps.now();
      for (const key of await bb.storage.kv.list("connect/pending/")) {
        const p = await bb.storage.kv.get<PendingConnect>(key);
        if (p === undefined || now - p.createdAt > PENDING_TTL_MS) await bb.storage.kv.delete(key);
      }
    }

    async function signIns(): Promise<SignIn[]> {
      const out: SignIn[] = [];
      for (const key of await bb.storage.kv.list("signin/")) {
        const parsed = signInSchema.safeParse(await bb.storage.kv.get(key));
        if (parsed.success) out.push(parsed.data);
      }
      return out.sort((a, b) => a.since - b.since);
    }

    bb.rpc.register(rpcContract, {
      async status() {
        const cfg = await settings.get();
        const token = cfg.token?.trim() ?? "";
        let project: string | null = null;
        if (token !== "") {
          const stored = connectionRecord.safeParse(await bb.storage.kv.get(CONNECTION_KEY));
          project = stored.success && stored.data.tokenFingerprint === tokenFingerprint(token) ? stored.data.project : null;
        }
        return { connected: token !== "", project, devboxUrl: cfg.devboxUrl, signIns: await signIns() };
      },
      async connect() {
        const cfg = await settings.get();
        await prunePending();
        const pending = newPendingConnect(redirectUri(), deps.now());
        await bb.storage.kv.set(pendingKey(pending.state), pending);
        return { url: authorizeUrl(cfg.devboxUrl, cfg.clientId, pending) };
      },
      async disconnect() {
        const cfg = await settings.get();
        const token = cfg.token?.trim() ?? "";
        if (token !== "") {
          try {
            await revokeToken(cfg.apiUrl, token, deps.fetch, AbortSignal.timeout(10_000));
          } catch (error) {
            bb.log.warn(`could not revoke the devbox token: ${errorMessage(error)}`);
          }
        }
        await settings.experimental_set({ token: null });
        await bb.storage.kv.delete(CONNECTION_KEY);
        bb.realtime.publish(CONNECTION_CHANGED, { connected: false });
        return { ok: true };
      },
    });

    // devbox sends the browser here after approval. "none" because the
    // request is a top-level navigation from devbox's origin; the state is
    // the credential: 256 random bits, single-use, and minted for this
    // server, so a forged or replayed callback finds nothing.
    bb.http.route(
      "GET",
      CALLBACK_PATH,
      async (c: Context) => {
        const state = c.req.query("state") ?? "";
        const pending = /^[A-Za-z0-9_-]{43}$/u.test(state)
          ? await bb.storage.kv.get<PendingConnect>(pendingKey(state))
          : undefined;
        if (pending === undefined || deps.now() - pending.createdAt > PENDING_TTL_MS) {
          return resultPage("This link has expired", "Start again from Connect devbox in bb's settings.", 400);
        }
        await bb.storage.kv.delete(pendingKey(state));
        if (c.req.query("error") !== undefined) {
          return resultPage("Not connected", "devbox was not connected. You can close this tab.", 200);
        }
        const code = c.req.query("code") ?? "";
        const cfg = await settings.get();
        try {
          const conn = await exchangeCode(cfg.apiUrl, cfg.clientId, pending, code, deps.fetch, AbortSignal.timeout(15_000));
          await settings.experimental_set({ token: conn.token });
          await bb.storage.kv.set(CONNECTION_KEY, { tokenFingerprint: tokenFingerprint(conn.token), project: conn.project });
          bb.realtime.publish(CONNECTION_CHANGED, { connected: true });
          bb.log.info(`connected to devbox project ${conn.project}`);
          return resultPage(
            "devbox connected",
            `bb can now create machines in your devbox project ${conn.project}. You can close this tab.`,
            200,
          );
        } catch (error) {
          bb.log.warn(`devbox connect failed: ${errorMessage(error)}`);
          return resultPage("Not connected", `${errorMessage(error)}. Start again from bb's settings.`, 502);
        }
      },
      { auth: "none" },
    );

    // ---- running things in a machine -------------------------------------

    function asRoot(incus: IncusClient, name: string) {
      return async (
        command: string[],
        signal: AbortSignal,
        timeoutMs = SHORT_EXEC_TIMEOUT_MS,
        onOutput?: (chunk: string) => void,
      ): Promise<{ exitCode: number; output: string }> => {
        let output = "";
        const { exitCode } = await incus.exec(name, {
          command,
          environment: ROOT_ENV,
          user: 0,
          group: 0,
          cwd: "/root",
          stdin: "",
          timeoutMs,
          signal,
          onOutput: (chunk) => {
            output += chunk;
            onOutput?.(chunk);
          },
        });
        return { exitCode, output };
      };
    }

    function devExecutor(incus: IncusClient, name: string): MachineExecutor {
      return {
        exec: ({ command, stdin, timeoutMs, signal, onOutput }) =>
          incus.exec(name, {
            command,
            environment: DEV_ENV,
            user: DEV_UID,
            group: DEV_UID,
            cwd: DEV_ENV.HOME,
            stdin,
            timeoutMs,
            signal,
            onOutput,
          }),
      };
    }

    async function prepare(incus: IncusClient, name: string, report: PluginMachineProviderProgress, signal: AbortSignal) {
      report.step("Waiting for the machine to boot");
      const { exitCode } = await asRoot(incus, name)(["sh", "-c", PREPARE_SCRIPT], signal, PREPARE_TIMEOUT_MS, (c) => report.log(c));
      if (exitCode !== 0) throw new Error(`machine ${name} did not finish booting (exit ${exitCode})`);
    }

    async function tailscaleStatus(incus: IncusClient, name: string, signal: AbortSignal): Promise<TailscaleStatus> {
      const { exitCode, output } = await asRoot(incus, name)(STATUS_COMMAND, signal);
      try {
        return parseTailscaleStatus(output);
      } catch {
        throw new Error(`tailscale status failed in ${name} (exit ${exitCode}): ${output.trim().slice(0, 300)}`);
      }
    }

    async function setSignIn(name: string, url: string | null) {
      if (url === null) await bb.storage.kv.delete(`signin/${name}`);
      else await bb.storage.kv.set(`signin/${name}`, { machine: name, url, since: deps.now() });
      bb.realtime.publish(SIGNINS_CHANGED, { machine: name });
    }

    // Brings the machine onto the tailnet as the developer's own node,
    // asking them to sign in when tailscaled has no login.
    async function joinTailnet(
      incus: IncusClient,
      name: string,
      timeoutMinutes: number,
      report: PluginMachineProviderProgress,
      signal: AbortSignal,
    ): Promise<void> {
      report.step("Joining the tailnet");
      let status = await tailscaleStatus(incus, name, signal);
      if (status.backendState !== "Running") {
        // A machine that was signed in before needs a moment to reconnect.
        const settleBy = deps.now() + RECONNECT_TIMEOUT_MS;
        while (status.backendState === "Starting" && deps.now() < settleBy) {
          await deps.sleep(POLL_MS, signal);
          status = await tailscaleStatus(incus, name, signal);
        }
      }
      if (status.backendState !== "Running") {
        const started = await asRoot(incus, name)(["sh", "-c", START_LOGIN_SCRIPT], signal);
        if (started.exitCode !== 0) throw new Error(`could not start tailscale in ${name}: ${started.output.trim()}`);
        let shown = "";
        const urlBy = deps.now() + AUTH_URL_TIMEOUT_MS;
        const doneBy = deps.now() + timeoutMinutes * 60 * 1000;
        try {
          for (;;) {
            status = await tailscaleStatus(incus, name, signal);
            if (status.backendState === "Running") break;
            if (status.authUrl !== "" && status.authUrl !== shown) {
              shown = status.authUrl;
              report.step("Sign in to Tailscale");
              report.log(
                `\nSign ${name} in to Tailscale as yourself:\n\n  ${shown}\n\n` +
                  `The link is also under Settings → Plugins → Devbox machines. Waiting up to ${timeoutMinutes} minutes.\n`,
              );
              await setSignIn(name, shown);
            }
            if (shown === "" && deps.now() > urlBy) throw new Error(`tailscale in ${name} offered no sign-in link`);
            if (deps.now() > doneBy) throw new Error(`nobody signed ${name} in to Tailscale within ${timeoutMinutes} minutes`);
            await deps.sleep(POLL_MS, signal);
          }
        } finally {
          if (shown !== "") await setSignIn(name, null);
        }
      }
      if (status.tags.length > 0) {
        throw new Error(
          `${name} joined the tailnet as ${status.tags.join(", ")}; bb-gate only admits machines signed in as a person. Sign it in as yourself.`,
        );
      }
      report.log(`on the tailnet as ${status.dnsName || name}\n`);
    }

    async function bootstrap(incus: IncusClient, resource: MachineResource, report: PluginMachineProviderProgress, signal: AbortSignal) {
      report.step("Installing the bb daemon");
      const startedAt = deps.now();
      await bb.experimental_machines.bootstrap({ key: resource.key, executor: devExecutor(incus, resource.name), report, signal });
      report.log(`daemon connected in ${Math.round((deps.now() - startedAt) / 1000)} s\n`);
    }

    async function stopAndDelete(incus: IncusClient, name: string, signal: AbortSignal) {
      const instance = await incus.getInstance(name, signal);
      if (instance === null) return;
      if (instance.status === "Running") {
        try {
          await asRoot(incus, name)(LOGOUT_COMMAND, signal, 30_000);
        } catch (error) {
          bb.log.warn(`tailscale logout in ${name} failed: ${errorMessage(error)}`);
        }
        await incus.setState(name, "stop", signal);
      }
      await incus.deleteInstance(name, signal);
    }

    // ---- the machine provider --------------------------------------------

    bb.experimental_machines.register({
      id: PROVIDER_ID,
      displayName: "Devbox",
      description: "A devbox in your Incus project on bertha, on your tailnet. You sign it in to Tailscale once.",
      icon: "Server",
      ephemeral: false,
      inputs: machineInputsSchema,
      async availability() {
        const cfg = await settings.get();
        if ((cfg.token?.trim() ?? "") === "") {
          return { status: "setup-required", message: "Connect devbox in Settings → Plugins → Devbox machines." };
        }
        try {
          const { incus } = await connection(AbortSignal.timeout(4000));
          await incus.ping(AbortSignal.timeout(4000));
          return { status: "available" };
        } catch (error) {
          return { status: "unavailable", message: errorMessage(error) };
        }
      },
      async validate() {
        const cfg = await settings.get();
        if ((cfg.token?.trim() ?? "") === "") {
          return { action: "refuse", message: "Connect devbox in Settings → Plugins → Devbox machines first." };
        }
        return { action: "accept" };
      },
      async create({ inputs, key, checkpoint, report, signal }) {
        try {
          const { incus, project, cfg } = await connection(signal);
          const name = inputs.name ?? defaultMachineName(key);
          report.step("Creating the devbox");
          const existing = await incus.getInstance(name, signal);
          if (existing !== null) {
            if (existing.config[KEY_CONFIG] !== key) {
              return { status: "failed", message: `A machine named ${name} already exists in project ${project}.` };
            }
            report.log(`reusing ${name}\n`);
            if (existing.status !== "Running") await incus.setState(name, "start", signal);
          } else {
            const image = inputs.image ?? cfg.image;
            const profiles = cfg.profiles.split(",").map((p) => p.trim()).filter((p) => p !== "");
            await incus.createInstance(
              { name, image, profiles, config: { [KEY_CONFIG]: key, "user.bb.managed-by": bb.pluginId } },
              signal,
            );
            report.log(`created ${name} from ${image} in project ${project}\n`);
          }
          const resource: MachineResource = { name, key, project };
          await checkpoint(resource);
          await prepare(incus, name, report, signal);
          await joinTailnet(incus, name, cfg.signInTimeoutMinutes, report, signal);
          await bootstrap(incus, resource, report, signal);
          return { status: "created", name, resource };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorMessage(error) };
        }
      },
      async reconcileCleanup({ key, signal }) {
        try {
          const { incus } = await connection(signal);
          for (const instance of await incus.listInstances(signal)) {
            if (instance.config[KEY_CONFIG] === key) await stopAndDelete(incus, instance.name, signal);
          }
          return { status: "removed" };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorMessage(error) };
        }
      },
      async suspend({ resource, checkpoint, report, signal }) {
        const owned = resourceSchema.parse(resource);
        const { incus } = await connection(signal);
        await checkpoint(owned);
        const instance = await incus.getInstance(owned.name, signal);
        if (instance !== null && instance.status === "Running") {
          report.step("Stopping the devbox");
          await incus.setState(owned.name, "stop", signal);
        }
        return { resource: owned };
      },
      async resume({ resource, checkpoint, report, signal }) {
        const owned = resourceSchema.parse(resource);
        const { incus, cfg } = await connection(signal);
        const instance = await incus.getInstance(owned.name, signal);
        if (instance === null) throw new Error(`${owned.name} no longer exists; remove this machine and create another`);
        if (instance.status !== "Running") {
          report.step("Starting the devbox");
          await incus.setState(owned.name, "start", signal);
        }
        await checkpoint(owned);
        await prepare(incus, owned.name, report, signal);
        await joinTailnet(incus, owned.name, cfg.signInTimeoutMinutes, report, signal);
        await bootstrap(incus, owned, report, signal);
        return { resource: owned };
      },
      async remove({ resource, report, signal }) {
        try {
          const owned = resourceSchema.parse(resource as PluginMachineProviderResource);
          const { incus } = await connection(signal);
          await stopAndDelete(incus, owned.name, signal);
          await bb.storage.kv.delete(`signin/${owned.name}`);
          report.log(`deleted ${owned.name}\n`);
          return { status: "removed" };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: errorMessage(error) };
        }
      },
    });
  };
}

export default createDevboxProviderPlugin({
  incusFactory: (cfg) => createIncusClient(cfg),
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: defaultSleep,
});
