export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

export interface PlacementQuestion {
  id: number;
  level: CefrLevel;
  weight: number;
  promptRu: string;
  sentence: string;
  options: string[];
  correctIndex: number;
}

export const CEFR_DESCRIPTIONS: Record<
  CefrLevel,
  { label: string; title: string; deckNameRu: string; description: string }
> = {
  A1: {
    label: 'A1',
    title: 'Beginner (Начальный)',
    deckNameRu: 'Базовый старт (A1)',
    description: 'Самая важная повседневная лексика: утро, еда, семья, эмоции и простые путешествия.',
  },
  A2: {
    label: 'A2',
    title: 'Elementary (Базовый)',
    deckNameRu: 'Повседневный английский (A2)',
    description: 'Полезные глаголы и прилагательные для ежедневного общения, учёбы и планов.',
  },
  B1: {
    label: 'B1',
    title: 'Intermediate (Средний)',
    deckNameRu: 'Работа, поездки и планы (B1)',
    description: 'Слова и фразовые глаголы для рабочих задач, переписки и уверенных поездок.',
  },
  B2: {
    label: 'B2',
    title: 'Upper-Intermediate (Выше среднего)',
    deckNameRu: 'Уверенное общение и карьера (B2)',
    description: 'Точная лексика для переговоров, аналитики, командной работы и дискуссий.',
  },
  C1: {
    label: 'C1',
    title: 'Advanced (Продвинутый)',
    deckNameRu: 'Академический и продвинутый (C1)',
    description: 'Выразительные академические и публицистические слова для беглой точной речи.',
  },
};

export const PLACEMENT_QUESTIONS: PlacementQuestion[] = [
  {
    id: 1,
    level: 'A1',
    weight: 1,
    promptRu: 'Выберите правильную форму глагола:',
    sentence: 'She ___ to school by bus every morning.',
    options: ['go', 'goes', 'going', 'is go'],
    correctIndex: 1,
  },
  {
    id: 2,
    level: 'A1',
    weight: 1,
    promptRu: 'Подберите подходящее слово по смыслу:',
    sentence: 'We usually have ___ at 8 a.m. before leaving home.',
    options: ['breakfast', 'homework', 'bicycle', 'window'],
    correctIndex: 0,
  },
  {
    id: 3,
    level: 'A2',
    weight: 1.5,
    promptRu: 'Выберите правильное время глагола:',
    sentence: 'Yesterday I ___ a very interesting book from the library.',
    options: ['borrow', 'borrowed', 'borrowing', 'will borrow'],
    correctIndex: 1,
  },
  {
    id: 4,
    level: 'A2',
    weight: 1.5,
    promptRu: 'Выберите слово, близкое по значению к «улучшить»:',
    sentence: 'Reading articles every day will ___ your English.',
    options: ['decide', 'improve', 'forget', 'borrow'],
    correctIndex: 1,
  },
  {
    id: 5,
    level: 'B1',
    weight: 2,
    promptRu: 'Заполните пропуск устойчивым выражением:',
    sentence: 'I am really looking ___ to meeting the new team next week.',
    options: ['after', 'ahead', 'forward', 'about'],
    correctIndex: 2,
  },
  {
    id: 6,
    level: 'B1',
    weight: 2,
    promptRu: 'Выберите грамматически верный вариант:',
    sentence: 'If I ___ more free time, I would practice speaking every evening.',
    options: ['have', 'had', 'will have', 'would have'],
    correctIndex: 1,
  },
  {
    id: 7,
    level: 'B2',
    weight: 2.5,
    promptRu: 'Подберите точное прилагательное уровня B2:',
    sentence: 'Small teams often stay remarkably ___ even during sudden market changes.',
    options: ['resilient', 'fragile', 'crowded', 'obvious'],
    correctIndex: 0,
  },
  {
    id: 8,
    level: 'B2',
    weight: 2.5,
    promptRu: 'Выберите правильную конструкцию:',
    sentence: 'Not only ___ the deadline, but they also delivered extra documentation.',
    options: ['they met', 'did they meet', 'they did meet', 'met they'],
    correctIndex: 1,
  },
  {
    id: 9,
    level: 'C1',
    weight: 3,
    promptRu: 'Выберите слово со значением «повсеместный, вездесущий»:',
    sentence: 'Mobile payments have become ___ across major European cities.',
    options: ['ephemeral', 'ambiguous', 'ubiquitous', 'reluctant'],
    correctIndex: 2,
  },
  {
    id: 10,
    level: 'C1',
    weight: 3,
    promptRu: 'Подберите слово, означающее «тщательно проверять, изучать детали»:',
    sentence: 'Auditors had to ___ every clause of the international agreement.',
    options: ['scrutinize', 'neglect', 'postpone', 'improvise'],
    correctIndex: 0,
  },
];

export function evaluatePlacementTest(answers: Record<number, number>): {
  level: CefrLevel;
  correctCount: number;
  totalQuestions: number;
  weightedScore: number;
} {
  let correctCount = 0;
  let weightedScore = 0;
  const perLevelCorrect: Record<CefrLevel, number> = { A1: 0, A2: 0, B1: 0, B2: 0, C1: 0 };

  for (const q of PLACEMENT_QUESTIONS) {
    if (answers[q.id] === q.correctIndex) {
      correctCount++;
      weightedScore += q.weight;
      perLevelCorrect[q.level]++;
    }
  }

  let level: CefrLevel = 'A1';
  if (weightedScore >= 16.5 && perLevelCorrect.C1 >= 1) {
    level = 'C1';
  } else if (weightedScore >= 11.5 && (perLevelCorrect.B2 >= 1 || perLevelCorrect.C1 >= 1)) {
    level = 'B2';
  } else if (weightedScore >= 7.0 && (perLevelCorrect.B1 >= 1 || perLevelCorrect.B2 >= 1)) {
    level = 'B1';
  } else if (weightedScore >= 3.0) {
    level = 'A2';
  } else {
    level = 'A1';
  }

  return {
    level,
    correctCount,
    totalQuestions: PLACEMENT_QUESTIONS.length,
    weightedScore: Number(weightedScore.toFixed(1)),
  };
}
