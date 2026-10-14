import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { LiveRoomHandle } from "@kukui/live";

/**
 * Y.js binding for the Leaderboard Quiz.
 *
 * One Y.Map keyed by participantId → LeaderboardEntry. Each student only
 * ever writes their own key, so there are no write conflicts. State is
 * O(participants) and lives in memory only: the map is cleared when the
 * instructor resets, and no Y.js persistence provider is attached (see the
 * retention note in the design spec). No student ID is broadcast; the
 * participantId is the Live session key.
 */
const SCORES_KEY = "leaderboard-quiz-scores";

export type LeaderboardEntry = {
  displayName: string;
  score: number;
  elapsedMs: number;
  /** Epoch ms when the student finished, or null while still playing. */
  finishedAt: number | null;
};

export type RankedEntry = LeaderboardEntry & { id: string; rank: number };

/** Score desc, then earliest finisher (unfinished last), then fastest time. */
export function rankEntries(entries: Iterable<[string, LeaderboardEntry]>): RankedEntry[] {
  return [...entries]
    .sort(
      ([, a], [, b]) =>
        b.score - a.score ||
        (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity) ||
        a.elapsedMs - b.elapsedMs,
    )
    .map(([id, e], i) => ({ ...e, id, rank: i + 1 }));
}

/** Peers can send anything; accept only well-formed entries. */
function parse(v: unknown): LeaderboardEntry | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (
    typeof e.displayName !== "string" ||
    typeof e.score !== "number" ||
    typeof e.elapsedMs !== "number" ||
    !(e.finishedAt === null || typeof e.finishedAt === "number")
  ) {
    return null;
  }
  return {
    displayName: e.displayName.slice(0, 40),
    score: e.score,
    elapsedMs: e.elapsedMs,
    finishedAt: e.finishedAt as number | null,
  };
}

function read(map: Y.Map<LeaderboardEntry>): RankedEntry[] {
  const out: [string, LeaderboardEntry][] = [];
  map.forEach((v, k) => {
    const e = parse(v);
    if (e) out.push([k, e]);
  });
  return rankEntries(out);
}

export function useLeaderboardQuiz(
  room: LiveRoomHandle,
  role: "instructor" | "student",
): {
  ranked: RankedEntry[];
  report(entry: LeaderboardEntry): void;
  clearAll(): void;
} {
  const map = room.doc.getMap<LeaderboardEntry>(SCORES_KEY);
  const [ranked, setRanked] = useState(() => read(map));

  useEffect(() => {
    const handler = () => setRanked(read(map));
    map.observe(handler);
    return () => map.unobserve(handler);
  }, [map]);

  return {
    ranked,
    report: (entry) => {
      room.doc.transact(() => map.set(room.participantId, entry));
    },
    clearAll: () => {
      // Local speed-bump only: in P2P mode a modified client can still write.
      if (role !== "instructor") return;
      room.doc.transact(() => map.clear());
    },
  };
}
