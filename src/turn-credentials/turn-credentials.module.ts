import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TurnCredentialsController } from './turn-credentials.controller.js';
import { TurnCredentialsService } from './turn-credentials.service.js';

@Module({ imports: [AuthModule], controllers: [TurnCredentialsController], providers: [TurnCredentialsService] })
export class TurnCredentialsModule {}
