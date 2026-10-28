import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActivityProps } from "@kukui/core/types";
import { bandMessage, percentage, resolveScoring } from "@kukui/core/scoring";
import { ActivityHeader } from "@kukui/core";
import {
  answerLists,
  answerText,
  isComplete,
  isCorrect,
  promptParts,
  type LeaderboardQuizConfig, type LeaderboardQuizQuestion } from "./schema.js";
import "./Component.css";

type Stage = "start" | "playing" | "done";

/** Learner-generated, device-local cache. No student ID, name, or email. */
type PersonalRecord = {
  bestScore: number;
  bestTimeMs: number;
  attempts: number;
  lastAttemptAt: string;
};

const FEEDBACK_MS = 1200;

const DEFAULT_STRINGS: Record<string, string> = {
  start: "Start",
  submit: "Submit",
  timesUp: "Time's up!",
  savedNotice: "Your best score is saved on this device only.",
  clearRecord: "Clear my saved record",
  playAgain: "Play again",
};

// ponytail: keyed by title, not a config hash — two quizzes with the same title share a record.
const recordKey = (config: LeaderboardQuizConfig) => `leaderboardquiz:${config.title}`;

function loadRecord(key: string): PersonalRecord | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as PersonalRecord | null;
  } catch {
    return null;
  }
}

function saveRecord(key: string, rec: PersonalRecord) {
  try {
    localStorage.setItem(key, JSON.stringify(rec));
  } catch {
    /* localStorage unavailable (private mode): the record is a nice-to-have */
  }
}

