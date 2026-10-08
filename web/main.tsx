import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import itemCatalog from "../src/game/item-catalog.json";
import "./style.css";

async function api(
  path: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const response = await fetch(`/api/admin${path}`, {
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    method: method || (body ? "POST" : "GET"),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error("Service returned an unreadable response");
  }
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const date = (n: number | null | undefined, seconds = false) =>
  n ? new Date(n * (seconds ? 1000 : 1)).toLocaleString() : "—";
const playerDate = (n: number) => date(n, n < 1e12);
const format = (value: unknown) => JSON.stringify(value, null, 2);
const rewardOptions = [
  { id: "ruby", name: "Ruby", max: 2147483647 },
  { id: "gold", name: "Gold", max: 2147483647 },
  ...Object.entries(itemCatalog).map(([id, { item }]) => ({
    id,
    name: item.m_name,
    max: item.stack,
  })),
  ...["alaster", "edna", "louisa", "soul"].flatMap((character) =>
    Array.from({ length: 8 }, (_, index) => ({
      id: `costume_${character}_${index + 1}`,
      name: `${character} costume ${index + 1}`,
      max: 1,
    })),
  ),
];
const rewardMaximum = (id: string) =>
  rewardOptions.find((option) => option.id === id)?.max || 1;
function RewardOptions() {
  return (
    <>
      {rewardOptions.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </>
  );
}
function App() {
  const [admin, setAdmin] = useState<any>(null),
    [authError, setAuthError] = useState(""),
    [status, setStatus] = useState<any>(null),
    [tab, setTab] = useState("players"),
    [query, setQuery] = useState(""),
    [players, setPlayers] = useState<any[]>([]),
    [detail, setDetail] = useState<any>(null),
    [events, setEvents] = useState<any[]>([]),
    [config, setConfig] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const [s, p] = await Promise.all([
      api("/status"),
      api(`/players?query=${encodeURIComponent(query)}`),
    ]);
    setStatus(s);
    setPlayers(p.players);
  }
  async function open(id: string) {
    setDetail(await api(`/players/${encodeURIComponent(id)}`));
  }
  useEffect(() => {
    api("/me")
      .then(async (data) => {
        setAdmin(data.admin);
        try {
          await refresh();
        } catch (error) {
          setError((error as Error).message);
        }
      })
      .catch((e) => setAuthError(e.message));
  }, []);
  async function changeTab(value: string) {
    setTab(value);
    if (value === "audit") setEvents((await api("/audit")).events);
    if (value === "config") setConfig(await api("/config"));
  }
  return (
    <>
      <header>
        <a className="brand" href="/">
          EC<span>1</span> <small>MODERATION</small>
        </a>
        <nav>
          <a className="active" href="/">
            Epic Conquest 1
          </a>
          <a href="https://ec2mod.codezrv.com">Epic Conquest 2 ↗</a>
        </nav>
        <div className="account">{admin?.name || "Administrator access"}</div>
      </header>
      {!admin ? (
        <main className="welcome">
          <div className="eyebrow">EPIC CONQUEST 1</div>
          <h1>
            Player support,
            <br />
            in one place.
          </h1>
          <p>
            Accounts, save history, in-game mail and daily rewards for Epic
            Conquest 1.
          </p>
          {authError === "admin_not_configured" ? (
            <button disabled>Sign-in setup pending</button>
          ) : (
            <a className="button" href="/auth/discord">
              Sign in with Discord
            </a>
          )}
          {authError && (
            <div className="notice">
              {authError === "admin_not_configured"
                ? "Administrator sign-in is awaiting its EC1 Discord configuration."
                : authError === "admin_unauthorized"
                  ? "Sign in with an authorized administrator account."
                  : authError}
            </div>
          )}
          <p className="muted">
            EC1 and EC2 retain separate player profiles and saves.
          </p>
        </main>
      ) : (
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">EPIC CONQUEST 1</div>
              <h1>Moderation desk</h1>
            </div>
            <div>
              <span className="pill">{status?.environment || "Loading"}</span>
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api("/logout", {});
                    setAdmin(null);
                  })
                }
              >
                Sign out
              </button>
            </div>
          </div>
          {status && (
            <div className="metrics">
              <div>
                <span>Players</span>
                <strong>{status.players}</strong>
              </div>
              <div>
                <span>New accounts</span>
                <strong>
                  {status.newAccountsEnabled ? "Enabled" : "Paused"}
                </strong>
              </div>
              <div>
                <span>Legacy migration</span>
                <strong>
                  {status.migrationEnabled ? "Enabled" : "Paused"}
                </strong>
              </div>
              <div>
                <span>Sign-in providers</span>
                <strong>
                  {Object.entries(status.providers)
                    .filter(([, value]) => value)
                    .map(([name]) => name)
                    .join(", ")}
                </strong>
              </div>
            </div>
          )}
          <div className="tabs">
            {["players", "config", "audit"].map((value) => (
              <button
                key={value}
                className={tab === value ? "selected" : ""}
                disabled={busy}
                onClick={() => run(() => changeTab(value))}
              >
                {value === "config"
                  ? "Rewards & coupons"
                  : value === "audit"
                    ? "Audit history"
                    : "Players"}
              </button>
            ))}
          </div>
          {error && (
            <div className="error" role="alert">
              {error.replaceAll("_", " ")}
            </div>
          )}
          {note && (
            <div className="notice" role="status">
              {note}
            </div>
          )}
          {tab === "players" && (
            <div className="workspace">
              <section className="panel">
                <form
                  className="search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(refresh);
                  }}
                >
                  <input
                    aria-label="Search players"
                    placeholder="Player ID, name or linked account"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button disabled={busy}>Search</button>
                </form>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Save state</th>
                        <th>Version</th>
                      </tr>
                    </thead>
                    <tbody>
                      {players.map((p) => (
                        <tr
                          key={p.id}
                          className={
                            detail?.player.id === p.id ? "focused" : ""
                          }
                          onClick={() => run(() => open(p.id))}
                        >
                          <td>
                            <button className="player-button">
                              {p.display_name || p.id}
                            </button>
                            <small>
                              {p.display_name ? p.id : playerDate(p.created_at)}
                            </small>
                          </td>
                          <td>
                            <span className="pill">
                              {p.save_state.replaceAll("_", " ")}
                            </span>
                          </td>
                          <td>{p.save_version}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!players.length && (
                    <div className="empty">No matching EC1 players.</div>
                  )}
                </div>
              </section>
              {detail ? (
                <Player
                  key={detail.player.id}
                  detail={detail}
                  busy={busy}
                  run={run}
                  reload={() => open(detail.player.id)}
                  setNote={setNote}
                />
              ) : (
                <aside className="panel empty">
                  Select a player to inspect account details and save history.
                </aside>
              )}
            </div>
          )}
          {tab === "config" && config && (
            <Rewards
              config={config}
              busy={busy}
              run={run}
              reload={async () => setConfig(await api("/config"))}
              setNote={setNote}
            />
          )}
          {tab === "audit" && (
            <section className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Administrator</th>
                    <th>Action</th>
                    <th>Player / detail</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td>{date(e.created_at)}</td>
                      <td>{e.actor_name}</td>
                      <td>{e.action}</td>
                      <td>
                        {e.player_id || "Global"}
                        <small>{e.detail_json}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!events.length && (
                <div className="empty">No administrator actions yet.</div>
              )}
            </section>
          )}
        </main>
      )}
      <footer>
        Epic Conquest 1 · Codezrv ·{" "}
        <a href="https://ec2mod.codezrv.com">Open EC2 moderation ↗</a>
      </footer>
    </>
  );
}
type Work = {
  busy: boolean;
  run: (task: () => Promise<void>) => Promise<void>;
  reload: () => Promise<void>;
  setNote: (text: string) => void;
};
function Player({
  detail,
  busy,
  run,
  reload,
  setNote,
}: Work & { detail: any }) {
  const [title, setTitle] = useState(""),
    [message, setMessage] = useState(""),
    [rewardId, setRewardId] = useState("ruby"),
    [amount, setAmount] = useState(100),
    [reason, setReason] = useState(""),
    [save, setSave] = useState<any>(null),
    [restore, setRestore] = useState<number | null>(null);
  const p = detail.player,
    base = `/players/${encodeURIComponent(p.id)}`;
  // A lost response must replay the original operation instead of delivering duplicate mail/restores.
  const operations = useRef<
    Record<string, { fingerprint: string; operationId: string }>
  >({});
  function operation(kind: string, body: unknown) {
    const fingerprint = JSON.stringify(body);
    if (operations.current[kind]?.fingerprint !== fingerprint)
      operations.current[kind] = {
        fingerprint,
        operationId: crypto.randomUUID(),
      };
    return {
      ...(body as object),
      operationId: operations.current[kind].operationId,
    };
  }
  useEffect(() => {
    setSave(null);
    setRestore(null);
    setReason("");
  }, [p.id]);
  return (
    <aside className="panel detail">
      <div className="eyebrow">PLAYER PROFILE</div>
      <h2>{p.display_name || p.id}</h2>
      <code>{p.id}</code>
      <dl>
        <dt>Cloud playtime</dt>
        <dd>
          {Math.floor(p.playtime / 3600)}h {Math.floor(p.playtime / 60) % 60}m
        </dd>
        <dt>Save status</dt>
        <dd>{p.save_state.replaceAll("_", " ")}</dd>
        <dt>Created</dt>
        <dd>{playerDate(p.created_at)}</dd>
      </dl>
      <h3>Linked accounts</h3>
      {detail.identities.map((i: any) => (
        <div className="identity" key={i.provider}>
          <strong>{i.provider}</strong>
          <code>{i.subject}</code>
        </div>
      ))}
      {detail.migration && (
        <>
          <h3>Migration</h3>
          <p>
            {detail.migration.status.replaceAll("_", " ")} ·{" "}
            {detail.migration.winner || "Awaiting import"}
          </p>
          {detail.migration.reason && (
            <div className="notice">
              {detail.migration.reason.replaceAll("_", " ")}
            </div>
          )}
        </>
      )}
      <h3>Save history</h3>
      <div className="revisions">
        {detail.revisions.map((r: any) => (
          <div key={r.version}>
            <span>
              v{r.version} · {date(r.created_at)} ·{" "}
              {(r.playtime / 3600).toFixed(1)}h
            </span>
            <button
              className="quiet"
              disabled={busy}
              onClick={() => setRestore(r.version)}
            >
              Restore
            </button>
          </div>
        ))}
        {!detail.revisions.length && (
          <p className="muted">No cloud save yet.</p>
        )}
      </div>
      {restore !== null && (
        <div className="notice">
          <p>
            Restore version {restore} as a new save revision? The current save
            remains in history.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api(
                  `${base}/restore`,
                  operation("restore", {
                    version: restore,
                    expectedSaveVersion: p.save_version,
                  }),
                );
                delete operations.current.restore;
                setRestore(null);
                await reload();
                setNote("Save restored as a new revision.");
              })
            }
          >
            Restore version {restore}
          </button>
          <button className="quiet" onClick={() => setRestore(null)}>
            Cancel
          </button>
        </div>
      )}
      <button
        className="quiet"
        disabled={busy || !p.save_version}
        onClick={() => run(async () => setSave(await api(`${base}/save`)))}
      >
        Inspect current save
      </button>
      {save && (
        <details open>
          <summary>Current save</summary>
          <pre>{format(save)}</pre>
        </details>
      )}
      <h3>Send in-game mail</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const request = operation("mail", {
            title,
            body: message,
            rewards: [{ id: rewardId, amount }],
          });
          run(async () => {
            await api(`${base}/mail`, request);
            delete operations.current.mail;
            setTitle("");
            setMessage("");
            setNote("Mail delivered to the EC1 inbox.");
            await reload();
          });
        }}
      >
        <label>
          Title
          <input
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Message
          <textarea
            required
            maxLength={8000}
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            Reward
            <select
              value={rewardId}
              onChange={(e) => {
                setRewardId(e.target.value);
                setAmount(Math.min(amount, rewardMaximum(e.target.value)));
              }}
            >
              <RewardOptions />
            </select>
          </label>
          <label>
            Amount
            <input
              type="number"
              required
              min={1}
              max={rewardMaximum(rewardId)}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </label>
        </div>
        <button disabled={busy}>Send mail</button>
      </form>
      <h3>Inbox history</h3>
      {detail.mail.map((m: any) => (
        <div className="mail" key={m.id}>
          <strong>{m.title}</strong>
          <span>
            {m.claimed_at ? "Claimed" : m.read_at ? "Read" : "Unread"}
          </span>
          <p>{m.body}</p>
          <small>{m.rewards_json}</small>
        </div>
      ))}
      {!detail.mail.length && <p className="muted">No mail.</p>}
      <h3>Account restriction</h3>
      {detail.ban && !detail.ban.revoked_at ? (
        <div className="notice">
          <p>{detail.ban.reason}</p>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api(`${base}/ban`, { revoked: true });
                await reload();
                setNote("Restriction revoked.");
              })
            }
          >
            Revoke restriction
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api(`${base}/ban`, { reason });
              await reload();
              setNote("Account restricted.");
            });
          }}
        >
          <label>
            Reason
            <input
              required
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button className="danger" disabled={busy}>
            Restrict account
          </button>
        </form>
      )}
    </aside>
  );
}
function Rewards({
  config,
  busy,
  run,
  reload,
  setNote,
}: Work & { config: any }) {
  const daily = config.config.find((c: any) => c.key === "daily_rewards");
  const [schedule, setSchedule] = useState(
      daily
        ? format(JSON.parse(daily.value_json).rewards)
        : '[\n  [{"id":"ruby","amount":10}],\n  [{"id":"gold","amount":1000}]\n]',
    ),
    [code, setCode] = useState(""),
    [reward, setReward] = useState("ruby"),
    [amount, setAmount] = useState(100),
    [enabled, setEnabled] = useState(false);
  return (
    <div className="workspace">
      <section className="panel detail">
        <h2>Daily rewards</h2>
        <p>
          Each row defines one day's rewards. The schedule repeats after the
          last row; claims use server time with a 24-hour cooldown.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api(
                "/config/daily",
                { rewards: JSON.parse(schedule) },
                "PUT",
              );
              await reload();
              setNote("Daily reward schedule saved.");
            });
          }}
        >
          <label>
            Reward schedule
            <textarea
              className="code-input"
              rows={15}
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            />
          </label>
          <button disabled={busy}>Save schedule</button>
        </form>
      </section>
      <section className="panel detail">
        <h2>Coupons</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api(
                `/coupons/${encodeURIComponent(code)}`,
                { rewards: [{ id: reward, amount }], enabled },
                "PUT",
              );
              await reload();
              setNote("Coupon saved.");
            });
          }}
        >
          <label>
            Code
            <input
              required
              pattern="[A-Za-z0-9_-]{1,64}"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <div className="form-row">
            <label>
              Reward
              <select
                value={reward}
                onChange={(e) => {
                  setReward(e.target.value);
                  setAmount(Math.min(amount, rewardMaximum(e.target.value)));
                }}
              >
                <RewardOptions />
              </select>
            </label>
            <label>
              Amount
              <input
                required
                type="number"
                min={1}
                max={rewardMaximum(reward)}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </label>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enable redemption
          </label>
          <button disabled={busy}>Save coupon</button>
        </form>
        <h3>Configured coupons</h3>
        {config.coupons.map((c: any) => (
          <div className="mail" key={c.code}>
            <strong>{c.code}</strong>
            <span>{c.enabled ? "Enabled" : "Disabled"}</span>
            <small>{c.rewards_json}</small>
          </div>
        ))}
        {!config.coupons.length && (
          <p className="muted">No coupons configured.</p>
        )}
      </section>
    </div>
  );
}
function ResetPassword() {
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [error, setError] = useState(""),
    [done, setDone] = useState(false),
    [busy, setBusy] = useState(false);
  const [token] = useState(() => {
    const value = new URLSearchParams(location.hash.slice(1)).get("token");
    history.replaceState(null, "", location.pathname);
    return value;
  });
  const [operationId] = useState(() => crypto.randomUUID());
  return (
    <main className="welcome">
      <div className="eyebrow">EPIC CONQUEST 1</div>
      <h1 style={{ fontSize: 42 }}>Reset your password</h1>
      {done ? (
        <>
          <p>
            Your EC1 password was updated. Return to the game and sign in again.
          </p>
          <p>Existing game sessions have been signed out.</p>
        </>
      ) : token ? (
        <form
          style={{ maxWidth: 440 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            if (password !== confirmation) {
              setError("The passwords do not match.");
              return;
            }
            setBusy(true);
            try {
              const response = await fetch("/api/recovery/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, password, operationId }),
              });
              const result: any = await response.json();
              if (!response.ok) throw new Error(result.error);
              setDone(true);
              setPassword("");
              setConfirmation("");
            } catch (e) {
              setError((e as Error).message.replaceAll("_", " "));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            New password
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            Confirm password
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={256}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <button disabled={busy}>
            {busy ? "Updating…" : "Update password"}
          </button>
        </form>
      ) : (
        <p>
          This reset link is incomplete. Request a new link from Epic Conquest
          1.
        </p>
      )}
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  location.pathname === "/reset-password" ? <ResetPassword /> : <App />,
);
