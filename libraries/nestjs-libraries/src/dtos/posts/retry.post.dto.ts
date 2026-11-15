import { IsInt, IsOptional, IsString, Min } from 'class-validator';
export class RetryPostDto {
  @IsOptional() @IsString() occurrenceId?: string;
  @IsOptional() @IsInt() @Min(0) expectedAttempt?: number;
  @IsOptional() @IsString() confirmation?: string;
}
