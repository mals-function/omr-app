import { describe, expect, it } from 'vitest';

import {
  buildSections,
  grade,
  layoutSignature,
  questions
} from '../src/model';

const sections = buildSections([
  {
    name: 'Multiple choice',
    type: 'MCQ',
    keyText: 'A,B,C',
    points: 1,
    penalty: 0
  },
  {
    name: 'True or False',
    type: 'TF',
    keyText: 'T,F',
    points: 2,
    penalty: 0
  }
]);

const exam = { sections };

describe('mixed exam scoring', () => {
  it('flattens sections in order', () => {
    expect(questions(exam).map(item => item.correct))
      .toEqual(['A', 'B', 'C', 'T', 'F']);
  });

  it('awards full marks', () => {
    const result = grade(['A', 'B', 'C', 'T', 'F'], exam);

    expect(result.score).toBe(7);
    expect(result.maxScore).toBe(7);
    expect(result.percentage).toBe(100);
  });

  it('uses section-specific points', () => {
    const result = grade(['A', 'D', '', 'T', 'T'], exam);

    expect(result.score).toBe(3);
    expect(result.maxScore).toBe(7);
  });

  it('rejects uncertain answers', () => {
    expect(() => grade(['?', 'B', 'C', 'T', 'F'], exam)).toThrow();
  });

  it('rejects mismatched answer counts', () => {
    expect(() => grade(['A'], exam)).toThrow();
  });

  it('keeps blanks at zero and clamps negative scores', () => {
    const penalized = {
      sections: buildSections([
        {
          name: 'Test',
          type: 'MCQ',
          keyText: 'A,A',
          points: 1,
          penalty: 2
        }
      ])
    };

    expect(grade(['', ''], penalized).score).toBe(0);
    expect(grade(['B', 'MULTIPLE'], penalized).score).toBe(0);
  });

  it('rejects keys using invalid options', () => {
    expect(() => buildSections([
      {
        name: 'TF',
        type: 'TF',
        keyText: 'A,B',
        points: 1,
        penalty: 0
      }
    ])).toThrow();
  });

  it('does not treat answer changes as layout changes', () => {
    const changed = sections.map(section => ({
      ...section,
      key: [...section.key].reverse()
    }));

    expect(layoutSignature(changed)).toBe(layoutSignature(sections));
  });
});