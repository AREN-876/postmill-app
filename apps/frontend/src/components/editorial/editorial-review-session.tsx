'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@postmill-ai/react/form/button';
import { useFetch } from '@postmill-ai/helpers/utils/custom.fetch';
import { editorialReviewClient } from './editorial-review-client';
import { EditorialReleaseControls } from './editorial-release-controls';
import {
  EditorialReviewPanel,
  type EditorialReviewSnapshot,
  type EditorialHumanCommand,
} from './editorial-review-panel';

// Deliberately NOT mounted in any Postmill route or composer.
// Enablement is only a UI integration switch, NOT a security boundary.
// Production server-side org/target config and routes remain disabled.
export function EditorialReviewSession({
  postId, taskId, enabled,
}: {
  postId: string;
  taskId: string;
  enabled: boolean;
}) {
  const fetcher = useFetch();
  const client = useMemo(() => editorialReviewClient(fetcher), [fetcher]);
  const identity = postId + ':' + taskId;
  const [loaded, setLoaded] = useState<{
    identity: string;
    snapshot: EditorialReviewSnapshot;
  } | null>(null);
  const [error, setError] = useState(false);
  const [reading, setReading] = useState(false);
  const requestId = useRef(0);
  // A lost POST response must not be converted into a fresh POST by reloading
  // the same panel after a read failure. Keep the lock in the session owner.
  const attemptedRef = useRef<{ identity: string; seq: string } | null>(null);
  const [attempted, setAttempted] = useState<{ identity: string; seq: string } | null>(null);
  const [releaseAttempted, setReleaseAttempted] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!enabled) throw new Error('editorial_review_disabled');
    const current = ++requestId.current;
    setReading(true);
    setError(false);
    try {
      const snapshot = await client.read(postId, taskId);
      if (current === requestId.current) {
        const seq = snapshot.review?.last_confirmed_state?.seq;
        if (snapshot.review?.status === 'idle' &&
            attemptedRef.current?.identity === identity &&
            seq !== attemptedRef.current.seq && typeof seq === 'string') {
          attemptedRef.current = null;
          setAttempted(null);
        }
        setLoaded({ identity, snapshot });
      }
    } catch {
      if (current === requestId.current) {
        // Do not keep exposing a potentially stale artifact after failed read.
        setLoaded(null);
        setError(true);
      }
      throw new Error('editorial_review_read_unavailable');
    } finally {
      if (current === requestId.current) setReading(false);
    }
  }, [client, enabled, identity, postId, taskId]);

  useEffect(() => {
    if (enabled) void refresh().catch(() => undefined);
    return () => {
      requestId.current++;
    };
  }, [enabled, refresh]);

  const queue = useCallback(async (command: EditorialHumanCommand) => {
    if (!enabled || (attemptedRef.current?.identity === identity &&
        attemptedRef.current.seq === command.expected_seq)) {
      throw new Error('editorial_decision_outcome_unknown');
    }
    // The guard persists even if a pending read temporarily unmounts the panel.
    // It clears only after a different, authoritative confirmed sequence.
    const lock = { identity, seq: command.expected_seq };
    attemptedRef.current = lock;
    setAttempted(lock);
    return client.queue(postId, taskId, command);
  }, [client, enabled, identity, postId, taskId]);

  const importImage = useCallback(async (seq: string) => {
    if (!enabled || (attemptedRef.current?.identity === identity && attemptedRef.current.seq === seq)) {
      throw new Error('editorial_image_outcome_unknown');
    }
    const lock = {identity,seq};
    attemptedRef.current = lock;
    setAttempted(lock);
    const result = await client.importImage(postId,taskId,seq);
    if (result.status === 'not_ready' && attemptedRef.current === lock) {
      attemptedRef.current = null;
      setAttempted(null);
    }
    return result;
  }, [client,enabled,identity,postId,taskId]);

  if (!enabled) return <p>Редакторский обмен отключён.</p>;
  if (error) {
    return (
      <section aria-label="Редакторская проверка">
        <p role="alert">Не удалось подтвердить актуальное состояние черновика. Решения недоступны.</p>
        <Button secondary type="button" disabled={reading} onClick={() => void refresh().catch(() => undefined)}>
          Проверить статус (только чтение)
        </Button>
      </section>
    );
  }
  if (!loaded || loaded.identity !== identity) {
    return <p role="status">Загрузка редакторского черновика…</p>;
  }
  return (
    <>
      <EditorialReviewPanel
        snapshot={loaded.snapshot}
        onCommand={queue}
        onRefresh={refresh}
        onImportImage={importImage}
        mutationsBlocked={attempted?.identity === identity &&
          attempted.seq === loaded.snapshot.review?.last_confirmed_state?.seq}
      />
      <EditorialReleaseControls
        postId={postId}
        taskId={taskId}
        snapshot={loaded.snapshot}
        fetcher={fetcher}
        mutationsBlocked={releaseAttempted === identity}
        onReleaseAttempt={() => setReleaseAttempted(identity)}
      />
    </>
  );
}
