import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class CreateVideoDto {
  @IsOptional()
  @IsString()
  @Length(1, 150)
  title?: string;

  @IsString()
  @Length(1, 255)
  filename: string;

  @IsString()
  content_type: string;

  @IsInt()
  @Min(1)
  size_bytes: number;
}
