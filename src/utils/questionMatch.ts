// ---------------------------------------------------------------------------
// Deterministic matching of a typed question against saved questions.
// No AI: same input, same result, every time.
// ---------------------------------------------------------------------------

import type { SavedQuestion } from '../types/api';

/** Score at or above which we offer "You've asked this before". */
export const STRONG_MATCH = 0.6;
/** Score at or above which a saved question is worth suggesting after a refusal. */
export const NEAR_MATCH = 0.35;

// Filler words that don't change what is being asked.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'in', 'on', 'at', 'to', 'from', 'by', 'with',
  'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been', 'me', 'my', 'our', 'us',
  'we', 'i', 'you', 'your', 'please', 'can', 'could', 'would', 'will', 'show',
  'give', 'get', 'find', 'tell', 'display', 'list', 'see', 'want', 'need',
  'what', 'which', 'do', 'does', 'did', 'there', 'it', 'its', 'that',
  'these', 'those', 'all', 'some', 'any', 'just', 'let', 'lets',
]);

// Words that change the answer even when everything else matches:
// "orders this week" ≠ "orders last week", "top 5" ≠ "top 10".
const QUALIFIERS = new Set([
  'last', 'previous', 'prior', 'next', 'this', 'current', 'now', 'today',
  'yesterday', 'tomorrow', 'not', 'no', 'without', 'except', 'exclud', 'exclude',
]);

/** Score multiplier when numbers or qualifiers differ — keeps it out of "strong". */
const QUALIFIER_PENALTY = 0.6;

function qualifiers(tokens: Set<string>): string {
  return [...tokens].filter(t => /^\d+$/.test(t) || QUALIFIERS.has(t)).sort().join(' ');
}

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Lowercase, keep `@table` tags whole, drop punctuation and filler, light stemming. */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/@(\w+)/g)) tokens.add(`@${m[1]}`);
  const words = lower.replace(/@\w+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ');
  for (const w of words) {
    if (!w || STOPWORDS.has(w)) continue;
    tokens.add(stem(w));
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity in [0, 1] between a typed text and one saved question (best of name + aliases). */
export function scoreQuestion(text: string, q: SavedQuestion): number {
  const typed = tokenize(text);
  const typedQualifiers = qualifiers(typed);
  let best = 0;
  for (const phrase of [q.question, ...q.aliases]) {
    const tokens = tokenize(phrase);
    let score = jaccard(typed, tokens);
    if (qualifiers(tokens) !== typedQualifiers) score *= QUALIFIER_PENALTY;
    best = Math.max(best, score);
    if (best === 1) break;
  }
  return best;
}

export interface QuestionMatch {
  question: SavedQuestion;
  score: number;
}

/** Saved questions scoring at least `minScore`, best first (ties: most-run first). */
export function findMatches(
  text: string,
  questions: SavedQuestion[],
  minScore = STRONG_MATCH
): QuestionMatch[] {
  if (!text.trim()) return [];
  return questions
    .map(question => ({ question, score: scoreQuestion(text, question) }))
    .filter(m => m.score >= minScore)
    .sort((a, b) => b.score - a.score || b.question.run_count - a.question.run_count);
}

/** Loose filter for the Saved panel search box: substring or any shared token. */
export function filterQuestions(query: string, questions: SavedQuestion[]): SavedQuestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return questions;
  const typed = tokenize(q);
  return questions.filter(sq => {
    const phrases = [sq.question, ...sq.aliases];
    if (phrases.some(p => p.toLowerCase().includes(q))) return true;
    return phrases.some(p => [...tokenize(p)].some(t => typed.has(t)));
  });
}
