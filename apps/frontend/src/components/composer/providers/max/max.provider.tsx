'use client';

import {
  PostComment,
  withProvider,
} from '@postmill-ai/frontend/components/composer/providers/high.order.provider';
import { MaxSettingsDto } from '@postmill-ai/provider-kernel/domains/social-dtos/max.dto';
import { STORYGO_DIVIDER } from '@postmill-ai/provider-kernel/domains/max-story';
import { useSettings } from '@postmill-ai/frontend/components/launches/helpers/use.values';
import { useWatch } from 'react-hook-form';
import { useMediaPicker } from '@postmill-ai/frontend/components/media-tools/use-media-picker';
import { useEffect, useMemo } from 'react';
import { useLaunchStore } from '@postmill-ai/frontend/components/composer/store';
import { stripHtmlValidation } from '@postmill-ai/helpers/utils/strip.html.validation';

const MaxSettings = () => {
  const { register, control, setValue } = useSettings();
  const mode = useWatch({ control, name: 'mode' });
  const imageId = useWatch({ control, name: 'storyImageId' });
  const continuation = useWatch({ control, name: 'continuationText' });
  const current = useLaunchStore((state) => state.current);
  const setTotalChars = useLaunchStore((state) => state.setTotalChars);
  const setChars = useLaunchStore((state) => state.setChars);
  const editorText = useLaunchStore((state) =>
    state.internal.find((i) => i.integration.id === state.current)
      ?.integrationValue?.[0]?.content || state.global[0]?.content || ''
  );

  // The composer counter applies to the entire editor. In story mode it must
  // not reject a valid multi-part document at the normal 4000-char MAX limit.
  // The backend validates the strict 4000 UTF-16 limit separately per part.
  useEffect(() => {
    if (current === 'global') return;
    const budget = mode === 'story' ? 4_000_000 : 4000;
    setTotalChars?.(budget);
    setChars(current, budget);
  }, [current, mode, setTotalChars, setChars]);

  const partLengths = useMemo(() => {
    if (mode !== 'story') return [];
    const plain = /<\\/?(?:p|span|strong|br|a|h[1-6]|ul|li)(?:\\s|>)/i.test(editorText)
      ? stripHtmlValidation('normal', editorText.replace(/<br\\s*\\/?>/gi, '\\n'), false, true)
      : editorText;
    const groups: string[][] = [[]];
    for (const line of plain.split('\n')) {
      if (line === STORYGO_DIVIDER) groups.push([]);
      else groups[groups.length - 1].push(line);
    }
    return groups.map((lines) => lines.join('\n').length);
  }, [editorText, mode]);
  const imagePicker = useMediaPicker({
    title: 'Фотография для истории',
    kinds: ['image'],
    requireFile: true,
    onSelect: (item) => {
      if (item.fileId) setValue('storyImageId', item.fileId, {
        shouldDirty: true, shouldValidate: true,
      });
    },
  });
  return (
    <div className="flex flex-col gap-[12px] pb-[14px]">
      <label htmlFor="max-post-mode" className="text-[14px]">
        Тип публикации MAX
      </label>
      <select id="max-post-mode" {...register('mode')} defaultValue="normal"
        className="w-full rounded border border-borderPreview bg-newBgColorInner p-[8px]">
        <option value="normal">Обычный пост</option>
        <option value="story">История с продолжениями</option>
      </select>
      {mode !== 'story' && (imageId || continuation?.trim()) && (
        <div className="flex flex-col gap-[8px] text-[12px]">
          <p>Для обычного MAX-поста остались сохранённые части или фото истории.
            Верни режим «История» либо явно очисти эти данные.</p>
          <button type="button" className="rounded border border-borderPreview p-[8px]"
            onClick={() => {
              setValue('continuationText', '', { shouldDirty: true, shouldValidate: true });
              setValue('storyImageId', '', { shouldDirty: true, shouldValidate: true });
            }}>
            Очистить продолжения и фото
          </button>
        </div>
      )}
      {mode === 'story' && (
        <>
          <input type="hidden" {...register('continuationText')} />
          <p className="text-[12px]">
            Вставь всю историю в основной редактор: заголовок первой строкой,
            затем текст. Части разделяй точной строкой {STORYGO_DIVIDER}
            на отдельной строке. Отдельное поле продолжений больше не нужно.
          </p>
          <div className="text-[12px]">
            {partLengths.slice(0, 15).map((length, index) => (
              <p key={index} className={length > 4000 ? 'text-dangerText' : 'text-newTableText'}>
                Часть {index + 1}: {length} / 4000
              </p>
            ))}
            {partLengths.length > 15 && <p>Всего частей: {partLengths.length}</p>}
          </div>
          <input type="hidden" {...register('storyImageId')} />
          <div className="flex items-center gap-[10px]">
            <button type="button" onClick={imagePicker.open}
              className="rounded border border-borderPreview p-[8px]">
              {imageId ? 'Заменить фотографию' : 'Выбрать фотографию'}
            </button>
            {imageId && (
              <button type="button"
                onClick={() => setValue('storyImageId', '', { shouldDirty: true, shouldValidate: true })}
                className="rounded border border-borderPreview p-[8px]">
                Убрать
              </button>
            )}
          </div>
          {imageId && <p className="text-[12px]">Фото выбрано. Допускается один PNG/JPEG до 8 МиБ.</p>}
          {imagePicker.element}
          <p className="text-[12px]">
            На сервере части сохраняются раздельно и передаются в StoryGo.
            Каждая часть — не более 4000 единиц UTF-16, заголовок — до 160.
          </p>
        </>
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
