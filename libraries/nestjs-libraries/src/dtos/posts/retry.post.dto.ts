import { IsInt, IsOptional, IsString, Min } from 'class-validator';
export class RetryPostDto {
  @IsOptional() @IsInt() @Min(0) expectedAttempt?: number;
  @IsOptional() @IsString() confirmation?: string;
}
