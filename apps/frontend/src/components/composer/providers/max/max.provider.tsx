'use client';

import {
  PostComment,
  withProvider,
} from '@postmill-ai/frontend/components/composer/providers/high.order.provider';
import { MaxSettingsDto } from '@postmill-ai/provider-kernel/domains/social-dtos/max.dto';
import {
  resolveMaxPostMode,
  STORYGO_DIVIDER,
} from '@postmill-ai/provider-kernel/domains/max-story';
import { useSettings } from '@postmill-ai/frontend/components/launches/helpers/use.values';
import { useWatch } from 'react-hook-form';
import { useEffect, useMemo, useState } from 'react';
import { useLaunchStore } from '@postmill-ai/frontend/components/composer/store';
import { useIntegration } from '@postmill-ai/frontend/components/launches/helpers/use.integration';
import { stripHtmlValidation } from '@postmill-ai/helpers/utils/strip.html.validation';

const TIPTAP_HTML = /<\/?(?:p|span|strong|br|a|h[1-6]|ul|li)(?:\s|>)/i;

const MaxSettings = () => {
  const { register, control, setValue } = useSettings();
  const configuredMode = useWatch({ control, name: 'mode' }) || 'auto';
  const legacyImageId = useWatch({ control, name: 'storyImageId' });
  const continuation = useWatch({ control, name: 'continuationText' });
  const [showOverride, setShowOverride] = useState(false);
  const current = useLaunchStore((state) => state.current);
  const setTotalChars = useLaunchStore((state) => state.setTotalChars);
  const setChars = useLaunchStore((state) => state.setChars);
  const { integration, value } = useIntegration();
  const editorText = value?.[0]?.content || '';
  const attachedCount = value?.[0]?.image?.length || 0;

  const plain = useMemo(
    () => TIPTAP_HTML.test(editorText)
      ? stripHtmlValidation('normal', editorText.replace(/<br\s*\/?>/gi, '\n'), false, true)
      : editorText,
    [editorText],
  );
  // Never infer StoryGo based on message length, presence of an image, or AI.
  // Only the exact divider (or legacy continuation) selects the StoryGo path.
  const mode = resolveMaxPostMode(configuredMode, plain, continuation || '');

  useEffect(() => {
    if (!integration || current !== integration.id) return;
    const budget = mode === 'story' ? 4_000_000 : 4000;
    setTotalChars?.(budget);
    setChars(integration.id, budget);
  }, [current, integration?.id, mode, setTotalChars, setChars]);

  const partLengths = useMemo(() => {
    if (mode !== 'story') return [];
    const groups: string[][] = [[]];
    for (const line of plain.split('\n')) {
      if (line === STORYGO_DIVIDER) groups.push([]);
      else groups[groups.length - 1].push(line);
    }
    return groups.map((lines) => lines.join('\n').length);
  }, [plain, mode]);

  return (
    <div className="flex flex-col gap-[12px] pb-[14px]">
      <select
        id="max-post-mode"
        aria-label="Тип публикации MAX"
        {...register('mode')}
        defaultValue="auto"
        className={showOverride
          ? 'w-full rounded border border-borderPreview bg-newBgColorInner p-[8px]'
          : 'sr-only'}
      >
        <option value="auto">Определять автоматически</option>
        <option value="normal">Обычный пост</option>
        <option value="story">История с продолжениями</option>
      </select>
      <div className="flex items-center justify-between gap-[10px]">
        <span className="text-[13px]">
          {configuredMode === 'auto' ? 'Определено: ' : 'Выбрано: '}
          <strong>{mode === 'story' ? 'история с продолжениями' : 'обычный пост'}</strong>
        </span>
        <button
          type="button"
          className="rounded border border-borderPreview px-[10px] py-[6px] text-[12px]"
          onClick={() => setShowOverride((shown) => !shown)}
        >
          {showOverride ? 'Скрыть выбор' : 'Изменить'}
        </button>
      </div>
      <p className="text-[12px]">
        Добавляй фото или видео в обычном редакторе. Postmill сам выберет
        публикацию напрямую в MAX либо через StoryGo.
      </p>
      {mode === 'story' ? (
        <>
          <input type="hidden" {...register('continuationText')} />
          <input type="hidden" {...register('storyImageId')} />
          <p className="text-[12px]">
            Части истории разделяются точной строкой {STORYGO_DIVIDER}
            на отдельной строке. Для истории допускается одно PNG/JPEG
            до 8 МиБ; видео в StoryGo пока не поддерживается.
          </p>
          <div className="text-[12px]">
            {partLengths.slice(0, 15).map((length, index) => (
              <p key={index} className={length > 4000 ? 'text-dangerText' : 'text-newTableText'}>
                Часть {index + 1}: {length} / 4000
              </p>
            ))}
            {partLengths.length > 15 && <p>Всего частей: {partLengths.length}</p>}
          </div>
        </>
      ) : (
        <p className="text-[12px]">
          Обычный пост: текст до 4000 символов, не более одного фото
          (PNG/JPEG до 16 МиБ) либо видео (MP4/WebM до 32 МиБ).
        </p>
      )}
      {!!attachedCount && (
        <p className="text-[12px]">
          Вложений в редакторе: {attachedCount}.
          {mode === 'story' ? ' Для истории допускается только одно фото.' : ''}
        </p>
      )}
      {!!legacyImageId && (
        <div className="flex items-center gap-[8px] text-[12px]">
          <span>Сохранено фото истории из предыдущей версии редактора.</span>
          <button
            type="button"
            className="rounded border border-borderPreview px-[8px] py-[5px]"
            onClick={() => setValue('storyImageId', '', { shouldDirty: true, shouldValidate: true })}
          >
            Убрать
          </button>
        </div>
      )}
      {mode === 'story' && (
        <p className="text-[12px]">
          Каждая часть — не более 4000 единиц UTF-16, заголовок — до 160.
          Продолжения сохраняются в StoryGo.
        </p>
      )}
    </div>
  );
};

export default withProvider({
  comments: false,
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: MaxSettings,
  dto: MaxSettingsDto,
  maximumCharacters: 4000,
});
