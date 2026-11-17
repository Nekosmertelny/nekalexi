import { describe, it, expect } from 'vitest';
import { parseWordListInput } from '../server/dictionary.ts';

describe('Custom Word List Parser (CSV / TXT / JSON)', () => {
  it('parses plain text lines with dash separators and deduplicates', () => {
    const input = `
      ephemeral - мимолетный
      ubiquitous — повсеместный
      ephemeral - дубликат
      resilient
    `;
    const parsed = parseWordListInput(input, 'txt');
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({
      word: 'ephemeral',
      translation: 'мимолетный',
      partOfSpeech: undefined,
      exampleEn: undefined,
      exampleRu: undefined,
    });
    expect(parsed[1].translation).toBe('повсеместный');
    expect(parsed[2].word).toBe('resilient');
  });

  it('parses CSV with headers and quoted commas', () => {
    const csv = `word,translation,partOfSpeech,exampleEn,exampleRu
"mitigate","смягчать, снижать",verb,"We mitigate risks.","Мы снижаем риски."
feasible,выполнимый,adjective,,`;
    const parsed = parseWordListInput(csv, 'csv');
    expect(parsed).toHaveLength(2);
    expect(parsed[0].word).toBe('mitigate');
    expect(parsed[0].translation).toBe('смягчать, снижать');
    expect(parsed[0].exampleEn).toBe('We mitigate risks.');
    expect(parsed[1].word).toBe('feasible');
  });

  it('parses JSON array of objects and strings', () => {
    const json = JSON.stringify([
      'iterate',
      { word: 'bottleneck', translation: 'узкое место', partOfSpeech: 'noun' },
    ]);
    const parsed = parseWordListInput(json, 'json');
    expect(parsed).toHaveLength(2);
    expect(parsed[0].word).toBe('iterate');
    expect(parsed[1].translation).toBe('узкое место');
  });
});
