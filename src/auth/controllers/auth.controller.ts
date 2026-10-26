import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthService } from '../services/auth.service.js';
import { RegisterRequestDto } from '../dto/register.request.dto.js';
import { RegisterResponseDto } from '../dto/register.response.dto.js';
import { LoginRequestDto } from '../dto/login.request.dto.js';
import { LoginResponseDto } from '../dto/login.response.dto.js';
import { RefreshRequestDto } from '../dto/refresh.request.dto.js';
import { RefreshResponseDto } from '../dto/refresh.response.dto.js';

@Controller( 'auth' )
export class AuthController {

    constructor( private readonly authService: AuthService ) {
    }

    @Post( 'register' )
    async register( @Body() dto: RegisterRequestDto, ): Promise<RegisterResponseDto> {
        return this.authService.register( dto );
    }

    @Post( 'login' )
    async login( @Body() dto: LoginRequestDto, ): Promise<LoginResponseDto> {
        return this.authService.login( dto );
    }

    @Post( 'refresh' )
    async refresh(
        @Body() dto: RefreshRequestDto,
    ): Promise<RefreshResponseDto> {
        return this.authService.refresh( dto );
    }

}
