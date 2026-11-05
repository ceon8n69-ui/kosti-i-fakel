import { useCallback, useEffect, useState } from "react";
import { unlockAudio } from "../audio/sound";
import { t, tk } from "../i18n";
import { ApiError, get, post } from "../lib/api";
import { haptic, setBack, shareLink } from "../lib/telegram";

interface Member {
  userId: string;
  name: string;
  ready: boolean;
  hero: { id: string; name: string; classId: string; level: number } | null;
}
interface TableView {
  id: string;
  isHost: boolean;
  biome: string;
  mode: "live" | "async";
  status: "lobby" | "started" | "closed";
  sessionId: string | null;
  joined: boolean;
  members: Member[];
  inviteUrl: string | null;
}

/** Стол партии: до 4 игроков, у каждого свой герой. Опрос раз в 2 с — лобби живёт недолго. */
export function Lobby({ tableId, userId, heroId, onPlay, onClose }: { tableId: string; userId: string; heroId: string | null; onPlay: (sid: string) => void; onClose: () => void }) {
  const [v, setV] = useState<TableView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await get<TableView>(`/tables/${tableId}`);
      setV(r);
      if (r.status === "started" && r.sessionId && r.members.some((m) => m.userId === userId && m.hero)) onPlay(r.sessionId);
    } catch (e) {
      setErr(e instanceof ApiError ? tk(`err.${e.code}`) : t("err.generic"));
    }
  }, [tableId, userId, onPlay]);

  useEffect(() => {
    setBack(onClose);
    void load();
    const iv = setInterval(() => void load(), 2000);
    return () => {
      clearInterval(iv);
      setBack(null);
    };
  }, [load, onClose]);

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ sessionId?: string }>(`/tables/${tableId}/${path}`, body);
      haptic("tap");
      if (r.sessionId) {
        unlockAudio();
        onPlay(r.sessionId);
      } else await load();
    } catch (e) {
      haptic("error");
      setErr(e instanceof ApiError ? tk(`err.${e.code}`) : t("err.generic"));
    } finally {
      setBusy(false);
    }
  };

  if (!v) return <p className="muted">{err ?? t("app.loading")}</p>;
  const me = v.members.find((m) => m.userId === userId);
  const seated = v.members.filter((m) => m.hero);
  const allReady = seated.length > 0 && seated.every((m) => m.ready || (v.isHost && m.userId === userId));
  const closed = v.status === "closed" || (v.status === "started" && !me?.hero);

  return (
    <section className="card lobby">
      <div
        className="lobby-head"
        style={{ backgroundImage: `linear-gradient(rgba(10,6,3,.3), rgba(10,6,3,.9)), url(/art/ground/${v.biome}.jpg)` }}
      >
        <div className="label">{t("party.title")}</div>
        <b>{tk(`biome.${v.biome}`)}</b>
        <span>
          {seated.length}/4 · {v.mode === "live" ? t("party.live") : t("party.async")}
        </span>
      </div>
      {closed && <p className="err">{t("party.closed")}</p>}
      <ul className="seats">
        {[0, 1, 2, 3].map((i) => {
          const m = v.members[i];
          if (!m)
            return (
              <li key={i} className="seat empty">
                <span className="seat-ic">＋</span>
                <span className="muted">{t("party.empty")}</span>
              </li>
            );
          return (
            <li key={m.userId} className={`seat ${m.ready ? "ready" : ""}`}>
              {m.hero ? <img src={`/art/minis/${m.hero.classId}.webp`} alt="" onError={(e) => { const i = e.target as HTMLImageElement; if (i.src.endsWith(".webp")) i.src = i.src.replace(/\.webp$/, ".png"); else i.style.visibility = "hidden"; }} /> : <span className="seat-ic">?</span>}
              <div className="grow">
                <b>
                  {m.name}
                  {m.userId === userId ? ` (${t("party.you")})` : ""}
                </b>
                <span>{m.hero ? `${m.hero.name} · ${tk(`class.${m.hero.classId}`)} · ${t("tavern.level")} ${m.hero.level}` : t("party.noHero")}</span>
              </div>
              <span className="seat-st">{v.isHost && m.userId === userId ? "👑" : m.ready ? "✓" : "…"}</span>
            </li>
          );
        })}
      </ul>
      {err && <p className="err">{err}</p>}
      {v.status === "lobby" && (
        <div className="lobby-actions">
          {v.inviteUrl && seated.length < 4 && (
            <button className="btn-ghost wide" onClick={() => shareLink(v.inviteUrl!, t("party.shareText"))}>
              📨 {t("party.invite")}
            </button>
          )}
          {heroId && me?.hero?.id !== heroId && (
            <button className="btn wide" disabled={busy} onClick={() => void act("join", { heroId })}>
              {me?.hero ? t("party.switchHero") : t("party.join")}
            </button>
          )}
          {me?.hero && !v.isHost && (
            <button className="btn wide" disabled={busy} onClick={() => void act("ready", { ready: !me.ready })}>
              {me.ready ? t("party.unready") : t("party.ready")}
            </button>
          )}
          {v.isHost && (
            <button className="btn wide" disabled={busy || !allReady || !me?.hero} onClick={() => void act("start")}>
              🔥 {allReady ? t("party.start") : t("party.waiting")}
            </button>
          )}
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={async () => {
              if (me) await act("leave");
              onClose();
            }}
          >
            {v.isHost ? t("party.disband") : t("party.leave")}
          </button>
        </div>
      )}
      {!heroId && <p className="muted small">{t("party.needHero")}</p>}
    </section>
  );
}
