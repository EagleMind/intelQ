import { describe, expect, it } from 'vitest';
import type { SavedQuestion } from '../types/api';
import {
  filterQuestions,
  findMatches,
  NEAR_MATCH,
  scoreQuestion,
  STRONG_MATCH,
  tokenize,
} from './questionMatch';

const sq = (question: string, extra: Partial<SavedQuestion> = {}): SavedQuestion => ({
  id: question,
  connection_id: 'c1',
  question,
  aliases: [],
  sql: 'SELECT 1',
  source: 'ai',
  run_count: 0,
  last_run_at: null,
  created_at: '2026-11-01 10:00:00',
  updated_at: '2026-11-01 10:00:00',
  ...extra,
});

describe('tokenize', () => {
  it('drops filler words and punctuation, stems plurals', () => {
    expect([...tokenize('Show me all the orders from last week!')].sort()).toEqual(
      ['last', 'order', 'week'].sort()
    );
  });

  it('keeps @table tags whole', () => {
    const t = tokenize('count @order_items per day');
    expect(t.has('@order_items')).toBe(true);
    expect(t.has('count')).toBe(true);
  });

  it('is deterministic and case-insensitive', () => {
    expect([...tokenize('Weekly German ORDERS')]).toEqual([...tokenize('weekly german orders')]);
  });
});

describe('findMatches', () => {
  const saved = [
    sq('Orders last week'),
    sq('Weekly German orders', { aliases: ['orders from germany this week'] }),
    sq('Top 10 customers by revenue'),
  ];

  it('treats rephrasings with the same content words as a strong match', () => {
    const m = findMatches('show me the orders from last week', saved);
    expect(m[0]?.question.question).toBe('Orders last week');
    expect(m[0]?.score).toBe(1);
  });

  it('matches through stored aliases', () => {
    const m = findMatches('Orders from Germany this week', saved);
    expect(m[0]?.question.question).toBe('Weekly German orders');
  });

  it('does not match a different question', () => {
    expect(findMatches('average delivery time per carrier', saved)).toEqual([]);
  });

  it('treats different numbers as different questions', () => {
    expect(scoreQuestion('top 5 customers by revenue', saved[2])).toBeLessThan(STRONG_MATCH);
  });

  it('treats a different time qualifier as a different question', () => {
    expect(scoreQuestion('orders this week', saved[0])).toBeLessThan(STRONG_MATCH);
    expect(scoreQuestion('orders not shipped last week', saved[0])).toBeLessThan(STRONG_MATCH);
  });

  it('returns near matches with a lower threshold', () => {
    expect(findMatches('orders by week', saved)).toEqual([]);
    const m = findMatches('orders by week', saved, NEAR_MATCH);
    expect(m.map(x => x.question.question)).toContain('Orders last week');
  });

  it('breaks score ties by run count', () => {
    const a = sq('orders', { id: 'a', run_count: 1 });
    const b = sq('orders', { id: 'b', run_count: 9 });
    expect(findMatches('orders', [a, b]).map(x => x.question.id)).toEqual(['b', 'a']);
  });

  it('returns nothing for blank input', () => {
    expect(findMatches('   ', saved)).toEqual([]);
  });
});

describe('filterQuestions', () => {
  const saved = [sq('Orders last week'), sq('Revenue by month', { aliases: ['monthly sales'] })];

  it('returns everything for an empty query', () => {
    expect(filterQuestions('', saved)).toHaveLength(2);
  });

  it('matches substrings and aliases', () => {
    expect(filterQuestions('rev', saved).map(q => q.question)).toEqual(['Revenue by month']);
    expect(filterQuestions('sales', saved).map(q => q.question)).toEqual(['Revenue by month']);
  });
});
