/**
 * The Repos nav panel: the project's repo set, its object cache, and an editor
 * for `repos.json`.
 *
 * **Why a nav panel and not project settings.** There is no project-settings
 * slot among the plugin app slots, so this cannot sit beside bb's own project
 * settings where someone would look for it. A nav panel is the next best
 * thing — bb gives it the whole main area, a route, and a host-owned sidebar
 * item the user can reorder or hide — and the `bb repos` CLI covers the person
 * who looked in the obvious place and did not find it.
 *
 * **Why the editor is the file, not a form.** `repos.json` is the single
 * source of truth and it is committed to a git repo the user may also edit by
 * hand or from another machine. A form would have to round-trip through a
 * representation that loses comments, key order and anything a future version
 * adds; editing the text keeps the panel and the file the same object. The
 * cost is that validation has to be loud, which is what the error banner is.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { experimental_Icon as Icon, useBbContext, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { CacheEntry, RepoSetView, rpcContract } from "./contract.js";
import { REPOS_CHANGED_CHANNEL } from "./shared.js";

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function CacheBadge({ entry }: { entry: CacheEntry | undefined }) {
  if (entry === undefined || !entry.present) {
    return <span className="text-muted-foreground text-xs">not cached yet</span>;
  }
  const size = formatSize(entry.sizeBytes);
  return (
    <span className="text-muted-foreground text-xs">
      cached{size === null ? "" : ` · ${size}`}
      {entry.fetchedAt === null ? "" : ` · fetched ${relativeTime(entry.fetchedAt)}`}
    </span>
  );
}

export function ReposPanel() {
  const { projectId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<RepoSetView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (projectId === null) {
      setView(null);
      return;
    }
    void rpc
      .call("repoSet", { projectId })
      .then((next) => {
        setView(next);
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Could not load the repo set."));
  }, [rpc, projectId]);

  useEffect(load, [load]);
  useRealtime(REPOS_CHANGED_CHANNEL, load);

  const cacheByUrl = useMemo(
    () => new Map((view?.cache ?? []).map((entry) => [entry.url, entry])),
    [view?.cache],
  );

  const editing = draft !== null;
  const save = useCallback(() => {
    if (projectId === null || draft === null) return;
    setSaving(true);
    setSaveError(null);
    void rpc
      .call("saveRepoSet", { projectId, reposJson: draft })
      .then((result) => {
        if (result.ok) {
          setDraft(null);
          load();
        } else {
          setSaveError(result.error);
        }
      })
      .catch((error: unknown) => setSaveError(error instanceof Error ? error.message : "Could not save."))
      .finally(() => setSaving(false));
  }, [rpc, projectId, draft, load]);

  if (projectId === null) {
    return (
      <div className="p-4 md:p-5">
        <p className="text-muted-foreground text-sm">Open a project to see its repo set.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {loadError !== null && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
            {loadError}
          </div>
        )}

        {view !== null && view.projectSourcePath === null && (
          <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm">
            This project has no checkout on any machine, so it has no repo set yet.
          </div>
        )}

        {view !== null && view.error !== null && (
          <div className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm">
            <div className="text-destructive font-medium">repos.json is invalid</div>
            <div className="text-destructive/90 mt-1 font-mono text-xs">{view.error}</div>
            <div className="text-muted-foreground mt-2 text-xs">
              Every thread created in this project will fail to start until this parses. Fix it below.
            </div>
          </div>
        )}

        {view !== null && view.projectSourcePath !== null && (
          <>
            <section className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-sm font-medium">Repos</h2>
                <span className="text-muted-foreground truncate font-mono text-xs">{view.projectSourcePath}</span>
              </div>

              {view.repos.length === 0 && view.error === null ? (
                <p className="text-muted-foreground text-sm">
                  No repos yet. Add one with <code className="font-mono">bb repos add &lt;url&gt;</code>, or edit the
                  file below. A thread started with an empty set proposes the repos it finds on the machine.
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {view.repos.map((repo) => (
                    <li key={repo.dir} className="flex items-start justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Icon name="FolderGit" className="text-muted-foreground size-3.5 shrink-0" />
                          <span className="truncate font-medium">{repo.dir}</span>
                          {repo.branch !== null && (
                            <span className="text-muted-foreground shrink-0 font-mono text-xs">{repo.branch}</span>
                          )}
                        </div>
                        <div className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{repo.url}</div>
                      </div>
                      <div className="shrink-0 pt-0.5 text-right">
                        <CacheBadge entry={cacheByUrl.get(repo.url)} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">repos.json</h2>
                <div className="flex items-center gap-2">
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground rounded-md px-2 py-1 text-xs"
                        onClick={() => {
                          setDraft(null);
                          setSaveError(null);
                        }}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs disabled:opacity-50"
                        onClick={save}
                        disabled={saving}
                      >
                        {saving ? "Committing…" : "Commit"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="hover:bg-muted rounded-md border px-2.5 py-1 text-xs"
                      onClick={() => setDraft(view.reposJson ?? '{\n  "version": 1,\n  "repos": []\n}\n')}
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>

              {saveError !== null && (
                <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 font-mono text-xs">
                  {saveError}
                </div>
              )}

              <textarea
                className="bg-muted/30 h-72 w-full resize-y rounded-md border p-3 font-mono text-xs"
                spellCheck={false}
                readOnly={!editing}
                value={editing ? draft : (view.reposJson ?? "")}
                onChange={(event) => setDraft(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Saving commits the file in the project's <code className="font-mono">.bb</code> repo. Existing
                workspaces keep the repos they were created with; changes apply to new threads.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
