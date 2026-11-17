import React, { useCallback, useEffect, useState } from 'react';
import {
  Search,
  Plus,
  Upload,
  Volume2,
  Trash2,
  Download,
  BookCopy,
  Sparkles,
  PenTool,
  Image as ImageIcon,
  RefreshCw,
} from 'lucide-react';
import { motion } from 'motion/react';
import { apiRequest, downloadDeckCsv } from '../api/client.ts';
import type { Deck, WordItem } from '../types/index.ts';
import { speakEnglish } from '../utils/speech.ts';

interface VocabularyManagerProps {
  decks: Deck[];
  userCefrLevel?: string;
  onRefreshDecks: () => void;
  onPracticeWord: (word: string) => void;
}

export const VocabularyManager: React.FC<VocabularyManagerProps> = ({
  decks,
  userCefrLevel = 'A2',
  onRefreshDecks,
  onPracticeWord,
}) => {
  const [words, setWords] = useState<WordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [deckFilter, setDeckFilter] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'list' | 'add' | 'import' | 'decks'>('list');

  // Add single word state
  const [newWord, setNewWord] = useState('');
  const [newTranslation, setNewTranslation] = useState('');
  const [newPhonetic, setNewPhonetic] = useState('');
  const [newPos, setNewPos] = useState('noun');
  const [posManuallyChanged, setPosManuallyChanged] = useState(false);
  const [newExampleEn, setNewExampleEn] = useState('');
  const [newExampleRu, setNewExampleRu] = useState('');
  const [newImageUrl, setNewImageUrl] = useState('');
  const [newWordCefr, setNewWordCefr] = useState(userCefrLevel || 'B1');
  const [newDeckId, setNewDeckId] = useState<string>('');
  const [lookingUp, setLookingUp] = useState(false);
  const [savingWord, setSavingWord] = useState(false);
  const [refreshingImageId, setRefreshingImageId] = useState<number | null>(null);
  const [brokenImages, setBrokenImages] = useState<Record<number, boolean>>({});

  // Batch import state
  const [importText, setImportText] = useState('');
  const [importDeckTitle, setImportDeckTitle] = useState('');
  const [importFormat, setImportFormat] = useState<'txt' | 'csv' | 'json'>('txt');
  const [importing, setImporting] = useState(false);

  // New deck state
  const [deckTitle, setDeckTitle] = useState('');
  const [deckCategory, setDeckCategory] = useState('Повседневное');
  const [deckCefr, setDeckCefr] = useState(userCefrLevel || 'A2');
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  const loadWords = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (deckFilter !== 'all') params.set('deckId', deckFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (search.trim()) params.set('search', search.trim());
      const data = await apiRequest<{ words: WordItem[] }>(`/api/words?${params.toString()}`);
      setWords(data.words);
    } catch (err) {
      setFeedbackMsg(err instanceof Error ? err.message : 'Не удалось загрузить словарь');
    } finally {
      setLoading(false);
    }
  }, [deckFilter, statusFilter, search]);

  useEffect(() => {
    const t = setTimeout(() => {
      loadWords();
    }, 180);
    return () => clearTimeout(t);
  }, [loadWords]);

  const handleDictionaryLookup = async () => {
    if (!newWord.trim()) return;
    setLookingUp(true);
    setFeedbackMsg(null);
    try {
      const lookupParams = new URLSearchParams({ word: newWord.trim() });
      if (posManuallyChanged && newPos) {
        lookupParams.set('pos', newPos);
      }
      const res = await apiRequest<{
        dictionary: { phonetic: string; partOfSpeech: string };
        enriched: {
          translation: string;
          phonetic: string;
          partOfSpeech: string;
          exampleEn: string;
          exampleRu: string;
          cefrLevel?: string;
        };
        imageUrl?: string;
      }>(`/api/words/lookup?${lookupParams.toString()}`);

      setNewTranslation(res.enriched.translation || '');
      setNewPhonetic(res.dictionary.phonetic || res.enriched.phonetic || '');
      setNewPos(res.enriched.partOfSpeech || res.dictionary.partOfSpeech || 'noun');
      setNewExampleEn(res.enriched.exampleEn || '');
      setNewExampleRu(res.enriched.exampleRu || '');
      if (res.enriched.cefrLevel) setNewWordCefr(res.enriched.cefrLevel);
      setNewImageUrl(res.imageUrl || '');
    } catch (err) {
      setFeedbackMsg(err instanceof Error ? err.message : 'Ошибка поиска в словаре');
    } finally {
      setLookingUp(false);
    }
  };

  const handleSaveWord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWord.trim()) return;
    setSavingWord(true);
    setFeedbackMsg(null);
    try {
      await apiRequest('/api/words', {
        method: 'POST',
        body: JSON.stringify({
          word: newWord.trim(),
          translation: newTranslation.trim() || undefined,
          phonetic: newPhonetic.trim() || undefined,
          partOfSpeech: posManuallyChanged ? newPos : undefined,
          exampleEn: newExampleEn.trim() || undefined,
          exampleRu: newExampleRu.trim() || undefined,
          deckId: newDeckId ? Number(newDeckId) : undefined,
          cefrLevel: newWordCefr,
          imageUrl: newImageUrl || undefined,
        }),
      });
      setNewWord('');
      setNewTranslation('');
      setNewPhonetic('');
      setNewPos('noun');
      setPosManuallyChanged(false);
      setNewExampleEn('');
      setNewExampleRu('');
      setNewImageUrl('');
      setFeedbackMsg('Слово добавлено с переводом, примерами и реальной фотографией.');
      setActiveTab('list');
      loadWords();
      onRefreshDecks();
    } catch (err) {
      setFeedbackMsg(err instanceof Error ? err.message : 'Ошибка сохранения слова');
    } finally {
      setSavingWord(false);
    }
  };

  const handleRefreshWordImage = async (wordId: number) => {
    setRefreshingImageId(wordId);
    setFeedbackMsg(null);
    try {
      const res = await apiRequest<{ imageUrl: string }>(`/api/words/${wordId}/refresh-image`, {
        method: 'POST',
      });
      if (res.imageUrl) {
        setWords((prev) => prev.map((w) => (w.id === wordId ? { ...w, image_url: res.imageUrl } : w)));
        setBrokenImages((prev) => ({ ...prev, [wordId]: false }));
      } else {
        setFeedbackMsg('Не удалось подобрать другую подходящую фотографию.');
      }
    } catch (err) {
      setFeedbackMsg(err instanceof Error ? err.message : 'Не удалось обновить фото');
    } finally {
      setRefreshingImageId(null);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.name.endsWith('.csv')) setImportFormat('csv');
    else if (file.name.endsWith('.json')) setImportFormat('json');
    else setImportFormat('txt');

    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result || ''));
      if (!importDeckTitle) {
        setImportDeckTitle(file.name.replace(/\.[^.]+$/, ''));
      }
    };
    reader.readAsText(file);
  };

  const handleBatchImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importText.trim()) return;
    setImporting(true);
    setFeedbackMsg(null);
    try {
      const res = await apiRequest<{ importedCount: number }>('/api/words/import', {
        method: 'POST',
        body: JSON.stringify({
          rawContent: importText,
          format: importFormat,
          deckTitle: importDeckTitle.trim() || 'Загруженный список',
        }),
      });
      setImportText('');
      setImportDeckTitle('');
      setFeedbackMsg(`Импортировано слов: ${res.importedCount}. К каждому сгенерирован перевод и примеры!`);
      setActiveTab('list');
      loadWords();
      onRefreshDecks();
    } catch (err) {
      setFeedbackMsg(err instanceof Error ? err.message : 'Ошибка импорта списка');
    } finally {
      setImporting(false);
    }
  };

  const handleCreateDeck = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deckTitle.trim()) return;
    setFeedbackMsg(null);
    try {
      await apiRequest('/api/decks', {
        method: 'POST',
        body: JSON.stringify({ title: deckTitle.trim(), category: deckCategory, cefrLevel: deckCefr }),
      });
      setDeckTitle('');
      setFeedbackMsg('Новая колода создана.');
      onRefreshDecks();
    } catch (err) {
      setFeedbackMsg(err instanceof Error ? err.message : 'Не удалось создать колоду');
    }
  };

  const handleCloneDeck = async (deckId: number) => {
    setFeedbackMsg(null);
    try {
      const res = await apiRequest<{ added: number }>(`/api/decks/${deckId}/clone`, { method: 'POST' });
      setFeedbackMsg(`Добавлено новых слов из подборки: ${res.added}`);
      loadWords();
      onRefreshDecks();
    } catch (err) {
      setFeedbackMsg(err instanceof Error ? err.message : 'Не удалось добавить подборку');
    }
  };

  const handleDeleteWord = async (wordId: number) => {
    setFeedbackMsg(null);
    try {
      await apiRequest(`/api/words/${wordId}`, { method: 'DELETE' });
      setWords((prev) => prev.filter((w) => w.id !== wordId));
      onRefreshDecks();
    } catch (err) {
      setFeedbackMsg(err instanceof Error ? err.message : 'Не удалось удалить слово');
    }
  };

  const statusLabels: Record<string, string> = {
    new: 'Новое',
    learning: 'Изучается',
    review: 'Повторение',
    mastered: 'Выучено',
  };

  return (
    <div className="space-y-6">
      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg overflow-x-auto">
          {(
            [
              { id: 'list', label: 'Мой словарь' },
              { id: 'add', label: 'Добавить слово' },
              { id: 'import', label: 'Загрузка списка' },
              { id: 'decks', label: 'Колоды и экспорт' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`relative px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'text-slate-900 dark:text-white font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {activeTab === tab.id && (
                <motion.span
                  layoutId="vocab-subtab-pill"
                  transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  className="absolute inset-0 rounded-md bg-white dark:bg-slate-900 shadow-sm"
                />
              )}
              <span className="relative z-10">{tab.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setActiveTab('add')}
          className="min-h-[40px] px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>Новое слово</span>
        </button>
      </div>

      {feedbackMsg && (
        <div className="p-3.5 rounded-xl bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800 text-xs sm:text-sm text-sky-900 dark:text-sky-200">
          {feedbackMsg}
        </div>
      )}

      {activeTab === 'list' && (
        <div className="space-y-4">
          {/* Search & Filters */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-6 relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск по английскому слову или переводу..."
                className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-sky-600"
              />
            </div>

            <div className="md:col-span-3">
              <select
                value={deckFilter}
                onChange={(e) => setDeckFilter(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
              >
                <option value="all">Все колоды</option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-3">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
              >
                <option value="all">Любой статус</option>
                <option value="new">Новые</option>
                <option value="learning">Изучаются</option>
                <option value="review">На повторении</option>
                <option value="mastered">Выучены</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className="py-12 text-center text-sm text-slate-400">Загрузка словаря...</div>
          ) : words.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center">
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
                По вашему запросу слова не найдены. Добавьте новое слово или загрузите список.
              </p>
              <button
                type="button"
                onClick={() => setActiveTab('add')}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-sky-600 text-white text-sm font-medium"
              >
                Добавить первое слово
              </button>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl divide-y divide-slate-100 dark:divide-slate-800">
              {words.map((w) => (
                <div
                  key={w.id}
                  className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-start justify-between gap-4 hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors"
                >
                  <div className="flex items-start gap-3.5 flex-1 min-w-0">
                    {w.image_url && !brokenImages[w.id] ? (
                      <div className="relative group w-16 h-14 sm:w-20 sm:h-16 rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 shrink-0">
                        <img
                          src={w.image_url}
                          alt={w.word}
                          referrerPolicy="no-referrer"
                          onError={() => setBrokenImages((prev) => ({ ...prev, [w.id]: true }))}
                          className="w-full h-full object-cover"
                        />
                        <button
                          type="button"
                          disabled={refreshingImageId === w.id}
                          onClick={() => handleRefreshWordImage(w.id)}
                          title="Подобрать другое реальное фото"
                          className="absolute bottom-1 right-1 w-6 h-6 rounded-md bg-slate-900/75 hover:bg-slate-900 text-white flex items-center justify-center opacity-85 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity disabled:opacity-60"
                        >
                          <RefreshCw className={`w-3 h-3 ${refreshingImageId === w.id ? 'animate-spin' : ''}`} />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={refreshingImageId === w.id}
                        onClick={() => handleRefreshWordImage(w.id)}
                        title="Подобрать реальное фото"
                        className="w-16 h-14 sm:w-20 sm:h-16 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 hover:border-sky-500 text-slate-400 hover:text-sky-600 flex flex-col items-center justify-center gap-1 text-[10px] shrink-0 transition-colors"
                      >
                        <ImageIcon className="w-4 h-4" />
                        <span>{refreshingImageId === w.id ? '...' : 'Фото'}</span>
                      </button>
                    )}

                    <div className="space-y-1.5 flex-1 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2.5">
                        <span className="font-display text-lg font-bold text-slate-900 dark:text-white">
                          {w.word}
                        </span>
                        {w.phonetic && (
                          <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                            {w.phonetic}
                          </span>
                        )}
                        <span className="text-sm font-semibold text-sky-600 dark:text-sky-400">
                          — {w.translation}
                        </span>
                      </div>

                      <div className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-2 tabular-nums">
                        <span>{w.part_of_speech}</span>
                        <span aria-hidden="true">·</span>
                        <span>Уровень {w.cefr_level}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            w.status === 'mastered'
                              ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                              : w.status === 'learning'
                              ? 'text-amber-600 dark:text-amber-400 font-medium'
                              : 'text-slate-600 dark:text-slate-300'
                          }
                        >
                          {statusLabels[w.status]}
                        </span>
                        {w.deck_title && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{w.deck_title}</span>
                          </>
                        )}
                      </div>

                      {w.example_en && (
                        <div className="pt-1.5 space-y-0.5">
                          <p className="text-sm text-slate-800 dark:text-slate-200">{w.example_en}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">{w.example_ru}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => speakEnglish(w.word, w.audio_url)}
                      title="Произнести слово"
                      className="min-h-[40px] min-w-[40px] rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300"
                    >
                      <Volume2 className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onPracticeWord(w.word)}
                      title="Практиковать в предложении"
                      className="min-h-[40px] px-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-200"
                    >
                      <PenTool className="w-3.5 h-3.5 text-sky-600" />
                      <span>Практика</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteWord(w.id)}
                      title="Удалить слово"
                      className="min-h-[40px] min-w-[40px] rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 flex items-center justify-center text-slate-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'add' && (
        <form
          onSubmit={handleSaveWord}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-2xl space-y-4"
        >
          <div>
            <h2 className="font-display text-lg font-bold">Добавить слово в словарь</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Используйте кнопку автопоиска, чтобы получить транскрипцию из Dictionary API, перевод и двуязычные примеры от ИИ. Если оставить поля пустыми, они заполнятся автоматически при сохранении.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-2.5">
            <input
              type="text"
              required
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              placeholder="Например: improve или schedule"
              className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm focus:outline-none focus:ring-2 focus:ring-sky-600"
            />
            <button
              type="button"
              disabled={lookingUp || !newWord.trim()}
              onClick={handleDictionaryLookup}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-semibold flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4 text-sky-600" />
              <span>{lookingUp ? 'Поиск...' : 'Найти перевод и примеры'}</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Перевод на русский
              </label>
              <input
                type="text"
                value={newTranslation}
                onChange={(e) => setNewTranslation(e.target.value)}
                placeholder="Автоматически, если пусто"
                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Транскрипция (IPA)
              </label>
              <input
                type="text"
                value={newPhonetic}
                onChange={(e) => setNewPhonetic(e.target.value)}
                placeholder="/.../"
                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-mono"
              />
            </div>
          </div>

          {newImageUrl && (
            <div className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/40">
              <img
                src={newImageUrl}
                alt={newWord}
                referrerPolicy="no-referrer"
                className="w-20 h-16 rounded-lg object-cover border border-slate-200 dark:border-slate-700"
              />
              <div className="text-xs text-slate-600 dark:text-slate-300">
                <div className="font-semibold text-slate-900 dark:text-white">Реальная фотография</div>
                <div>Будет прикреплена к карточке для визуального запоминания</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Часть речи
              </label>
              <select
                value={newPos}
                onChange={(e) => {
                  setNewPos(e.target.value);
                  setPosManuallyChanged(true);
                }}
                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
              >
                <option value="noun">noun (существительное)</option>
                <option value="verb">verb (глагол)</option>
                <option value="adjective">adjective (прилагательное)</option>
                <option value="adverb">adverb (наречие)</option>
                <option value="idiom">idiom (идиома)</option>
                <option value="phrasal verb">phrasal verb (фразовый глагол)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Уровень CEFR
              </label>
              <select
                value={newWordCefr}
                onChange={(e) => setNewWordCefr(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
              >
                <option value="A1">A1</option>
                <option value="A2">A2</option>
                <option value="B1">B1</option>
                <option value="B2">B2</option>
                <option value="C1">C1</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Колода
              </label>
              <select
                value={newDeckId}
                onChange={(e) => setNewDeckId(e.target.value)}
                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
              >
                <option value="">Без колоды (Общий словарь)</option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Пример на английском
            </label>
            <input
              type="text"
              value={newExampleEn}
              onChange={(e) => setNewExampleEn(e.target.value)}
              placeholder="Сгенерируется автоматически, если оставить пустым"
              className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Перевод примера на русский
            </label>
            <input
              type="text"
              value={newExampleRu}
              onChange={(e) => setNewExampleRu(e.target.value)}
              placeholder="Сгенерируется автоматически, если оставить пустым"
              className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={savingWord}
            className="min-h-[44px] px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors"
          >
            {savingWord ? 'Обогащение через Dictionary + ИИ...' : 'Сохранить слово в словарь'}
          </button>
        </form>
      )}

      {activeTab === 'import' && (
        <form
          onSubmit={handleBatchImport}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 max-w-2xl space-y-4"
        >
          <div>
            <h2 className="font-display text-lg font-bold">Загрузка собственного списка слов</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Загрузите файл `.csv`, `.txt` или `.json`, либо вставьте слова построчно (до 30 слов за раз). Для каждого слова автоматически подтянутся транскрипция, перевод и примеры на английском и русском.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Название новой колоды
              </label>
              <input
                type="text"
                value={importDeckTitle}
                onChange={(e) => setImportDeckTitle(e.target.value)}
                placeholder="Например: Собеседование в IT"
                className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Загрузить файл (.csv, .txt, .json)
              </label>
              <label className="min-h-[42px] px-3 py-2 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer flex items-center justify-center gap-2 text-xs font-medium">
                <Upload className="w-4 h-4 text-sky-600" />
                <span>Выбрать файл с устройства</span>
                <input
                  type="file"
                  accept=".csv,.txt,.json"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Содержимое списка (по одному слову или «слово - перевод»)
            </label>
            <textarea
              rows={7}
              required
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={`improve - улучшать\nschedule\ndecide - решать\nreliable`}
              className="w-full p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-600"
            />
          </div>

          <button
            type="submit"
            disabled={importing}
            className="min-h-[44px] px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-60 text-white text-sm font-semibold transition-colors"
          >
            {importing ? 'Импорт и генерация примеров...' : 'Импортировать список'}
          </button>
        </form>
      )}

      {activeTab === 'decks' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-8 space-y-3">
            {[...decks]
              .sort((a, b) => {
                const aRec = a.is_curated === 1 && a.cefr_level === userCefrLevel ? 1 : 0;
                const bRec = b.is_curated === 1 && b.cefr_level === userCefrLevel ? 1 : 0;
                return bRec - aRec;
              })
              .map((d) => {
                const isRecommended = d.is_curated === 1 && d.cefr_level === userCefrLevel;
                return (
                  <div
                    key={d.id}
                    className={`bg-white dark:bg-slate-900 border rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                      isRecommended
                        ? 'border-sky-300 dark:border-sky-800 ring-1 ring-sky-500/15'
                        : 'border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-display font-bold text-base">{d.title}</h3>
                        {isRecommended && (
                          <span className="text-xs text-emerald-700 dark:text-emerald-400 font-semibold">
                            · Под ваш уровень {userCefrLevel}
                          </span>
                        )}
                        {d.is_curated === 1 && !isRecommended && (
                          <span className="text-xs text-sky-600 dark:text-sky-400 font-medium">
                            · Подборка редакции
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{d.description || d.category}</p>
                      <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        {d.category} · Уровень {d.cefr_level} · В вашем словаре: {d.word_count} (к повторению: {d.due_count})
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {d.is_curated === 1 && (
                        <button
                          type="button"
                          onClick={() => handleCloneDeck(d.id)}
                          className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5"
                        >
                          <BookCopy className="w-3.5 h-3.5 text-sky-600" />
                          <span>Добавить себе</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => downloadDeckCsv(d.id, `${d.title}.csv`)}
                        className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>CSV</span>
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>

          <form
            onSubmit={handleCreateDeck}
            className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 h-fit space-y-3.5"
          >
            <h3 className="font-display font-bold text-base">Создать новую колоду</h3>
            <input
              type="text"
              required
              value={deckTitle}
              onChange={(e) => setDeckTitle(e.target.value)}
              placeholder="Название колоды"
              className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
            />
            <input
              type="text"
              value={deckCategory}
              onChange={(e) => setDeckCategory(e.target.value)}
              placeholder="Тематика"
              className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
            />
            <select
              value={deckCefr}
              onChange={(e) => setDeckCefr(e.target.value)}
              className="w-full min-h-[42px] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm"
            >
              <option value="A1">Уровень A1</option>
              <option value="A2">Уровень A2</option>
              <option value="B1">Уровень B1</option>
              <option value="B2">Уровень B2</option>
              <option value="C1">Уровень C1</option>
              <option value="C2">Уровень C2</option>
            </select>
            <button
              type="submit"
              className="w-full min-h-[44px] rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold"
            >
              Создать колоду
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
