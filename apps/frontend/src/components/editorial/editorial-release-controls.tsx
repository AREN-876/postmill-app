'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@postmill-ai/react/form/button';
import type { EditorialReviewSnapshot } from './editorial-review-panel';
import {
  canOfferEditorialRelease,
  editorialReleaseClient,
  type EditorialReleaseMode,
  type ReleasePreview,
} from './editorial-release-client';

type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;
type Props = {
  postId: string;
  taskId: string;
  snapshot: EditorialReviewSnapshot;
  fetcher: Fetcher;
  mutationsBlocked: boolean;
  onReleaseAttempt: () => void;
};

// The whole three-part story is ONE Postmill/MAX publication.
// This view cannot be mounted until the dormant review session is enabled.
export function EditorialReleaseControls({
  postId, taskId, snapshot, fetcher, mutationsBlocked, onReleaseAttempt,
}: Props) {
  const eligible = canOfferEditorialRelease(snapshot);
  const api = useMemo(() => editorialReleaseClient(fetcher), [fetcher]);
  const [preview, setPreview] = useState<ReleasePreview | null>(null);
  const [reading, setReading] = useState(false);
  const [failedRead, setFailedRead] = useState(false);
  const [choice, setChoice] = useState<EditorialReleaseMode | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    if (!eligible || sending) return;
    setReading(true);
    setFailedRead(false);
    setPreview(null);
    setChoice(null);
    try {
      setPreview(await api.preview(postId, taskId));
    } catch {
      setFailedRead(true);
      setNotice('Не удалось проверить разрешение на выпуск. Отправка заблокирована.');
    } finally {
      setReading(false);
    }
  }, [eligible, sending, api, postId, taskId]);

  useEffect(() => {
    if (eligible) void refresh();
  }, [eligible, refresh]);

  if (!eligible) return null;

  const canSubmit = preview?.ready === true && preview.status === 'available' &&
    !failedRead && !reading && !sending && !mutationsBlocked;

  async function submit() {
    if (!choice || !canSubmit || (choice === 'queue' && !preview?.next_slot)) return;
    const action = choice;
    const publishAt = action === 'queue' ? preview.next_slot.publishAt : null;
    setChoice(null);
    setSending(true);
    // Freeze before POST. An unknown result must never lead to a fresh click
    // or automatic retry. Reconcile via GET only.
    onReleaseAttempt();
    try {
      const result = await api.submit(postId, taskId, {
        command_id: crypto.randomUUID(),
        action,
        publish_at: publishAt,
      });
      setNotice(result.created
        ? 'Команда выпуска записана в Postmill. Доставка в MAX ещё не подтверждена.'
        : 'Этот выпуск уже существует. Новая публикация не создана.');
    } catch {
      setNotice('Результат выпуска неизвестен. Не отправляй повторно: проверь состояние (только чтение).');
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-label="Выпуск утверждённой истории" className="space-y-3">
      <h3 className="text-lg font-semibold">Выпуск утверждённой истории</h3>
      <p>Все три части отправляются вместе как одна история. Одобрение само по себе ничего не публикует.</p>
      {reading && <p role="status">Проверка разрешения на выпуск…</p>}
      {preview?.status === 'already_released' && (
        <p role="status">История уже передана в публикацию. Повторный выпуск запрещён.</p>
      )}
      {preview?.status === 'not_finally_approved' && (
        <p role="status">Окончательное одобрение ещё не подтверждено.</p>
      )}
      {preview?.status === 'available' && (
        <>
          {preview.next_slot
            ? <p>Ближайший свободный слот для всей истории: <strong>{preview.next_slot.localTime} МСК</strong>.</p>
            : <p>Слоты очереди не настроены или заняты. Публикация сейчас остаётся доступной.</p>}
          <div className="flex gap-2 flex-wrap">
            <Button secondary type="button" disabled={!canSubmit} onClick={() => setChoice('publish_now')}>
              Опубликовать сейчас
            </Button>
            {preview.next_slot && (
              <Button secondary type="button" disabled={!canSubmit} onClick={() => setChoice('queue')}>
                Добавить в очередь
              </Button>
            )}
          </div>
        </>
      )}
      {choice && canSubmit && (
        <div role="group" aria-label="Подтвердить выпуск истории">
          <p>{choice === 'publish_now'
            ? 'Подтверди выпуск всех трёх частей сейчас.'
            : `Подтверди выпуск всех трёх частей ${preview?.next_slot?.localTime} МСК.`}</p>
          <div className="flex flex-wrap gap-2">
            <Button danger className="border border-red-500/40" type="button" onClick={() => void submit()}>
              Подтвердить выпуск
            </Button>
            <Button secondary type="button" onClick={() => setChoice(null)}>Отмена</Button>
          </div>
        </div>
      )}
      {mutationsBlocked && preview?.status !== 'already_released' && (
        <p role="status">Повторная отправка заблокирована до выяснения состояния предыдущей команды.</p>
      )}
      {notice && <p role="status">{notice}</p>}
      <Button secondary type="button" disabled={sending || reading}
        onClick={() => void refresh()}>
        Проверить выпуск (только чтение)
      </Button>
    </section>
  );
}
