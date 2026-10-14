import { useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
import type { LiveRoomHandle, Presence } from "@kukui/live";
import {
  normalizeAnswer,
  type LeaderboardQuizConfig,
  type LeaderboardQuizQuestion,
} from "@kukui/activities/leaderboard-quiz/schema";
import type { LiveActivityManifest, LiveActivityProps } from "./types.js";
import { usePhase } from "../usePhase.js";
import { useLeaderboardQuiz, type RankedEntry } from "./useLeaderboardQuiz.js";
import "./LiveCommon.css";
import "./LeaderboardQuizLive.css";

const FEEDBACK_MS = 1200;

type Status = "idle" | "playing" | "finished";

export type LeaderboardQuizLiveProps = {
  room: LiveRoomHandle;
  presence: Map<string, Presence>;
  role: "instructor" | "student";
  config: LeaderboardQuizConfig;
  onLeave: () => void;
};

function Board({ ranked, myId, limit }: { ranked: RankedEntry[]; myId: string; limit?: number }) {
  const rows = limit ? ranked.slice(0, limit) : ranked;
  if (rows.length === 0) return <p className="kukui-live-status">No scores yet.</p>;
  return (
    <ol className="kukui-lq__board" aria-label="Leaderboard">
      {rows.map((r) => (
        <li key={r.id} className={r.id === myId ? "kukui-lq__row is-me" : "kukui-lq__row"}>
          <span className="kukui-lq__rank">{r.rank}</span>
          <span className="kukui-lq__name">
            {r.displayName}
            {r.id === myId ? " (you)" : ""}
          </span>
          <span className="kukui-lq__score">{r.score} pts</span>
          <span className="kukui-lq__state">
            {r.finishedAt === null ? "playing…" : `${Math.round(r.elapsedMs / 1000)}s`}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function LeaderboardQuizLive({ room, presence, role, config, onLeave }: LeaderboardQuizLiveProps) {
  const { phase, setPhase } = usePhase(room, role);
  const { ranked, report, clearAll } = useLeaderboardQuiz(room, role);
  const myName = presence.get(room.participantId)?.name ?? "Student";

  const [status, setStatus] = useState<Status>("idle");
  const [deck, setDeck] = useState<LeaderboardQuizQuestion[]>([]);
  const [idx, setIdx] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [answer, setAnswer] = useState("");
  const [fb, setFb] = useState<{ ok: boolean; q: LeaderboardQuizQuestion } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const startedAt = useRef(0);

  const limitMs = config.round.timeLimitSeconds * 1000;
  const elapsed = Math.min(now - startedAt.current, limitMs);
  const left = Math.max(0, Math.ceil((limitMs - elapsed) / 1000));

  const finish = (finalCorrect: number) => {
    if (status !== "playing") return;
    const ms = Math.min(Date.now() - startedAt.current, limitMs);
    report({
      displayName: myName,
      score: finalCorrect * config.pointsPerCorrect,
      elapsedMs: ms,
      finishedAt: Date.now(),
    });
    setFb(null);
    setStatus("finished");
  };

  // Student: the instructor opening the question starts everyone's round.
  // ponytail: each student's clock starts when they receive the phase change, so peers can skew by network latency; a shared epoch in room state would remove it.
  useEffect(() => {
    if (role !== "student") return;
    if (phase === "question" && status === "idle") {
      const d = config.questions.slice();
      if (config.round.shuffle ?? true) d.sort(() => Math.random() - 0.5);
      setDeck(d.slice(0, config.round.questionCount));
      setIdx(0);
      setCorrect(0);
      setAnswer("");
      setFb(null);
      startedAt.current = Date.now();
      setNow(Date.now());
      setStatus("playing");
    } else if (phase === "lobby" && status !== "idle") {
      setStatus("idle");
    } else if (phase !== "question" && phase !== "lobby" && status === "playing") {
      // Instructor closed the round early.
      finish(correct);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, status, role]);

  // Countdown + time-up.
  useEffect(() => {
    if (status !== "playing") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [status]);
  useEffect(() => {
    if (status === "playing" && left <= 0) finish(correct);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, status]);

  // After feedback, advance or finish.
  useEffect(() => {
    if (!fb) return;
    const id = setTimeout(() => {
      setFb(null);
      setAnswer("");
      if (idx + 1 >= deck.length) finish(correct);
      else setIdx(idx + 1);
    }, FEEDBACK_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fb]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = deck[idx];
    if (!q || fb || answer.trim() === "") return;
    const ok = q.acceptedAnswers.some((a) => normalizeAnswer(a) === normalizeAnswer(answer));
    const next = correct + (ok ? 1 : 0);
    setCorrect(next);
    setFb({ ok, q });
    // Live-updating board: publish the running score after every answer.
    report({
      displayName: myName,
      score: next * config.pointsPerCorrect,
      elapsedMs: Math.min(Date.now() - startedAt.current, limitMs),
      finishedAt: null,
    });
  };

  const header = (
    <div className="live-brand">
      <img className="live-logo" src="/kukui-logo.svg" alt="" aria-hidden="true" />
      <h1 className="live-title">{config.title}</h1>
    </div>
  );

  if (role === "instructor") {
    const students = [...presence.values()].filter((p) => p.role === "student").length;
    const finished = ranked.filter((r) => r.finishedAt !== null).length;
    const reset = () => {
      if (!window.confirm("Reset and clear all scores? This can't be undone.")) return;
      clearAll();
      setPhase("lobby");
    };
    return (
      <div className="live-shell">
        <article className="live-card live-card--wide">
          {header}
          <p className="live-subtitle">
            {students} student{students === 1 ? "" : "s"} connected · {finished} finished
          </p>
          <Board ranked={ranked} myId={room.participantId} />
          <div className="kukui-live-controls" aria-label="Leaderboard Quiz controls">
            {phase === "lobby" ? (
              <button type="button" className="live-btn live-btn--primary" onClick={() => setPhase("question")}>
                Start round
              </button>
            ) : null}
            {phase === "question" ? (
              <button type="button" className="live-btn live-btn--primary" onClick={() => setPhase("reveal")}>
                End round &amp; show results
              </button>
            ) : null}
            {phase === "reveal" ? (
              <button type="button" className="live-btn live-btn--primary" onClick={() => setPhase("ended")}>
                End activity
              </button>
            ) : null}
            {phase !== "lobby" ? (
              <button type="button" className="live-btn live-btn--ghost" onClick={reset}>
                Reset
              </button>
            ) : null}
            <button type="button" className="live-btn live-btn--ghost" onClick={onLeave}>
              Leave room
            </button>
          </div>
        </article>
      </div>
    );
  }

  const q = deck[idx];
  const mine = ranked.find((r) => r.id === room.participantId);

  return (
    <div className="live-shell">
      <article className="live-card live-card--wide">
        {header}

        {status === "idle" ? (
          <div className="kukui-live-status" role="status" aria-live="polite">
            Waiting for the instructor to start the round…
          </div>
        ) : null}

        {status === "playing" && q ? (
          <>
            <div className="kukui-lq__bar">
              <span>
                Question {idx + 1} of {deck.length}
              </span>
              <span>{correct * config.pointsPerCorrect} pts</span>
              <span role="timer">{left}s left</span>
            </div>
            <section className="kukui-live-prompt">
              <p>{q.prompt}</p>
            </section>
            <form className="kukui-lq__form" onSubmit={submit}>
              <input
                className={["kukui-lq__input", fb ? (fb.ok ? "is-correct" : "is-incorrect") : ""]
                  .filter(Boolean)
                  .join(" ")}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                readOnly={!!fb}
                aria-label="Your answer"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
              />
              <button type="submit" className="live-btn live-btn--primary" disabled={!!fb || answer.trim() === ""}>
                Submit
              </button>
            </form>
            {/* Always rendered so feedback never reflows the card. */}
            <p className="kukui-lq__feedback" role="status" aria-live="polite">
              {fb
                ? fb.ok
                  ? `✓ Correct. ${fb.q.feedbackCorrect ?? ""}`
                  : `✗ Incorrect. Answer: ${fb.q.acceptedAnswers[0]}. ${fb.q.feedbackIncorrect ?? ""}`
                : ""}
            </p>
          </>
        ) : null}

        {status === "finished" ? (
          <p className="kukui-live-status" role="status" aria-live="polite">
            {phase === "question"
              ? "You're done. Waiting for the round to end…"
              : "Round over."}{" "}
            {mine ? `You scored ${mine.score} pts (rank ${mine.rank} of ${ranked.length}).` : ""}
          </p>
        ) : null}

        {status !== "idle" || phase === "reveal" || phase === "ended" ? (
          <Board ranked={ranked} myId={room.participantId} limit={10} />
        ) : null}

        <div className="live-actions" style={{ marginTop: 16 }}>
          <button type="button" className="live-btn live-btn--ghost" onClick={onLeave}>
            Leave room
          </button>
        </div>
      </article>
    </div>
  );
}

export const liveActivity: LiveActivityManifest<"leaderboard-quiz"> = {
  kind: "leaderboard-quiz",
  Component: LeaderboardQuizLive as ComponentType<LiveActivityProps>,
};
