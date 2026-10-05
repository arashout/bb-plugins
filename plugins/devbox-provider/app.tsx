// The plugin's settings section: connect or disconnect devbox, and the
// Tailscale sign-in links of machines being created, which are the one step
// a person has to take.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";

interface Status {
  connected: boolean;
  project: string | null;
  devboxUrl: string;
  signIns: Array<{ machine: string; url: string; since: number }>;
}

function DevboxSection() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("status").then(
      (s: Status) => {
        setStatus(s);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("connection-changed", refetch);
  useRealtime("signins-changed", refetch);

  const open = (url: string) => {
    if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
  };

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await rpc.call("connect");
      open(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await rpc.call("disconnect");
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      {status.connected ? (
        <div className="flex items-center justify-between gap-4">
          <p>
            Connected{status.project ? (
              <>
                {" "}to project <code>{status.project}</code>
              </>
            ) : null}
            . New machines can be added under Settings → Machines.
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground">
            Connect your devbox project so bb can create machines in it. You approve it on devbox.
          </p>
          <Button size="sm" disabled={busy} onClick={() => void connect()}>
            Connect devbox
          </Button>
        </div>
      )}

      {status.signIns.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="font-medium">Waiting for you to sign in to Tailscale</p>
          {status.signIns.map((s) => (
            <div key={s.machine} className="flex items-center justify-between gap-4">
              <code>{s.machine}</code>
              <Button size="sm" onClick={() => open(s.url)}>
                Sign in
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {error !== null ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "devbox",
    title: "devbox",
    description: "Your devbox project and machines waiting for Tailscale sign-in.",
    component: DevboxSection,
  });
});
