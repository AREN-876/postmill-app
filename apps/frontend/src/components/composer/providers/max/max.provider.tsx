'use client';

import {
  PostComment,
  withProvider,
} from '@postmill-ai/frontend/components/composer/providers/high.order.provider';
import { MaxSettingsDto } from '@postmill-ai/provider-kernel/domains/social-dtos';
import { STORYGO_DIVIDER } from '@postmill-ai/provider-kernel/domains/max-story';
import { useSettings } from '@postmill-ai/frontend/components/launches/helpers/use.values';
import { useWatch } from 'react-hook-form';

const MaxSettings = () => {
  const { register, control } = useSettings();
  const mode = useWatch({ control, name: 'mode' });
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
            placeholder={'Часть 2...\\n' + STORYGO_DIVIDER + '\\nЧасть 3...'}
            className="w-full rounded border border-borderPreview bg-newBgColorInner p-[8px]"
          />
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
