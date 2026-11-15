import { Allow, IsIn, IsOptional, IsString } from 'class-validator';

export class MaxSettingsDto {
  @Allow()
  __type?: string;

  @IsOptional()
  @IsIn(['normal', 'story'])
  mode?: 'normal' | 'story';

  // Exact continuation text. Individual parts are separated by the StoryGo
  // divider on its own line; never turn continuations into Postmill threads.
  @IsOptional()
  @IsString()
  continuationText?: string;
}
