import { Allow, IsIn, IsOptional, IsString, Matches } from 'class-validator';

export class MaxSettingsDto {
  @Allow()
  __type?: string;

  @IsOptional()
  @IsIn(['auto', 'normal', 'story'])
  mode?: 'auto' | 'normal' | 'story';

  // Exact continuation text. Individual parts are separated by the StoryGo
  // divider on its own line; never turn continuations into Postmill threads.
  @IsOptional()
  @IsString()
  continuationText?: string;

  // A selected org-owned File row, not a public URL. The server verifies its
  // content and persists the digest at scheduling time, then rechecks it.
  @IsOptional()
  @IsString()
  storyImageId?: string;

  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  storyImageSha256?: string;

  // Server-owned digest of the one normal MAX photo/video attachment.
  // Recomputed at save and verified before any outbound MAX request.
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  maxMediaSha256?: string;
}
