import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { JwtPayload } from '../auth.types';

export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload | null => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user?: JwtPayload | null }>();
    return request.user ?? null;
  },
);
