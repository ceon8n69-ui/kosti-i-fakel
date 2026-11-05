import { parseStartParam, type UserProfile } from "@kf/schema";
import { useCallback, useEffect, useState } from "react";
import { setLocale, t } from "./i18n";
import { login } from "./lib/api";
import { haptic, tg } from "./lib/telegram";

type State =
  | { s: "loading" }
  | { s: "outside" }
  | { s: "error" }
  | { s: "ready"; user: UserProfile; startParam: string | null };

export function App() {
  const [state, setState] = useState<State>({ s: "loading" });

  const run = useCallback(async () => {
    const w = tg();
    if (!w) return setState({ s: "outside" });
    setState({ s: "loading" });
    try {
      const r = await login(w.initData);
      setLocale(r.user.language);
      setState({ s: "ready", user: r.user, startParam: r.startParam });
      haptic("success");
    } catch {
      setState({ s: "error" });
      haptic("error");
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <main className="screen">
      <div className="torch" aria-hidden />
      <h1 className="title">{t("app.title")}</h1>
      {state.s === "loading" && <p className="muted">{t("app.loading")}</p>}
      {state.s === "outside" && <p className="muted">{t("app.outsideTelegram")}</p>}
      {state.s === "error" && (
        <>
          <p className="muted">{t("app.authFailed")}</p>
          <button className="btn" onClick={() => void run()}>
            {t("app.retry")}
          </button>
        </>
      )}
      {state.s === "ready" && <Profile user={state.user} startParam={state.startParam} />}
    </main>
  );
}

function Profile({ user, startParam }: { user: UserProfile; startParam: string | null }) {
  const sp = parseStartParam(startParam);
  const initial = (user.firstName[0] ?? "?").toUpperCase();
  return (
    <section className="card">
      <div className="portrait" aria-hidden>
        {initial}
      </div>
      <div className="label">{t("profile.heading")}</div>
      <div className="name">
        {user.firstName}
        {user.lastName ? ` ${user.lastName}` : ""}
      </div>
      {user.username && <div className="muted">@{user.username}</div>}
      <div className="stats">
        <div>
          <b>{user.authorLevel}</b>
          <span>{t("profile.authorLevel")}</span>
        </div>
        <div>
          <b>{user.fame}</b>
          <span>{t("profile.fame")}</span>
        </div>
      </div>
      <div className="muted small">
        {t("profile.since")} {new Date(user.createdAt).toLocaleDateString("ru-RU")}
      </div>
      {sp && (
        <div className="muted small">
          {t("invite.opened")}: {sp.kind} {sp.id}
        </div>
      )}
      <p className="muted small">{t("profile.soon")}</p>
    </section>
  );
}
