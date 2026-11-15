'use client';

import {
  PostComment,
  withProvider,
} from '@postmill-ai/frontend/components/composer/providers/high.order.provider';
import { MaxSettingsDto } from '@postmill-ai/provider-kernel/domains/social-dtos';
import { STORYGO_DIVIDER } from '@postmill-ai/provider-kernel/domains/max-story';
import { useSettings } from '@postmill-ai/frontend/components/launches/helpers/use.values';
import { useWatch } from 'react-hook-form';
import { useMediaPicker } from '@postmill-ai/frontend/components/media-tools/use-media-picker';

const MaxSettings = () => {
  const { register, control, setValue } = useSettings();
  const mode = useWatch({ control, name: 'mode' });
  const imageId = useWatch({ control, name: 'storyImageId' });
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
      {mode === 'story' && (
        <>
          <label htmlFor="max-story-continuations" className="text-[14px]">
            Продолжения истории (части 2 и далее)
          </label>
          <textarea id="max-story-continuations" rows={10}
            {...register('continuationText')}
            placeholder={'Часть 2...\n' + STORYGO_DIVIDER + '\nЧасть 3...'}
            className="w-full rounded border border-borderPreview bg-newBgColorInner p-[8px]"
          />
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
            Первую часть пиши в обычном редакторе (до 4000 символов).
            Остальные части разделяй точной строкой {STORYGO_DIVIDER}.
            Текст и порядок частей сохраняются без автоматического деления.
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
