'use client';

import { useEffect, useState } from 'react';
import { Button } from '@postmill-ai/react/form/button';

// Presentation only: this component has no network client or production route.
// A future session-authenticated caller must supply server-verified snapshots
// and a cookie/CSRF-protected command callback.
export type EditorialReviewSnapshot = {
  post_id: string;
  task_id: string;
  content: { title: string; parts: string[] };
  review_acknowledged: boolean;
  mock_image?: {status:'waiting'|'recorded'|'uncertain'|'unavailable'; can_import:boolean;
    asset: {file_id:string; revision:number; sha256:string; compatible:boolean; png_base64:string} | null};
  review: {
    status: string;
    last_confirmed_state?: {
      seq: string;
      text?: { revision: number; sha256: string };
      image_mode?: string;
      image?: {revision:number;sha256:string}|null;
      image_compatible?: boolean;
      image_intent?: string|null;
      text_status?: string;
      final_approved?: boolean;
      rejected?: boolean;
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
  | 'request_image'
  | 'request_image_changes'
  | 'confirm_image_reuse'
  | 'approve_final';

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
  onImportImage?: (seq: string) => Promise<{status:string}>;
  mutationsBlocked?: boolean;
};

export function EditorialReviewPanel({ snapshot, onCommand, onRefresh, onImportImage, mutationsBlocked = false }: Props) {
  const [feedback, setFeedback] = useState('');
  const [imageFeedback,setImageFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [blockedAtSeq, setBlockedAtSeq] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing,setImporting] = useState(false);
  const [importBlocked,setImportBlocked] = useState<string|null>(null);

  const seq = snapshot.review?.last_confirmed_state?.seq;
  const validContent =
    typeof snapshot.content?.title === 'string' &&
    snapshot.content.title.trim().length > 0 &&
    Array.isArray(snapshot.content.parts) &&
    snapshot.content.parts.length === 3 &&
    snapshot.content.parts.every((part) => typeof part === 'string' && part.trim().length > 0);
  const validSeq = typeof seq === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(seq);
  const idle = snapshot.review?.status === 'idle';
  const state = snapshot.review?.last_confirmed_state;
  const waitingRevision = state?.text_status === 'changes_requested';
  const canDecide = validContent && validSeq && snapshot.review_acknowledged === true &&
    snapshot.publishable === false && snapshot.dispatch_authorized === false &&
    idle && !waitingRevision && state?.rejected !== true && state?.final_approved !== true &&
    !busy && !importing && importBlocked !== seq && blockedAtSeq === null && !mutationsBlocked &&
    snapshot.mock_image?.status !== 'uncertain' && snapshot.mock_image?.status !== 'unavailable';
  const imageAllowed = state?.image_mode === 'manual' || state?.image_mode === 'automatic' ||
    (state?.image_mode === 'after_text_approval' && state.text_status === 'approved');
  const canRequestImage = imageAllowed && state?.image_intent == null && state?.image_compatible !== true &&
    (state?.image_mode === 'manual' || !!snapshot.mock_image);
  const canReviewImage = imageAllowed && state?.image_intent === null && !!state.image &&
    snapshot.mock_image?.status === 'recorded' && !!snapshot.mock_image.asset;
  const canReuse = canReviewImage && state?.image_compatible === false;
  const canFinal = canReviewImage && state?.image_compatible === true && state.text_status === 'approved';
  const canApproveText = state?.text_status === undefined || state.text_status === 'pending';

  // Only a new, confirmed server revision can unlock commands. A refresh at
  // the same revision must NOT retry an uncertain or already-queued decision.
  useEffect(() => {
    if (!busy && blockedAtSeq !== null && validSeq && seq !== blockedAtSeq &&
        idle && snapshot.review_acknowledged === true) {
      setBlockedAtSeq(null);
      setConfirmReject(false);
      setFeedback('');
      setImageFeedback('');
      setNotice(null);
    }
  }, [blockedAtSeq, busy, validSeq, seq, idle, snapshot.review_acknowledged]);

  async function queue(action: EditorialHumanAction) {
    if (!canDecide || (action === 'request_image' && !canRequestImage) ||
        (action === 'approve_text' && !canApproveText) ||
        (action === 'request_image_changes' && (!canReviewImage || !imageFeedback.trim())) ||
        (action === 'confirm_image_reuse' && !canReuse) || (action === 'approve_final' && !canFinal) ||
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
        feedback: action === 'request_text_changes' ? feedback.trim() :
          action === 'request_image_changes' ? imageFeedback.trim() : '',
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

  async function importImage() {
    if (!canDecide || !seq || !onImportImage || !snapshot.mock_image?.can_import || importing) return;
    setImportBlocked(seq); setImporting(true);
    try {
      const result = await onImportImage(seq);
      if (result.status === 'not_ready') {
        setImportBlocked(null);
        setNotice('Изображение пока не готово. Импорт не начинался.');
      } else if (result.status === 'recorded') {
        setNotice('Импорт подтверждён. Обнови состояние черновика.');
      } else setNotice('Импорт не подтверждён. Повторная запись запрещена.');
    } catch { setNotice('Результат импорта неизвестен. Проверь статус без повторной записи.'); }
    finally { setImporting(false); }
  }

  async function refresh() {
    if (refreshing || busy || importing) return;
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
        <p>Статус Postmill: {snapshot.review?.status ?? 'неизвестен'}; последовательность решений: {seq ?? 'нет'}; редакция текста: {state?.text?.revision ?? 'нет'}.</p>
        {waitingRevision && <p role="status">Текст возвращён на доработку. Новая редакция ожидает подтверждения.</p>}
        {state?.rejected === true && <p role="status">Материал окончательно отклонён.</p>}
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

      {snapshot.mock_image && (
        <section aria-label="Иллюстрация редакции" className="space-y-2">
          <h3 className="font-semibold">Иллюстрация (тестовый режим)</h3>
          {snapshot.mock_image.asset && (
            <>
              {/* Only the fixed, verified mock PNG is accepted by the session client. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt="Тестовая иллюстрация" className="w-32 h-32 object-contain"
                src={'data:image/png;base64,'+snapshot.mock_image.asset.png_base64} />
              <p>Редакция {snapshot.mock_image.asset.revision}; {snapshot.mock_image.asset.compatible ?
                'соответствует тексту' : 'требуется подтверждение соответствия'}.</p>
              <p className="break-all text-sm">SHA-256: {snapshot.mock_image.asset.sha256}</p>
            </>
          )}
          {snapshot.mock_image.status === 'uncertain' && <p role="status">Запись не подтверждена. Повтор запрещён.</p>}
          {snapshot.mock_image.status === 'unavailable' && <p role="alert">Не удалось проверить файл.</p>}
          {canReviewImage && (<>
            <label htmlFor="editorial-image-feedback">Замечания к изображению</label>
            <textarea id="editorial-image-feedback" value={imageFeedback} maxLength={4000}
              disabled={!canDecide} onChange={e => setImageFeedback(e.target.value)} />
            <Button secondary type="button" disabled={!canDecide || !imageFeedback.trim()}
              onClick={() => void queue('request_image_changes')}>Переделать изображение</Button>
            {canReuse && <Button secondary type="button" disabled={!canDecide}
              onClick={() => void queue('confirm_image_reuse')}>Подтвердить повторное использование</Button>}
            {canFinal && <Button type="button" disabled={!canDecide}
              onClick={() => void queue('approve_final')}>Утвердить текст и изображение</Button>}
          </>)}
          {snapshot.mock_image.can_import && onImportImage && (
            <Button secondary type="button" disabled={!canDecide || importing} onClick={() => void importImage()}>
              {importing ? 'Импорт…' : 'Получить изображение'}
            </Button>
          )}
        </section>
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
          className="w-full min-h-[96px] border border-newTableBorder rounded-[8px] bg-input text-inputText p-[12px] focus-visible:ring-2 ring-btnPrimary/40 outline-hidden disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <p className="text-[13px] text-newTableText">Для отправки на доработку укажи замечания к тексту.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!canDecide || !canApproveText} onClick={() => void queue('approve_text')}>
            Утвердить текст
          </Button>
          <Button secondary type="button" disabled={!canDecide || !feedback.trim()}
            onClick={() => void queue('request_text_changes')}>
            Отправить на доработку
          </Button>
          {canRequestImage && (
            <Button secondary type="button" disabled={!canDecide} onClick={() => void queue('request_image')}>
              Запросить изображение
            </Button>
          )}
          <Button danger className="border border-red-500/40" type="button" disabled={!canDecide} onClick={() => setConfirmReject(true)}>
            Отклонить материал
          </Button>
        </div>
        {confirmReject && canDecide && (
          <div role="group" aria-label="Подтверждение отклонения" className="flex flex-wrap gap-2">
            <Button danger className="border border-red-500/40" type="button" onClick={() => void queue('reject')}>
              Подтвердить отклонение
            </Button>
            <Button secondary type="button" onClick={() => setConfirmReject(false)}>Отмена</Button>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {!canDecide && !notice && <p role="status">Новые решения сейчас недоступны.</p>}
        <Button secondary type="button" disabled={refreshing || busy || importing} onClick={() => void refresh()}>
          {refreshing ? 'Проверка…' : 'Проверить статус (только чтение)'}
        </Button>
      </div>
    </section>
  );
}
