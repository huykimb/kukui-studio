import { z } from "zod";
import { ScoringSchema, AppearanceSchema } from "@kukui/schemas/shared";

const versionRe = /^\d+\.\d+(\.\d+)?$/;

/**
 * Leaderboard Quiz.
 *
 * Learning objective: "Recall and examine medical terms, disease names, and
 * anatomical structures accurately, under time pressure, across a set of
 * instructor-defined topics."
 *
 * Engine (async, single-learner) shape only. Live leaderboard, typo
 * tolerance, and the accommodations time multiplier are designed in
 * docs/superpowers/specs/2026-10-7-leaderboard-quiz-design.md but not built yet.
 */
export const LeaderboardQuizConfigSchema = z
  .object({
    _comment: z.string().optional(),
    version: z.string().regex(versionRe),
    title: z.string().min(1),
    author: z.string().optional(),
    topics: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]*$/, "topic id must be kebab-case"),
            label: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    questions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            topicId: z.string().min(1),
            prompt: z.string().min(1),
            /** Exact-match answers (after normalization). Authors add synonyms here. */
            acceptedAnswers: z.array(z.string().min(1)).min(1),
            feedbackCorrect: z.string().optional(),
            feedbackIncorrect: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    round: z
      .object({
        /** Questions drawn per attempt (capped at the size of the selected pool). */
        questionCount: z.number().int().min(1),
        shuffle: z.boolean().optional(),
        topicSelection: z.enum(["author-fixed", "learner-choice"]).optional(),
        /** One countdown for the whole round. */
        timeLimitSeconds: z.number().int().min(1),
      })
      .strict(),
    /** Flat award per correct answer; no partial credit. */
    pointsPerCorrect: z.number().int().min(1),
    /** Instructor-editable learner-facing strings; built-in English defaults apply. */
    strings: z.record(z.string(), z.string()).optional(),
    scoring: ScoringSchema.optional(),
    /** Live classroom session keys; Studio auto-generates joinKey/adminKey. */
    live: z
      .object({
        joinKey: z.string().min(4).max(64).optional(),
        adminKey: z.string().min(4).max(64).optional(),
        signaling: z.enum(["nostr", "mqtt"]).optional(),
        relayUrls: z.array(z.string().url()).max(8).optional(),
      })
      .strict()
      .optional(),
    appearance: AppearanceSchema.default({ theme: "auto" }),
  })
  .strict()
  // Zod can't express cross-references natively; check them here so a typo'd
  // topicId fails validation instead of silently dropping the question.
  .superRefine((cfg, ctx) => {
    const ids = new Set(cfg.topics.map((t) => t.id));
    cfg.questions.forEach((q, i) => {
      if (!ids.has(q.topicId)) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", i, "topicId"],
          message: `topicId "${q.topicId}" does not match any topic id`,
        });
      }
    });
  });

export type LeaderboardQuizConfig = z.infer<typeof LeaderboardQuizConfigSchema>;
export type LeaderboardQuizQuestion = LeaderboardQuizConfig["questions"][number];

/**
 * Same normalization on both sides of the comparison: lowercase, strip
 * punctuation, collapse whitespace. Runtime-only; never written back to config.
 */
export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