export function Component({ config, onSubmit, headingLevel = 1 }: ActivityProps<LeaderboardQuizConfig>) {
  const t = (k: string) => config.strings?.[k] ?? DEFAULT_STRINGS[k] ?? k;
  const scoring = useMemo(() => resolveScoring(config, { mode: "points" }), [config]);
  const headingId = useId();
  const key = recordKey(config);

  const [stage, setStage] = useState<Stage>("start");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(config.topics.map((x) => x.id)));
  const [deck, setDeck] = useState<LeaderboardQuizQuestion[]>([]);
  const [idx, setIdx] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [left, setLeft] = useState(config.round.timeLimitSeconds);
  const [answers, setAnswers] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; q: LeaderboardQuizQuestion } | null>(null);
  const [record, setRecord] = useState<PersonalRecord | null>(() => loadRecord(key));
  const startedAt = useRef(0);

  // Reset when config changes externally (Studio Preview edits, draft load).
  useEffect(() => {
    setStage("start");
    setPicked(new Set(config.topics.map((x) => x.id)));
    setRecord(loadRecord(key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const showMenu = (config.round.topicSelection ?? "learner-choice") === "learner-choice" && config.topics.length > 1;
  const activeTopics = showMenu ? picked : new Set(config.topics.map((x) => x.id));
  const pool = useMemo(
    () => config.questions.filter((q) => activeTopics.has(q.topicId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.questions, showMenu, picked],
  );

  const start = () => {
    const d = pool.slice();
    if (config.round.shuffle ?? true) d.sort(() => Math.random() - 0.5);
    setDeck(d.slice(0, config.round.questionCount));
    setIdx(0);
    setCorrect(0);
    setLeft(config.round.timeLimitSeconds);
    setAnswers([]);
    setResult(null);
    startedAt.current = Date.now();
    setStage("playing");
  };

  const finish = () => {
    if (stage !== "playing") return;
    const elapsed = Date.now() - startedAt.current;
    const raw = correct * config.pointsPerCorrect;
    const max = deck.length * config.pointsPerCorrect;
    const prev = loadRecord(key);
    const better = !prev || raw > prev.bestScore || (raw === prev.bestScore && elapsed < prev.bestTimeMs);
    const next: PersonalRecord = {
      bestScore: better ? raw : prev!.bestScore,
      bestTimeMs: better ? elapsed : prev!.bestTimeMs,
      attempts: (prev?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
    };
    saveRecord(key, next);
    setRecord(next);
    setResult(null);
    setStage("done");
    onSubmit({
      raw,
      max,
      success: scoring.mode === "completion" || percentage({ raw, max }) >= scoring.passPercentage,
    });
  };

  // Countdown.
  useEffect(() => {
    if (stage !== "playing") return;
    const id = setInterval(() => setLeft((l) => l - 1), 1000);
    return () => clearInterval(id);
  }, [stage]);
  useEffect(() => {
    if (stage === "playing" && left <= 0) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, stage]);

  // After feedback shows, move on (or finish on the last question).
  useEffect(() => {
    if (!result) return;
    const id = setTimeout(() => {
      setResult(null);
      setAnswers([]);
      if (idx + 1 >= deck.length) finish();
      else setIdx(idx + 1);
    }, FEEDBACK_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const submitAnswer = (e: React.FormEvent) => {
    e.preventDefault();
    const q = deck[idx];
    if (!q || result || !isComplete(q, answers)) return;
    const ok = isCorrect(q, answers);
    if (ok) setCorrect((c) => c + 1);
    setResult({ ok, q });
  };

  const toggleTopic = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const clearRecord = () => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
    setRecord(null);
  };

  const recordLine = record
    ? `Your best: ${record.bestScore} pts in ${Math.round(record.bestTimeMs / 1000)}s (${record.attempts} ${record.attempts === 1 ? "attempt" : "attempts"}).`
    : "No saved record yet.";

  const q = deck[idx];
  const parts = q ? promptParts(q) : null;
  const answerInputs = q
    ? answerLists(q).map((_, i) => (
        <input
          key={i}
          className={["kukui-tq__input", result ? (result.ok ? "is-correct" : "is-incorrect") : ""].filter(Boolean).join(" ")}
          value={answers[i] ?? ""}
          onChange={(e) => setAnswers((a) => Object.assign([...a], { [i]: e.target.value }))}
          readOnly={!!result}
          aria-label={answerLists(q).length > 1 ? `Blank ${i + 1}` : "Your answer"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus={i === 0}
        />
      ))
    : [];
  const max = deck.length * config.pointsPerCorrect;
  const raw = correct * config.pointsPerCorrect;

  return (
    <div className="kukui-tq">
      <article className="kukui-tq__card" aria-labelledby={headingId}>
        <ActivityHeader
          title={config.title}
          titleId={headingId}
          headingLevel={headingLevel}
          variant={config.appearance?.header ?? "full"}
        />

        {stage === "start" ? (
          <>
            {showMenu ? (
              <div className="kukui-tq__chips" role="group" aria-label="Topics">
                {config.topics.map((tp) => (
                  <button
                    key={tp.id}
                    type="button"
                    className="kukui-tq__chip"
                    aria-pressed={picked.has(tp.id)}
                    onClick={() => toggleTopic(tp.id)}
                  >
                    {picked.has(tp.id) ? "✓ " : ""}
                    {tp.label}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="kukui-tq__meta">
              {recordLine} {t("savedNotice")}
            </p>
            <div className="kukui-tq__actions">
              <button type="button" className="kukui-tq__primary" disabled={pool.length === 0} onClick={start}>
                {t("start")}
              </button>
              {record ? (
                <button type="button" className="kukui-tq__secondary" onClick={clearRecord}>
                  {t("clearRecord")}
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {stage === "playing" && q ? (
          <>
            <div className="kukui-tq__bar">
              <span>
                Question {idx + 1} of {deck.length}
              </span>
              <span>{raw} pts</span>
              <span role="timer">{Math.max(left, 0)}s left</span>
            </div>
            {parts ? null : <p className="kukui-tq__prompt">{q.prompt}</p>}
            {q.image ? <img className="kukui-tq__image" src={q.image.src} alt={q.image.alt} draggable={false} /> : null}
            <form className="kukui-tq__form" onSubmit={submitAnswer}>
              {parts ? (
                <p className="kukui-tq__prompt kukui-tq__blank">
                  {parts.map((text, i) => (
                    <Fragment key={i}>
                      {text}
                      {answerInputs[i]}
                    </Fragment>
                  ))}
                </p>
              ) : (
                answerInputs
              )}
              <button type="submit" className="kukui-tq__primary" disabled={!!result || !isComplete(q, answers)}>
                {t("submit")}
              </button>
            </form>
            {/* Always rendered so the feedback row never reflows the card. */}
            <p
              className={["kukui-tq__feedback", result ? "is-visible" : ""].filter(Boolean).join(" ")}
              role="status"
              aria-live="polite"
            >
              {result
                ? result.ok
                  ? `✓ Correct. ${result.q.feedbackCorrect ?? ""}`
                  : `✗ Incorrect. Answer: ${answerText(result.q)}. ${result.q.feedbackIncorrect ?? ""}`
                : ""}
            </p>
          </>
        ) : null}

        {stage === "done" ? (
          <>
            <output className="kukui-tq__score">
              {left <= 0 ? `${t("timesUp")} ` : ""}
              {raw} / {max} pts
              {(() => {
                const band = bandMessage(scoring.bands, percentage({ raw, max }));
                return band ? <span className="kukui-tq__band"> · {band}</span> : null;
              })()}
            </output>
            <p className="kukui-tq__meta">{recordLine}</p>
            <div className="kukui-tq__actions">
              {scoring.enableRetry ? (
                <button type="button" className="kukui-tq__primary" onClick={() => setStage("start")}>
                  {t("playAgain")}
                </button>
              ) : null}
              <button type="button" className="kukui-tq__secondary" onClick={clearRecord}>
                {t("clearRecord")}
              </button>
            </div>
          </>
        ) : null}
      </article>
    </div>
  );
}

type Credit = NonNullable<NonNullable<LeaderboardQuizQuestion["image"]>["attribution"]>;

const link = (href: string | undefined, text: string) =>
  href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  ) : (
    text
  );

/** Footer credit line for a question image; shared with the Live variant. */
export function ImageCredit({ credit, className }: { credit: Credit; className: string }) {
  const { author, authorUrl, sourceUrl, license, licenseUrl } = credit;
  return (
    <footer className={className}>
      Image by {link(authorUrl, author)}
      {sourceUrl ? <> · {link(sourceUrl, "View original")}</> : null}
      {license ? <> · {link(licenseUrl, license)}</> : null}
    </footer>
  );
}

export default Component;
