import {
    ConflictException,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import * as argon2 from 'argon2';
import { Prisma } from '../../generated/prisma/client.js';

import { PrismaService } from '../../prisma/prisma.service.js';
import { TurnstileService } from './turnstile.service.js';
import { RegisterRequestDto } from '../dto/register.request.dto.js';
import { RegisterResponseDto } from '../dto/register.response.dto.js';
import { LoginRequestDto } from '../dto/login.request.dto.js';
import { LoginResponseDto } from '../dto/login.response.dto.js';
import { RefreshRequestDto } from '../dto/refresh.request.dto.js';
import { RefreshResponseDto } from '../dto/refresh.response.dto.js';

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly turnstileService: TurnstileService,
    ) {
    }

    async register(
        dto: RegisterRequestDto,
    ): Promise<RegisterResponseDto> {
        await this.verifyCaptcha( dto.captchaToken );

        const requestedUserId = dto.userId?.trim();

        const passwordHash = await this.hashPassword( dto.password );
        const refreshToken = this.generateRefreshToken();
        const refreshTokenHash = this.hashRefreshToken( refreshToken );

        const userId = await this.createUserWithSession( {
            userId: requestedUserId
                ? BigInt( requestedUserId )
                : undefined,
            passwordHash,
            refreshTokenHash,
        } );

        const accessToken = await this.generateAccessToken(
            userId.toString(),
        );

        return {
            accessToken,
            refreshToken,
        };
    }

    async login( dto: LoginRequestDto ): Promise<LoginResponseDto> {
        await this.verifyCaptcha( dto.captchaToken );

        const user = await this.findUserForLogin( BigInt( dto.userId ) );

        await this.verifyPassword( dto.password, user.passwordHash );

        const refreshToken = this.generateRefreshToken();
        const refreshTokenHash = this.hashRefreshToken( refreshToken );
        const accessToken = await this.generateAccessToken(
            user.userId.toString(),
        );

        await this.replaceUserSession( user.id, refreshTokenHash );

        return {
            accessToken,
            refreshToken,
        };
    }

    async refresh(
        dto: RefreshRequestDto,
    ): Promise<RefreshResponseDto> {
        const oldTokenHash = this.hashRefreshToken( dto.refreshToken );

        const refreshToken = this.generateRefreshToken();
        const refreshTokenHash = this.hashRefreshToken( refreshToken );

        return this.prisma.$transaction( async ( tx ) => {
            const existingToken = await tx.refreshToken.findUnique( {
                where: { tokenHash: oldTokenHash },
            } );

            if (
                !existingToken ||
                existingToken.expiresAt.getTime() <= Date.now()
            ) {
                throw new UnauthorizedException( 'Invalid or expired refresh token' );
            }

            const rotation = await tx.refreshToken.updateMany( {
                where: {
                    id: existingToken.id,
                    tokenHash: oldTokenHash,
                    expiresAt: { gt: new Date() },
                },
                data: {
                    tokenHash: refreshTokenHash,
                    expiresAt: this.getRefreshTokenExpiry(),
                },
            } );

            if ( rotation.count !== 1 ) {
                throw new UnauthorizedException( 'Invalid or expired refresh token' );
            }

            const user = await tx.user.findUnique( {
                where: { id: existingToken.userId },
                select: { userId: true },
            } );

            if ( !user ) {
                throw new UnauthorizedException( 'Invalid or expired refresh token' );
            }

            const accessToken = await this.generateAccessToken(
                user.userId.toString(),
            );

            return {
                accessToken,
                refreshToken,
            };
        } );
    }

    private async verifyCaptcha( token: string ): Promise<void> {
        await this.turnstileService.verify( token );
    }

    private async hashPassword( password: string ): Promise<string> {
        return argon2.hash( password, {
            type: argon2.argon2id,
        } );
    }

    private async verifyPassword(
        password: string,
        passwordHash: string,
    ): Promise<void> {
        const isValid = await argon2.verify( passwordHash, password );

        if ( !isValid ) {
            throw new UnauthorizedException(
                'Invalid user ID or password',
            );
        }
    }

    private generateRefreshToken(): string {
        return randomBytes( 32 ).toString( 'base64url' );
    }

    private hashRefreshToken( token: string ): string {
        return createHash( 'sha256' ).update( token ).digest( 'hex' );
    }

    private async generateAccessToken( userId: string ): Promise<string> {
        return this.jwtService.signAsync( { userId } );
    }

    private async findUserForLogin( userId: bigint ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId },
        } );

        if ( !user ) {
            throw new UnauthorizedException(
                'Invalid user ID or password',
            );
        }

        return user;
    }

    private async replaceUserSession(
        userUuid: string,
        refreshTokenHash: string,
    ): Promise<void> {
        await this.prisma.$transaction( async ( tx ) => {
            await this.upsertRefreshToken(
                tx,
                userUuid,
                refreshTokenHash,
            );

            await this.revokePreviousDevicePushToken( tx, userUuid );
        } );
    }

    private async upsertRefreshToken(
        tx: Prisma.TransactionClient,
        userUuid: string,
        refreshTokenHash: string,
    ): Promise<void> {
        const expiresAt = this.getRefreshTokenExpiry();

        await tx.refreshToken.upsert( {
            where: { userId: userUuid },
            create: {
                userId: userUuid,
                tokenHash: refreshTokenHash,
                expiresAt,
            },
            update: {
                tokenHash: refreshTokenHash,
                expiresAt,
            },
        } );
    }

    private async revokePreviousDevicePushToken(
        tx: Prisma.TransactionClient,
        userUuid: string,
    ): Promise<void> {
        await tx.devicePushToken.deleteMany( {
            where: { userId: userUuid },
        } );
    }

    private getRefreshTokenExpiry(): Date {
        return new Date( Date.now() + REFRESH_TOKEN_TTL_MS );
    }

    private async createUserWithSession( params: {
        userId?: bigint;
        passwordHash: string;
        refreshTokenHash: string;
    } ): Promise<bigint> {
        const {
            userId: requestedUserId,
            passwordHash,
            refreshTokenHash,
        } = params;

        // Якщо ID заданий користувачем — одна спроба.
        // Якщо ні — до 10 спроб автоматичної генерації.
        const maxAttempts = requestedUserId ? 1 : 10;

        for ( let attempt = 0; attempt < maxAttempts; attempt++ ) {
            const userId =
                requestedUserId ??
                BigInt( randomInt( 1_000_000_000, 10_000_000_000 ) );

            try {
                await this.prisma.$transaction( async ( tx ) => {
                    await this.ensureUserIdAvailable( userId, tx );

                    const user = await tx.user.create( {
                        data: {
                            userId,
                            passwordHash,
                        },
                    } );

                    await tx.refreshToken.create( {
                        data: {
                            userId: user.id,
                            tokenHash: refreshTokenHash,
                            expiresAt: this.getRefreshTokenExpiry(),
                        },
                    } );
                } );

                return userId;
            } catch ( error ) {
                if ( requestedUserId ) {
                    throw error;
                }

                // Згенерований ID уже міг бути зайнятий
                // або зарезервований — спробуємо інший.
                if (
                    error instanceof ConflictException ||
                    (
                        error instanceof Prisma.PrismaClientKnownRequestError &&
                        error.code === 'P2002'
                    )
                ) {
                    continue;
                }

                throw error;
            }
        }

        throw new ConflictException(
            'Could not generate an available user ID',
        );
    }

    private async ensureUserIdAvailable(
        userId: bigint,
        tx: Prisma.TransactionClient,
    ): Promise<void> {
        const reservedId = await tx.reservedUserId.findUnique( {
            where: { userId },
        } );

        const existingUser = await tx.user.findUnique( {
            where: { userId },
        } );

        if ( reservedId || existingUser ) {
            throw new ConflictException(
                'This user ID is unavailable',
            );
        }
    }
}