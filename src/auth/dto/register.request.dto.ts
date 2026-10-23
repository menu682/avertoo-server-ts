import { IsString, Matches, MinLength, MaxLength } from 'class-validator';

export class RegisterRequestDto {
  @IsString()
  @Matches(/^[1-9]\d{9}$/, {
    message: 'userId must be a 10-digit number',
  })
  userId!: string;

  @IsString()
  @MinLength(8, {
    message: 'Password must be at least 8 characters long',
  })
  @MaxLength(128, {
    message: 'Password must not exceed 128 characters',
  })
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  captchaToken!: string;
}
