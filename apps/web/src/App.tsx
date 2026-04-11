// skybase web client. Sidebar of hosts → tmux sessions, main pane is xterm.js.
// Notifications come in over the WS and show as a toast in addition to any
// background Web Push the SW handled.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  HostInfo,
  ServerMessage,
  SrvNotification,
} from "@skybase/shared";
import { WsClient, type WsStatus } from "./wsClient.js";
import { TerminalPanel } from "./Terminal.js";
import { getStatus, sendTest, subscribe, unsubscribe } from "./push.js";

interface OpenSession {
  /** sessionId = `${hostId}:${tmuxName}`. */
  id: string;
  hostId: string;
  tmuxName: string;
  hostLabel: string;
  unread: number;
}

const LS_OPEN = "skybase.open";
const LS_ACTIVE = "skybase.active";

/** Read JSON from localStorage with a fallback if missing or malformed. */
function lsRead<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function App(): JSX.Element {
  const ws = useMemo(() => new WsClient(), []);
  const [status, setStatus] = useState<WsStatus>("connecting");
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  /** sessionId → list of currently-running tmux session names on the host. */
  const [remoteSessions, setRemoteSessions] = useState<
    Record<string, { loading: boolean; names: string[]; error?: string }>
  >({});
  const [open, setOpen] = useState<OpenSession[]>(() =>
    lsRead<OpenSession[]>(LS_OPEN, []),
  );
  const [active, setActive] = useState<string | null>(() =>
    lsRead<string | null>(LS_ACTIVE, null),
  );
  const [toast, setToast] = useState<SrvNotification | null>(null);

  // Persist open + active to localStorage on every change. Synchronous —
  // localStorage is fast and there's no benefit to debouncing for a list
  // that changes only on user actions.
  useEffect(() => {
    try {
      localStorage.setItem(LS_OPEN, JSON.stringify(open));
    } catch {
      // Storage quota or private browsing — silently ignore.
    }
  }, [open]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_ACTIVE, JSON.stringify(active));
    } catch {
      // ignore
    }
  }, [active]);

  // Whenever the host inventory updates, fetch the running tmux sessions for
  // each host in parallel. The endpoint is best-effort: 502 means the host is
  // unreachable, in which case we show an error indicator but still let the
  // user manually create a session by name.
  useEffect(() => {
    if (hosts.length === 0) return;
    let cancelled = false;
    setRemoteSessions((prev) => {
      const next = { ...prev };
      for (const h of hosts) {
        next[h.id] = { loading: true, names: prev[h.id]?.names ?? [] };
      }
      return next;
    });
    Promise.all(
      hosts.map(async (h) => {
        try {
          const r = await fetch(
            `/api/hosts/${encodeURIComponent(h.id)}/sessions`,
          );
          const body = (await r.json()) as
            | { sessions: string[] }
            | { error: string };
          if (cancelled) return;
          if ("sessions" in body) {
            setRemoteSessions((prev) => ({
              ...prev,
              [h.id]: { loading: false, names: body.sessions },
            }));
          } else {
            setRemoteSessions((prev) => ({
              ...prev,
              [h.id]: { loading: false, names: [], error: body.error },
            }));
          }
        } catch (err) {
          if (cancelled) return;
          setRemoteSessions((prev) => ({
            ...prev,
            [h.id]: {
              loading: false,
              names: [],
              error: String(err),
            },
          }));
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [hosts]);

  /**
   * Kill a remote tmux session via the DELETE endpoint, then refresh the
   * host's session list and close any matching open-session entry. Confirms
   * with the user first because the action is destructive and irreversible.
   */
  const killRemoteSession = async (
    hostId: string,
    tmuxName: string,
  ): Promise<void> => {
    const ok = window.confirm(
      `Kill tmux session "${tmuxName}" on this host?\n\n` +
        `This will SIGHUP every process inside it (Claude Code, builds, ` +
        `editors, etc.). There is no undo.`,
    );
    if (!ok) return;
    const sessionId = `${hostId}:${tmuxName}`;
    try {
      const r = await fetch(
        `/api/hosts/${encodeURIComponent(hostId)}/sessions/${encodeURIComponent(tmuxName)}`,
        { method: "DELETE" },
      );
      if (!r.ok && r.status !== 204) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        alert(`Failed to kill session: ${body.error ?? r.statusText}`);
        return;
      }
    } catch (err) {
      alert(`Failed to kill session: ${String(err)}`);
      return;
    }
    // Tell the server we no longer want the local PTY for this session
    // (the remote tmux is gone, so the ssh client will exit anyway, but
    // sending detach is cheap insurance against zombie ssh).
    ws.send({ t: "detach", sessionId });
    // Drop it from the open list so the user doesn't see a stale tab.
    setOpen((prev) => prev.filter((s) => s.id !== sessionId));
    if (active === sessionId) setActive(null);
    // Refresh the host's session list so the kill is reflected in the
    // sidebar immediately.
    void refreshHostSessions(hostId);
  };

  /** Manually trigger a refresh of the session list for one host. */
  const refreshHostSessions = async (hostId: string): Promise<void> => {
    setRemoteSessions((prev) => ({
      ...prev,
      [hostId]: { ...(prev[hostId] ?? { names: [] }), loading: true },
    }));
    try {
      const r = await fetch(
        `/api/hosts/${encodeURIComponent(hostId)}/sessions`,
      );
      const body = (await r.json()) as
        | { sessions: string[] }
        | { error: string };
      if ("sessions" in body) {
        setRemoteSessions((prev) => ({
          ...prev,
          [hostId]: { loading: false, names: body.sessions },
        }));
      } else {
        setRemoteSessions((prev) => ({
          ...prev,
          [hostId]: { loading: false, names: [], error: body.error },
        }));
      }
    } catch (err) {
      setRemoteSessions((prev) => ({
        ...prev,
        [hostId]: { loading: false, names: [], error: String(err) },
      }));
    }
  };

  // The message handler closure needs the latest `active` value to decide
  // whether to show a toast for an incoming notify, but the WS lifecycle
  // effect must NOT re-run when `active` changes (otherwise every sidebar
  // click closes the WebSocket, and the server forgets every attached PTY
  // session). Stash `active` in a ref so the closure reads the live value.
  const activeRef = useRef<string | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // ─── WS lifecycle (mount-once) ──────────────────────────────────────
  useEffect(() => {
    ws.connect();
    const offStatus = ws.onStatus(setStatus);
    const off = ws.on((msg: ServerMessage) => {
      if (msg.t === "sessions") {
        setHosts(msg.hosts);
      } else if (msg.t === "notify") {
        const cur = activeRef.current;
        setOpen((prev) =>
          prev.map((s) =>
            s.id === msg.sessionId && msg.sessionId !== cur
              ? { ...s, unread: s.unread + 1 }
              : s,
          ),
        );
        if (msg.sessionId !== cur) {
          setToast(msg);
          setTimeout(
            () => setToast((c) => (c === msg ? null : c)),
            5000,
          );
        }
      }
    });
    return () => {
      offStatus();
      off();
      ws.close();
    };
    // Intentionally only depends on the WsClient instance.
  }, [ws]);

  // Tell server which session is focused (for push suppression). This
  // effect must NOT touch WS lifecycle — only send focus messages.
  useEffect(() => {
    ws.send({ t: "focus", sessionId: active });
    const onVisibility = () => {
      ws.send({
        t: "focus",
        sessionId: document.hidden ? null : active,
      });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [ws, active]);

  // ─── Session open helper ────────────────────────────────────────────
  const openSession = (hostId: string, tmuxName: string): void => {
    const id = `${hostId}:${tmuxName}`;
    const host = hosts.find((h) => h.id === hostId);
    if (!host) return;
    setOpen((prev) =>
      prev.some((s) => s.id === id)
        ? prev.map((s) => (s.id === id ? { ...s, unread: 0 } : s))
        : [
            ...prev,
            { id, hostId, tmuxName, hostLabel: host.label, unread: 0 },
          ],
    );
    setActive(id);
  };

  const closeSession = (id: string): void => {
    setOpen((prev) => prev.filter((s) => s.id !== id));
    if (active === id) {
      setActive((prev) => {
        const remaining = open.filter((s) => s.id !== id);
        return remaining[0]?.id ?? null;
      });
    }
    ws.send({ t: "detach", sessionId: id });
  };

  // ─── Local-mode dev helper ──────────────────────────────────────────
  const isLocalDev = new URLSearchParams(location.search).get("local") === "1";

  return (
    <div className="app">
      <Sidebar
        hosts={hosts}
        remoteSessions={remoteSessions}
        open={open}
        active={active}
        status={status}
        onOpenSession={openSession}
        onPickSession={setActive}
        onCloseSession={closeSession}
        onKillSession={killRemoteSession}
        onRefreshHost={refreshHostSessions}
        isLocalDev={isLocalDev}
      />
      <main className="main">
        {open.length === 0 ? (
          <div className="empty">
            Pick a host on the left to open a tmux session.
          </div>
        ) : (
          // Render every open session stacked in absolute positioning, with
          // only the active one visible. This keeps every Terminal mounted
          // (and its xterm + WebSocket attach + remote ssh+tmux session
          // alive) so switching between sessions is instant — no reattach,
          // no PTY rebuild, no scrollback re-replay. The Terminal component
          // observes its `isActive` prop and refits + refocuses when it
          // becomes active, so resizes that happened while hidden are
          // applied at the right moment.
          open.map((s) => (
            <div
              key={s.id}
              className={`terminal-host ${
                s.id === active ? "active" : "hidden"
              }`}
              aria-hidden={s.id !== active}
            >
              <header className="main-header">
                <span>
                  {s.hostLabel} · <strong>{s.tmuxName}</strong>
                </span>
                <span className="main-status">ws: {status}</span>
              </header>
              <TerminalPanel
                ws={ws}
                sessionId={s.id}
                hostId={s.hostId}
                tmuxName={s.tmuxName}
                isActive={s.id === active}
              />
            </div>
          ))
        )}
      </main>

      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          <div className="title">{toast.title || "skybase"}</div>
          <div className="body">{toast.body}</div>
        </div>
      )}
    </div>
  );
}

interface SidebarProps {
  hosts: HostInfo[];
  remoteSessions: Record<
    string,
    { loading: boolean; names: string[]; error?: string }
  >;
  open: OpenSession[];
  active: string | null;
  status: WsStatus;
  onOpenSession: (hostId: string, tmuxName: string) => void;
  onPickSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onKillSession: (hostId: string, tmuxName: string) => void;
  onRefreshHost: (hostId: string) => void;
  isLocalDev: boolean;
}

function Sidebar(props: SidebarProps): JSX.Element {
  const [tmuxNameByHost, setTmuxNameByHost] = useState<Record<string, string>>(
    {},
  );
  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);

  useEffect(() => {
    void getStatus().then((s) => {
      setPushSupported(s.supported);
      setPushSubscribed(s.subscribed);
    });
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        skybase
        <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>
          {props.status}
        </span>
      </div>
      <div className="sidebar-list">
        {props.open.length > 0 && (
          <>
            <div className="sidebar-host">Open</div>
            {props.open.map((s) => (
              <div
                key={s.id}
                className={`sidebar-session ${
                  props.active === s.id ? "active" : ""
                }`}
                onClick={() => props.onPickSession(s.id)}
              >
                <span>
                  {s.hostLabel} · {s.tmuxName}
                </span>
                <span
                  style={{ display: "flex", gap: 6, alignItems: "center" }}
                >
                  {s.unread > 0 && <span className="badge">{s.unread}</span>}
                  <button
                    title="Detach (close locally; tmux session keeps running on the remote)"
                    style={{ padding: "0 6px" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onCloseSession(s.id);
                    }}
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
          </>
        )}

        {props.isLocalDev && (
          <>
            <div className="sidebar-host">Local dev</div>
            <div
              className="sidebar-session"
              onClick={() => props.onOpenSession("__local__", "local")}
            >
              <span>local bash</span>
            </div>
          </>
        )}

        {props.hosts.length > 0 && (
          <>
            {props.hosts.map((h) => {
              const rs = props.remoteSessions[h.id];
              return (
                <div key={h.id}>
                  {/* Host header — section label + refresh icon. Mirrors the
                      same `.sidebar-host` styling used by the "Open" group
                      at the top so the visual hierarchy is consistent. */}
                  <div
                    className="sidebar-host"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      paddingRight: 8,
                    }}
                  >
                    <span>{h.label}</span>
                    <button
                      title="Refresh session list"
                      onClick={() => props.onRefreshHost(h.id)}
                      style={{
                        padding: "0 6px",
                        fontSize: 11,
                        opacity: rs?.loading ? 0.5 : 1,
                        background: "transparent",
                        border: "none",
                      }}
                    >
                      ↻
                    </button>
                  </div>

                  {/* Existing tmux sessions on this host — one per row,
                      full-width clickable, same style as the "Open" group. */}
                  {rs?.error ? (
                    <div
                      className="sidebar-session"
                      style={{
                        fontSize: 12,
                        color: "var(--danger)",
                        cursor: "default",
                      }}
                      title={rs.error}
                    >
                      unreachable
                    </div>
                  ) : rs?.loading && rs.names.length === 0 ? (
                    <div
                      className="sidebar-session"
                      style={{
                        fontSize: 12,
                        color: "var(--fg-dim)",
                        cursor: "default",
                      }}
                    >
                      loading…
                    </div>
                  ) : rs && rs.names.length > 0 ? (
                    rs.names.map((name) => {
                      const sessionId = `${h.id}:${name}`;
                      return (
                        <div
                          key={name}
                          className={`sidebar-session ${
                            props.active === sessionId ? "active" : ""
                          }`}
                          onClick={() => props.onOpenSession(h.id, name)}
                          title={`Attach to existing tmux session "${name}"`}
                        >
                          <span>{name}</span>
                          <button
                            className="kill-btn"
                            title={`Terminate tmux session "${name}" on the remote (destructive)`}
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onKillSession(h.id, name);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })
                  ) : rs && !rs.loading ? (
                    <div
                      className="sidebar-session"
                      style={{
                        fontSize: 12,
                        color: "var(--fg-dim)",
                        cursor: "default",
                      }}
                    >
                      no running sessions
                    </div>
                  ) : null}

                  {/* Manual create / attach by name. Stays full width to
                      match the row-per-session layout above. */}
                  <div
                    style={{
                      display: "flex",
                      gap: 4,
                      padding: "6px 16px 12px 16px",
                    }}
                  >
                    <input
                      type="text"
                      placeholder="new session name"
                      value={tmuxNameByHost[h.id] ?? ""}
                      onChange={(e) =>
                        setTmuxNameByHost((m) => ({
                          ...m,
                          [h.id]: e.target.value,
                        }))
                      }
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button
                      onClick={() =>
                        props.onOpenSession(
                          h.id,
                          tmuxNameByHost[h.id] || "main",
                        )
                      }
                    >
                      open
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {props.hosts.length === 0 && !props.isLocalDev && (
          <div style={{ padding: 16, color: "var(--fg-dim)" }}>
            No hosts configured. Add some to{" "}
            <code>config/hosts.yaml</code>.
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        {pushSupported ? (
          <>
            <button
              onClick={async () => {
                if (pushSubscribed) {
                  await unsubscribe();
                  setPushSubscribed(false);
                } else {
                  await subscribe();
                  setPushSubscribed(true);
                }
              }}
            >
              {pushSubscribed ? "Disable notifications" : "Enable notifications"}
            </button>
            <button
              disabled={!pushSubscribed}
              onClick={() => {
                void sendTest();
              }}
            >
              Test notification
            </button>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>
            Push not supported in this browser. Install as a PWA on iOS to
            enable.
          </div>
        )}
      </div>
    </aside>
  );
}
