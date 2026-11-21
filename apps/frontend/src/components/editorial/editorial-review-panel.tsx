'use client';

import { useEffect, useState } from 'react';

// Presentation only: this component has no network client or production route.
// A future session-authenticated caller must supply server-verified snapshots
// and a cookie/CSRF-protected command callback.
export type EditorialReviewSnapshot = {
  post_id: string;
  task_id: string;
  content: { title: string; parts: string[] };
  review_acknowledged: boolean;
  review: {
    status: string;
    last_confirmed_state?: {
      seq: string;
      image_mode?: string;
    } | null;
  } | null;
  remote_current_verified: boolean;
  dispatch_authorized: false;
  publishable: false;
};

export type EditorialHumanAction =
  | 'approve_text'
  | 'request_text_changes'
  | 'reject'
  | 'request_image';

export type EditorialHumanCommand = {
  command_id: string;
  expected_seq: string;
  action: EditorialHumanAction;
  feedback: string;
};

export type EditorialQueueReceipt = {
  status: string;
  dispatch_authorized: boolean;
  publishable: boolean;
};

type Props = {
  snapshot: EditorialReviewSnapshot;
  onCommand: (command: EditorialHumanCommand) => Promise<EditorialQueueReceipt>;
  onRefresh: () => Promise<void>;
};

export function EditorialReviewPanel({ snapshot, onCommand, onRefresh }: Props) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [blockedAtSeq, setBlockedAtSeq] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const seq = snapshot.review?.last_confirmed_state?.seq;
  const validContent =
    typeof snapshot.content?.title === 'string' &&
    snapshot.content.title.trim().length > 0 &&
    Array.isArray(snapshot.content.parts) &&
    snapshot.content.parts.length === 3 &&
    snapshot.content.parts.every((part) => typeof part === 'string' && part.trim().length > 0);
  const validSeq = typeof seq === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(seq);
  const idle = snapshot.review?.status === 'idle';
  const canDecide = validContent && validSeq && snapshot.review_acknowledged === true &&
    snapshot.publishable === false && snapshot.dispatch_authorized === false &&
    idle && !busy && blockedAtSeq === null;
  const imageManual = snapshot.review?.last_confirmed_state?.image_mode === 'manual';

  // Only a new, confirmed server revision can unlock commands. A refresh at
  // the same revision must NOT retry an uncertain or already-queued decision.
  useEffect(() => {
    if (!busy && blockedAtSeq !== null && validSeq && seq !== blockedAtSeq &&
        idle && snapshot.review_acknowledged === true) {
      setBlockedAtSeq(null);
      setConfirmReject(false);
      setFeedback('');
      setNotice(null);
    }
  }, [blockedAtSeq, busy, validSeq, seq, idle, snapshot.review_acknowledged]);

  async function queue(action: EditorialHumanAction) {
    if (!canDecide || (action === 'request_image' && !imageManual) ||
        (action === 'request_text_changes' && !feedback.trim()) ||
        (action === 'reject' && !confirmReject) || !seq) {
      return;
    }
    // Freeze locally before any HTTP interaction. No automatic retries after
    // success, timeout, HTTP 503, conflict or an invalid response.
    setBlockedAtSeq(seq);
    setBusy(true);
    setConfirmReject(false);
    try {
      const result = await onCommand({
        command_id: crypto.randomUUID(),
        expected_seq: seq,
        action,
        feedback: action === 'request_text_changes' ? feedback.trim() : '',
      });
      if (result.status === 'queued/unconfirmed' &&
          result.dispatch_authorized === false && result.publishable === false) {
        setNotice('Решение поставлено в очередь. Это не подтверждение выполнения, доработки или публикации.');
      } else {
        setNotice('Результат решения не подтверждён. Не повторяй отправку; проверь статус.');
      }
    } catch {
      setNotice('Результат отправки неизвестен. Повтор запрещён; используй только проверку статуса.');
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (refreshing || busy) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      setNotice('Не удалось получить текущий статус. Решения остаются заблокированы.');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section aria-label="Редакторская проверка" className="space-y-4">
      <header className="space-y-2">
        <h2 className="text-xl font-semibold">Редакторская проверка</h2>
        <p>Статус Postmill: {snapshot.review?.status ?? 'неизвестен'}; последняя подтверждённая версия: {seq ?? 'нет'}.</p>
        <p>Черновик защищён от публикации. Решение редактора, доставка решения и публикация — разные операции.</p>
      </header>

      {validContent ? (
        <article className="space-y-4">
          <h3 className="text-lg font-semibold">{snapshot.content.title}</h3>
          {snapshot.content.parts.map((part, index) => (
            <div key={index} className="space-y-3">
              {index > 0 && <hr aria-hidden="true" />}
              <p className="whitespace-pre-wrap">{part}</p>
            </div>
          ))}
        </article>
      ) : (
        <p role="alert">Неполный или неподтверждённый текст. Решения недоступны.</p>
      )}

      <div className="space-y-3">
        <label htmlFor="editorial-review-feedback" className="block">
          Замечания к тексту
        </label>
        <textarea
          id="editorial-review-feedback"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          maxLength={4000}
          disabled={!canDecide}
          className="w-full border rounded p-2"
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!canDecide} onClick={() => void queue('approve_text')}>
            Утвердить текст
          </button>
          <button type="button" disabled={!canDecide || !feedback.trim()}
            onClick={() => void queue('request_text_changes')}>
            Отправить на доработку
          </button>
          {imageManual && (
            <button type="button" disabled={!canDecide} onClick={() => void queue('request_image')}>
              Запросить изображение
            </button>
          )}
          <button type="button" disabled={!canDecide} onClick={() => setConfirmReject(true)}>
            Отклонить материал
          </button>
        </div>
        {confirmReject && canDecide && (
          <div role="group" aria-label="Подтверждение отклонения" className="flex gap-2">
            <button type="button" onClick={() => void queue('reject')}>
              Подтвердить отклонение
            </button>
            <button type="button" onClick={() => setConfirmReject(false)}>Отмена</button>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {!canDecide && !notice && <p role="status">Новые решения сейчас недоступны.</p>}
        <button type="button" disabled={refreshing || busy} onClick={() => void refresh()}>
          {refreshing ? 'Проверка…' : 'Проверить статус (только чтение)'}
        </button>
      </div>
    </section>
  );
}
